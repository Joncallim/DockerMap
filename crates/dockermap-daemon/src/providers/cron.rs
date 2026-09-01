//! Read-only cron schedule discovery.
//!
//! The provider reads only the fixed system crontab locations and invokes the
//! fixed `crontab -l` command. It never evaluates schedules or executes the
//! discovered commands.

use crate::process_runner::{run_command_with_timeout, PROVIDER_COMMAND_TIMEOUT};
use crate::{push_provider_diagnostic, redact_sensitive_text, safe_runtime_id_component};
use dockermap_core::{
    DiagnosticSeverity, RuntimeMapDiagnostic, RuntimeMapNode, RuntimeNodeKind, RuntimeNodeLayer,
    RuntimeProviderKind,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    process::Command,
};

const MAX_CRON_D_ENTRIES: usize = 64;
const MAX_CRON_FILE_BYTES: u64 = 64 * 1024;

pub(crate) fn collect_scheduled_jobs(
    nodes: &mut Vec<RuntimeMapNode>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    let mut job_sources = Vec::new();
    read_cron_file(Path::new("/etc/crontab"), &mut job_sources, diagnostics);
    collect_cron_d_files(Path::new("/etc/cron.d"), &mut job_sources, diagnostics);

    match run_command_with_timeout(
        {
            let mut command = Command::new("crontab");
            command.arg("-l");
            command
        },
        PROVIDER_COMMAND_TIMEOUT,
    ) {
        Ok(output) if output.status.success() => {
            for (index, line) in String::from_utf8_lossy(&output.stdout).lines().enumerate() {
                if let Some(command) = cron_command(line, true) {
                    job_sources.push(("user crontab".into(), index + 1, command));
                }
            }
        }
        Ok(_) => {}
        Err(error) => push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::ScheduledJob,
            DiagnosticSeverity::Info,
            format!("user crontab discovery skipped: {error}"),
        ),
    }

    for (source, line, command) in job_sources {
        let safe_command = redact_sensitive_text(&command);
        let mut metadata = BTreeMap::new();
        metadata.insert("source".into(), source.clone());
        metadata.insert("line".into(), line.to_string());
        metadata.insert("command".into(), safe_command.clone());
        nodes.push(RuntimeMapNode {
            id: format!(
                "scheduled_job_{}_{}",
                safe_runtime_id_component(&source, "source"),
                safe_runtime_id_component(&format!("{line}_{safe_command}"), "command")
            ),
            provider: RuntimeProviderKind::ScheduledJob,
            kind: RuntimeNodeKind::ScheduledJob,
            label: safe_command,
            status: Some("scheduled".into()),
            layer: Some(RuntimeNodeLayer::Process),
            metadata,
            service: None,
            package: None,
        });
    }
}

fn collect_cron_d_files(
    directory: &Path,
    jobs: &mut Vec<(String, usize, String)>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(_) => {
            push_provider_diagnostic(
                diagnostics,
                RuntimeProviderKind::ScheduledJob,
                DiagnosticSeverity::Info,
                "cron.d discovery skipped because its fixed directory is unavailable".into(),
            );
            return;
        }
    };

    let paths = bounded_cron_d_paths(entries);
    if paths.was_capped {
        push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::ScheduledJob,
            DiagnosticSeverity::Info,
            format!("cron.d discovery capped at {MAX_CRON_D_ENTRIES} entries"),
        );
    }
    for path in paths.paths {
        read_cron_file(&path, jobs, diagnostics);
    }
}

struct BoundedCronDPaths {
    paths: Vec<PathBuf>,
    was_capped: bool,
}

/// Stop reading after a fixed number of directory entries so a hostile cron.d
/// cannot consume unbounded syscall/CPU work. The retained entries are then
/// sorted, keeping the published subset stable for one observed directory
/// ordering without materializing the rest of the directory.
fn bounded_cron_d_paths(entries: fs::ReadDir) -> BoundedCronDPaths {
    let mut selected = BTreeSet::new();
    let mut was_capped = false;
    for (index, entry) in entries.enumerate() {
        if index == MAX_CRON_D_ENTRIES {
            was_capped = true;
            break;
        }
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        // `metadata` follows links, so reject a symlink before it can be
        // considered an in-root cron source. Open below also has O_NOFOLLOW
        // for the replacement race between this check and file open.
        if fs::symlink_metadata(&path)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(true)
        {
            continue;
        }
        selected.insert(path);
    }
    BoundedCronDPaths {
        paths: selected.into_iter().collect(),
        was_capped,
    }
}

fn cron_file_size_is_allowed(size: u64) -> bool {
    size <= MAX_CRON_FILE_BYTES
}

fn read_cron_file(
    path: &Path,
    jobs: &mut Vec<(String, usize, String)>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    if fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(true)
    {
        return;
    }

    // O_NOFOLLOW rejects a link swapped in after symlink_metadata. Inspecting
    // the opened handle's metadata closes the metadata-to-open size race.
    let Ok(file) = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
    else {
        return;
    };
    let Ok(metadata) = file.metadata() else {
        return;
    };
    if !metadata.is_file() {
        return;
    }
    if !cron_file_size_is_allowed(metadata.len()) {
        push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::ScheduledJob,
            DiagnosticSeverity::Info,
            format!("cron file skipped because it exceeds {MAX_CRON_FILE_BYTES} bytes"),
        );
        return;
    }
    let mut content = String::new();
    let mut reader = file.take(MAX_CRON_FILE_BYTES.saturating_add(1));
    let Ok(_) = reader.read_to_string(&mut content) else {
        return;
    };
    if content.len() > MAX_CRON_FILE_BYTES as usize {
        push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::ScheduledJob,
            DiagnosticSeverity::Info,
            format!("cron file skipped because it exceeds {MAX_CRON_FILE_BYTES} bytes"),
        );
        return;
    }
    for (index, line) in content.lines().enumerate() {
        if let Some(command) = cron_command(line, false) {
            jobs.push((path.display().to_string(), index + 1, command));
        }
    }
}

fn cron_command(line: &str, user_crontab: bool) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    if trimmed.starts_with('@') {
        // System crontabs (@reboot in /etc/crontab and cron.d) carry a user
        // column after the schedule; user crontabs do not. Skip the schedule
        // (and user) token(s) but preserve the command's original whitespace —
        // reconstructing with join(" ") would collapse repeated spaces inside
        // quoted arguments.
        let fields = trimmed.split_whitespace().collect::<Vec<_>>();
        let command_start = if user_crontab { 1 } else { 2 };
        if fields.len() <= command_start {
            return None;
        }
        // Walk the original line to find the command token's byte offset
        // (sequential find cannot match an earlier token again), then take
        // the remainder verbatim.
        let mut offset = 0usize;
        for token in &fields[..command_start] {
            offset = trimmed[offset..]
                .find(token)
                .map(|index| offset + index + token.len())?;
        }
        let command = trimmed[offset..].trim();
        if command.is_empty() {
            return None;
        }
        return Some(command.to_string());
    }

    let fields = trimmed.split_whitespace().collect::<Vec<_>>();
    let command_start = if user_crontab { 5 } else { 6 };
    if fields.len() <= command_start {
        return None;
    }
    Some(fields[command_start..].join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use tempfile::tempdir;

    #[test]
    fn parses_cron_fixtures_for_system_user_and_cron_d() {
        let system = include_str!("../../../../tests/fixtures/providers/parser/crontab-system.txt");
        let system_commands = system
            .lines()
            .filter_map(|line| cron_command(line, false))
            .collect::<Vec<_>>();
        assert_eq!(
            system_commands,
            vec![
                "cd / && run-parts --report /etc/cron.hourly",
                "test -x /usr/sbin/anacron || ( cd / && run-parts --report /etc/cron.daily )",
                "test -x /usr/sbin/anacron || ( cd / && run-parts --report /etc/cron.weekly )",
                "test -x /usr/sbin/anacron || ( cd / && run-parts --report /etc/cron.monthly )",
                "/srv/scripts/bootstrap.sh --env production",
                "/usr/bin/env APP_MODE=\"prod  sealed\" /srv/scripts/daemon.sh",
            ]
        );
        // Macro commands preserve the original command substring, including
        // repeated whitespace inside quoted arguments.
        assert_eq!(
            system_commands[5],
            "/usr/bin/env APP_MODE=\"prod  sealed\" /srv/scripts/daemon.sh"
        );
        assert!(system_commands[5].contains("prod  sealed"));

        let user = include_str!("../../../../tests/fixtures/providers/parser/crontab-user.txt");
        let user_commands = user
            .lines()
            .filter_map(|line| cron_command(line, true))
            .collect::<Vec<_>>();
        assert_eq!(
            user_commands,
            vec![
                "/usr/local/bin/healthcheck --endpoint https://example.test/health",
                "/srv/backup/run.sh --bucket backups",
                "/usr/bin/curl -fsS https://example.test/ping >/dev/null 2>&1",
                "/srv/reports/generate.sh",
                "/srv/scripts/user-bootstrap.sh",
            ]
        );

        let cron_d = include_str!("../../../../tests/fixtures/providers/parser/cron-d-file.txt");
        let cron_d_commands = cron_d
            .lines()
            .filter_map(|line| cron_command(line, false))
            .collect::<Vec<_>>();
        assert_eq!(
            cron_d_commands,
            vec![
                "/usr/sbin/logrotate /etc/logrotate.conf",
                "/usr/bin/php /srv/app/artisan schedule:run",
                "/usr/lib/postgresql/15/bin/pg_ctlcluster 15 main start",
            ]
        );
    }

    #[test]
    fn cron_d_discovery_caps_directory_work_and_sorts_the_retained_paths() {
        let directory = tempdir().expect("temporary cron.d directory");
        for index in (0..=MAX_CRON_D_ENTRIES).rev() {
            fs::write(
                directory.path().join(format!("job-{index:03}")),
                format!("* * * * * /bin/echo {index}\n"),
            )
            .expect("fixture cron file");
        }

        let selected = bounded_cron_d_paths(fs::read_dir(directory.path()).expect("read cron.d"));

        assert!(selected.was_capped);
        assert_eq!(selected.paths.len(), MAX_CRON_D_ENTRIES);
        assert!(
            selected.paths.windows(2).all(|pair| pair[0] < pair[1]),
            "only the bounded retained set is sorted before publication"
        );
    }

    #[test]
    fn cron_discovery_rejects_outside_root_symlinks() {
        let directory = tempdir().expect("temporary cron.d directory");
        let outside = tempdir().expect("temporary outside directory");
        let outside_file = outside.path().join("outside-cron");
        fs::write(&outside_file, "* * * * * /bin/echo outside\n").expect("outside fixture");
        symlink(&outside_file, directory.path().join("link")).expect("fixture symlink");

        let mut jobs = Vec::new();
        let mut diagnostics = Vec::new();
        collect_cron_d_files(directory.path(), &mut jobs, &mut diagnostics);

        assert!(jobs.is_empty(), "symlink content must not be collected");
        assert!(diagnostics.is_empty(), "no external path is published");
    }

    #[test]
    fn cron_files_at_or_below_the_byte_cap_are_eligible_but_larger_files_are_rejected() {
        assert!(cron_file_size_is_allowed(MAX_CRON_FILE_BYTES));
        assert!(!cron_file_size_is_allowed(MAX_CRON_FILE_BYTES + 1));
    }
}
