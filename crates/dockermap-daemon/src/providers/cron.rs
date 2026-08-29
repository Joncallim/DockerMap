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
use std::{collections::BTreeMap, fs, path::Path, process::Command};

pub(crate) fn collect_scheduled_jobs(
    nodes: &mut Vec<RuntimeMapNode>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    let mut job_sources = Vec::new();
    read_cron_file(Path::new("/etc/crontab"), &mut job_sources);

    if let Ok(entries) = fs::read_dir("/etc/cron.d") {
        for entry in entries.flatten() {
            read_cron_file(&entry.path(), &mut job_sources);
        }
    }

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

fn read_cron_file(path: &Path, jobs: &mut Vec<(String, usize, String)>) {
    let Ok(content) = fs::read_to_string(path) else {
        return;
    };
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
}
