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

/// Read at most one entry beyond the fixed cap. A directory which exceeds the
/// cap fails closed rather than publishing an arbitrary subset whose membership
/// would depend on the filesystem's directory iteration order. Directories at
/// or below the cap publish every eligible path in lexical order.
fn bounded_cron_d_paths(entries: fs::ReadDir) -> BoundedCronDPaths {
    let mut selected = BTreeSet::new();
    for (index, entry) in entries.enumerate() {
        if index == MAX_CRON_D_ENTRIES {
            return BoundedCronDPaths {
                paths: Vec::new(),
                was_capped: true,
            };
        }
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        // Reject anything but regular files before open. O_NOFOLLOW and
        // O_NONBLOCK below preserve this fail-closed behavior if a leaf is
        // replaced between this check and opening its descriptor.
        if !fs::symlink_metadata(&path)
            .map(|metadata| metadata.file_type().is_file())
            .unwrap_or(false)
        {
            continue;
        }
        selected.insert(path);
    }
    BoundedCronDPaths {
        paths: selected.into_iter().collect(),
        was_capped: false,
    }
}

fn read_cron_file(
    path: &Path,
    jobs: &mut Vec<(String, usize, String)>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    if !cron_path_is_regular(path) {
        return;
    }
    read_cron_file_after_precheck(path, jobs, diagnostics);
}

fn cron_path_is_regular(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_file())
        .unwrap_or(false)
}

fn read_cron_file_after_precheck(
    path: &Path,
    jobs: &mut Vec<(String, usize, String)>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    // O_NOFOLLOW rejects a link swapped in after symlink_metadata; O_NONBLOCK
    // prevents a FIFO swapped in at that point from stalling collection.
    let Ok(file) = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    else {
        return;
    };
    read_open_cron_file(file, path, jobs, diagnostics);
}

/// Test-only seam for exercising a replacement after the path precheck and
/// before descriptor open, without timing-dependent sleeps or host writes.
#[cfg(test)]
fn read_cron_file_with_pre_open_hook<F>(
    path: &Path,
    jobs: &mut Vec<(String, usize, String)>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
    hook: F,
) where
    F: FnOnce(),
{
    if !cron_path_is_regular(path) {
        return;
    }
    hook();
    read_cron_file_after_precheck(path, jobs, diagnostics);
}

/// Inspect and read only an already-opened descriptor. Metadata comes from the
/// descriptor (rather than a pre-open path lookup), so a replacement or growth
/// race cannot make us trust stale size/type information.
fn read_open_cron_file(
    file: fs::File,
    path: &Path,
    jobs: &mut Vec<(String, usize, String)>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    let Some(file) = checked_open_cron_file(file, diagnostics) else {
        return;
    };
    read_checked_cron_file(file, path, jobs, diagnostics);
}

fn checked_open_cron_file(
    file: fs::File,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) -> Option<fs::File> {
    let Ok(metadata) = file.metadata() else {
        return None;
    };
    if !metadata.is_file() {
        return None;
    }
    if metadata.len() > MAX_CRON_FILE_BYTES {
        push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::ScheduledJob,
            DiagnosticSeverity::Info,
            format!("cron file skipped because it exceeds {MAX_CRON_FILE_BYTES} bytes"),
        );
        return None;
    }
    Some(file)
}

fn read_checked_cron_file(
    file: fs::File,
    path: &Path,
    jobs: &mut Vec<(String, usize, String)>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
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

/// Test-only seam for growth after descriptor metadata is checked but before
/// the capped descriptor read begins.
#[cfg(test)]
fn read_open_cron_file_with_pre_read_hook<F>(
    file: fs::File,
    path: &Path,
    jobs: &mut Vec<(String, usize, String)>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
    hook: F,
) where
    F: FnOnce(),
{
    let Some(file) = checked_open_cron_file(file, diagnostics) else {
        return;
    };
    hook();
    read_checked_cron_file(file, path, jobs, diagnostics);
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
    use std::{
        ffi::CString,
        os::unix::{ffi::OsStrExt, fs::symlink},
    };
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
    fn cron_d_discovery_fails_closed_at_the_entry_cap_and_reports_a_diagnostic() {
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
        assert!(
            selected.paths.is_empty(),
            "over-cap directory must not publish an order-dependent subset"
        );

        let mut jobs = Vec::new();
        let mut diagnostics = Vec::new();
        collect_cron_d_files(directory.path(), &mut jobs, &mut diagnostics);
        assert!(jobs.is_empty());
        assert!(
            diagnostics.iter().any(|diagnostic| diagnostic.message
                == format!("cron.d discovery capped at {MAX_CRON_D_ENTRIES} entries")),
            "the cap must be observable without exposing source paths"
        );
    }

    #[test]
    fn cron_d_discovery_sorts_every_under_cap_regular_file() {
        let directory = tempdir().expect("temporary cron.d directory");
        for name in ["z-last", "a-first", "m-middle"] {
            fs::write(directory.path().join(name), "* * * * * root /bin/true\n")
                .expect("fixture cron file");
        }

        let selected = bounded_cron_d_paths(fs::read_dir(directory.path()).expect("read cron.d"));

        assert!(!selected.was_capped);
        assert_eq!(
            selected.paths,
            ["a-first", "m-middle", "z-last"]
                .into_iter()
                .map(|name| directory.path().join(name))
                .collect::<Vec<_>>()
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
    fn cron_files_at_the_byte_cap_are_collected_and_oversize_files_are_diagnosed() {
        let directory = tempdir().expect("temporary cron directory");
        let at_cap = directory.path().join("at-cap");
        let prefix = "* * * * * root ";
        fs::write(
            &at_cap,
            format!(
                "{prefix}{}",
                "x".repeat(MAX_CRON_FILE_BYTES as usize - prefix.len())
            ),
        )
        .expect("at-cap fixture");
        let oversized = directory.path().join("oversized");
        fs::write(&oversized, "x".repeat(MAX_CRON_FILE_BYTES as usize + 1))
            .expect("oversized fixture");

        let mut jobs = Vec::new();
        let mut diagnostics = Vec::new();
        read_cron_file(&at_cap, &mut jobs, &mut diagnostics);
        read_cron_file(&oversized, &mut jobs, &mut diagnostics);

        assert_eq!(jobs.len(), 1, "the exact byte cap remains eligible");
        assert!(diagnostics.iter().any(|diagnostic| diagnostic.message
            == format!("cron file skipped because it exceeds {MAX_CRON_FILE_BYTES} bytes")));
    }

    #[test]
    fn cron_discovery_rejects_fifos_without_blocking() {
        let directory = tempdir().expect("temporary cron.d directory");
        let fifo = directory.path().join("fifo");
        let fifo_name = CString::new(fifo.as_os_str().as_bytes()).expect("temporary FIFO path");
        assert_eq!(unsafe { libc::mkfifo(fifo_name.as_ptr(), 0o600) }, 0);

        let mut jobs = Vec::new();
        let mut diagnostics = Vec::new();
        collect_cron_d_files(directory.path(), &mut jobs, &mut diagnostics);

        assert!(jobs.is_empty(), "FIFO content must never be read");
        assert!(diagnostics.is_empty(), "FIFO paths must not be published");
    }

    #[test]
    fn cron_prechecked_path_replacement_with_a_fifo_is_nonblocking_and_fails_closed() {
        let directory = tempdir().expect("temporary cron.d directory");
        let path = directory.path().join("replacement");
        fs::write(&path, "* * * * * root /bin/true\n").expect("initial fixture");
        let fifo_path = path.clone();

        let mut jobs = Vec::new();
        let mut diagnostics = Vec::new();
        read_cron_file_with_pre_open_hook(&path, &mut jobs, &mut diagnostics, move || {
            fs::remove_file(&fifo_path).expect("replace fixture");
            let fifo_name =
                CString::new(fifo_path.as_os_str().as_bytes()).expect("temporary FIFO path");
            assert_eq!(unsafe { libc::mkfifo(fifo_name.as_ptr(), 0o600) }, 0);
        });

        assert!(jobs.is_empty(), "replacement FIFO content must not be read");
        assert!(
            diagnostics.is_empty(),
            "replacement FIFO path must not be published"
        );
    }

    #[test]
    fn cron_prechecked_path_replacement_with_a_symlink_fails_closed() {
        let directory = tempdir().expect("temporary cron.d directory");
        let outside = tempdir().expect("temporary outside directory");
        let outside_file = outside.path().join("outside-cron");
        fs::write(&outside_file, "* * * * * root /bin/echo outside\n").expect("outside fixture");
        let path = directory.path().join("replacement");
        fs::write(&path, "* * * * * root /bin/true\n").expect("initial fixture");
        let symlink_path = path.clone();

        let mut jobs = Vec::new();
        let mut diagnostics = Vec::new();
        read_cron_file_with_pre_open_hook(&path, &mut jobs, &mut diagnostics, move || {
            fs::remove_file(&symlink_path).expect("replace fixture");
            symlink(&outside_file, &symlink_path).expect("replacement symlink");
        });

        assert!(
            jobs.is_empty(),
            "replacement symlink content must not be read"
        );
        assert!(
            diagnostics.is_empty(),
            "replacement symlink path must not be published"
        );
    }

    #[test]
    fn cron_descriptor_metadata_rechecks_size_after_post_open_growth() {
        let directory = tempdir().expect("temporary cron directory");
        let path = directory.path().join("growing");
        fs::write(&path, "* * * * * root /bin/true\n").expect("initial fixture");
        let file = fs::OpenOptions::new()
            .read(true)
            .open(&path)
            .expect("open fixture");
        fs::write(&path, "x".repeat(MAX_CRON_FILE_BYTES as usize + 1)).expect("grow fixture");

        let mut jobs = Vec::new();
        let mut diagnostics = Vec::new();
        read_open_cron_file(file, &path, &mut jobs, &mut diagnostics);

        assert!(jobs.is_empty());
        assert!(diagnostics.iter().any(|diagnostic| diagnostic.message
            == format!("cron file skipped because it exceeds {MAX_CRON_FILE_BYTES} bytes")));
    }

    #[test]
    fn cron_bounded_read_rejects_growth_after_descriptor_metadata() {
        let directory = tempdir().expect("temporary cron directory");
        let path = directory.path().join("growing");
        fs::write(&path, "* * * * * root /bin/true\n").expect("initial fixture");
        let file = fs::OpenOptions::new()
            .read(true)
            .open(&path)
            .expect("open fixture");
        let growth_path = path.clone();

        let mut jobs = Vec::new();
        let mut diagnostics = Vec::new();
        read_open_cron_file_with_pre_read_hook(
            file,
            &path,
            &mut jobs,
            &mut diagnostics,
            move || {
                use std::io::Write;

                let mut writer = fs::OpenOptions::new()
                    .append(true)
                    .open(&growth_path)
                    .expect("reopen fixture for growth");
                writer
                    .write_all(&vec![b'x'; MAX_CRON_FILE_BYTES as usize + 1])
                    .expect("grow fixture after metadata");
            },
        );

        assert!(
            jobs.is_empty(),
            "post-metadata growth must not publish a partial cron job"
        );
        assert!(diagnostics.iter().any(|diagnostic| diagnostic.message
            == format!("cron file skipped because it exceeds {MAX_CRON_FILE_BYTES} bytes")));
    }
}
