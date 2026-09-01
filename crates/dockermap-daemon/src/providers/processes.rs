//! Read-only host Python and native-process discovery.
//!
//! Both views are derived from one fixed, bounded `ps` invocation. The
//! provider never accepts user input, excludes container-owned PIDs through
//! the fail-closed PID-namespace helper, and never publishes raw argv.

use crate::{
    pid_namespace::is_container_owned,
    process_runner::{
        run_command_with_timeout, MAX_PROVIDER_OUTPUT_BYTES, PROVIDER_COMMAND_TIMEOUT,
    },
    push_provider_diagnostic, redact_sensitive_text,
};
use dockermap_core::{
    service_entity_kind_name, DiagnosticSeverity, RuntimeMapDiagnostic, RuntimeMapNode,
    RuntimeNodeKind, RuntimeNodeLayer, RuntimeProviderKind, ServiceEntityKind,
};
use std::{collections::BTreeMap, process::Command};

pub(crate) const MAX_PYTHON_PROCESSES: usize = 64;
pub(crate) const MAX_NATIVE_PROCESSES: usize = 256;

#[derive(Clone, Debug)]
pub(crate) struct ProcessRecord {
    pub(crate) pid: u32,
    pub(crate) user: String,
    /// Kernel command name from `ps comm=`, never argv-derived.
    pub(crate) comm: String,
    pub(crate) args: String,
}

pub(crate) fn parse_ps_table(value: &str) -> Vec<ProcessRecord> {
    let mut records = Vec::new();
    for line in value.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let fields = trimmed.split_whitespace().collect::<Vec<_>>();
        // pid, user, comm, args: never let a malformed 3-column line shift
        // attacker-controlled argv into the trusted kernel comm slot.
        if fields.len() < 4 {
            continue;
        }
        let Ok(pid) = fields[0].parse::<u32>() else {
            continue;
        };
        let mut offset = 0usize;
        for token in &fields[..3] {
            match trimmed[offset..].find(token) {
                Some(index) => offset += index + token.len(),
                None => {
                    offset = trimmed.len();
                    break;
                }
            }
        }
        if offset >= trimmed.len() {
            continue;
        }
        let args = trimmed[offset..].trim();
        if args.is_empty() {
            continue;
        }
        records.push(ProcessRecord {
            pid,
            user: fields[1].into(),
            comm: fields[2].into(),
            args: args.into(),
        });
    }
    records
}

pub(crate) fn complete_provider_lines(output: &[u8], output_truncated: bool) -> &[u8] {
    if !output_truncated || output.last() == Some(&b'\n') {
        return output;
    }
    output
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map(|index| &output[..=index])
        .unwrap_or_default()
}

fn push_output_truncation(
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
    provider: RuntimeProviderKind,
) {
    push_provider_diagnostic(
        diagnostics,
        provider,
        DiagnosticSeverity::Info,
        format!("Provider output exceeded {MAX_PROVIDER_OUTPUT_BYTES} bytes; truncated"),
    );
}

fn contains_control_character(value: &str) -> bool {
    value.chars().any(char::is_control)
}

/// Resolve the actual executable after fixed wrapper grammar. Keeping this
/// shared ensures Python and native views never claim the same PID.
pub(crate) fn effective_executable(args: &str) -> Option<&str> {
    let mut skip = 0usize;
    let mut wrapper: Option<&str> = None;
    for token in args.split_whitespace() {
        if skip > 0 {
            skip -= 1;
            continue;
        }
        if token.starts_with('[') {
            return Some(token);
        }
        let basename = token.rsplit('/').next().unwrap_or(token);
        if matches!(
            basename,
            "env" | "sudo" | "nice" | "nohup" | "timeout" | "dumb-init" | "tini"
        ) {
            wrapper = Some(basename);
            continue;
        }
        if token.starts_with('-') {
            if let Some(active) = wrapper {
                if wrapper_option_arguments(active).contains(&token) {
                    skip = 1;
                }
            }
            continue;
        }
        if token.contains('=') || is_duration_like(token) {
            continue;
        }
        return Some(basename);
    }
    None
}

fn wrapper_option_arguments(wrapper: &str) -> &'static [&'static str] {
    match wrapper {
        "sudo" => &["-u", "--user"],
        "timeout" => &["-s", "--signal", "-k", "--kill-after"],
        "env" => &["-u", "--unset", "-C", "--chdir"],
        _ => &[],
    }
}

fn is_duration_like(token: &str) -> bool {
    let digits = token
        .bytes()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    digits > 0
        && (digits == token.len()
            || (digits + 1 == token.len()
                && matches!(token.as_bytes()[digits], b's' | b'm' | b'h' | b'd')))
}

fn is_python_owned(executable: &str) -> bool {
    let executable = executable.trim_end_matches(':');
    matches!(
        executable,
        "uvicorn" | "gunicorn" | "celery" | "flower" | "daphne"
    ) || executable.contains("python")
        || executable == "pypy"
        || executable == "pypy2"
        || executable == "pypy3"
        || executable.starts_with("pypy3.")
}

pub(crate) fn is_python_process(args: &str) -> bool {
    effective_executable(args).is_some_and(is_python_owned)
}

pub(crate) fn python_entry(args: &str) -> Option<String> {
    let fields = args.split_whitespace().collect::<Vec<_>>();
    if fields.is_empty() {
        return None;
    }
    let mut index = if fields[0].contains("python") { 1 } else { 0 };
    while index < fields.len() {
        let field = fields[index];
        if field == "-m" {
            let module = *fields.get(index + 1)?;
            return (!contains_control_character(module)).then(|| format!("module:{module}"));
        }
        if field == "-c" {
            return Some("inline:-c".into());
        }
        if field.ends_with(".py") {
            return (!contains_control_character(field)).then(|| field.into());
        }
        let basename = field.rsplit('/').next().unwrap_or(field);
        let trimmed = basename.trim_end_matches(':');
        if matches!(
            trimmed,
            "uvicorn" | "gunicorn" | "celery" | "flower" | "daphne"
        ) {
            return Some(trimmed.into());
        }
        if field.contains(':') && !field.starts_with("--") {
            return (!contains_control_character(field)).then(|| trimmed.into());
        }
        index += 1;
    }
    None
}

pub(crate) fn python_nodes_from_ps_output(value: &str) -> (Vec<RuntimeMapNode>, bool) {
    python_nodes_from_ps_output_with_container_filter(value, is_container_owned)
}

pub(crate) fn python_nodes_from_ps_output_with_container_filter(
    value: &str,
    is_container_owned: impl Fn(u32) -> bool,
) -> (Vec<RuntimeMapNode>, bool) {
    let filtered = parse_ps_table(value)
        .into_iter()
        .filter(|record| is_python_process(&record.args) && !is_container_owned(record.pid))
        .collect::<Vec<_>>();
    let capped = filtered.len() > MAX_PYTHON_PROCESSES;
    let nodes = filtered
        .into_iter()
        .take(MAX_PYTHON_PROCESSES)
        .map(|record| {
            let entry = python_entry(&record.args)
                .map(|entry| redact_sensitive_text(&entry))
                .unwrap_or_else(|| "python".into());
            let mut metadata = BTreeMap::new();
            metadata.insert("pid".into(), record.pid.to_string());
            metadata.insert("user".into(), record.user);
            metadata.insert("entry".into(), entry.clone());
            metadata.insert(
                "serviceEntityKind".into(),
                service_entity_kind_name(&ServiceEntityKind::PythonApplication).into(),
            );
            RuntimeMapNode {
                id: format!("python_process_{}", record.pid),
                provider: RuntimeProviderKind::Python,
                kind: RuntimeNodeKind::PythonApplication,
                label: entry,
                status: Some("running".into()),
                layer: Some(RuntimeNodeLayer::Process),
                metadata,
                service: None,
                package: None,
            }
        })
        .collect();
    (nodes, capped)
}

pub(crate) fn collect_python_processes(
    restricted: bool,
    nodes: &mut Vec<RuntimeMapNode>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    collect_python_processes_with_command_in_scope(
        process_discovery_command(),
        restricted,
        nodes,
        diagnostics,
    );
}

#[cfg(test)]
pub(crate) fn collect_python_processes_with_command(
    command: Command,
    nodes: &mut Vec<RuntimeMapNode>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    collect_python_processes_with_command_in_scope(command, false, nodes, diagnostics);
}

pub(crate) fn collect_python_processes_with_command_in_scope(
    command: Command,
    restricted: bool,
    nodes: &mut Vec<RuntimeMapNode>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    collect_with_command(
        command,
        restricted,
        RuntimeProviderKind::Python,
        "Python",
        nodes,
        diagnostics,
        |output, truncated, nodes, diagnostics| {
            collect_python_processes_from_output(&output, truncated, nodes, diagnostics);
        },
    );
}

pub(crate) fn collect_python_processes_from_output(
    stdout: &[u8],
    output_truncated: bool,
    nodes: &mut Vec<RuntimeMapNode>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    if output_truncated {
        push_output_truncation(diagnostics, RuntimeProviderKind::Python);
    }
    let stdout = String::from_utf8_lossy(complete_provider_lines(stdout, output_truncated));
    let (found, capped) = python_nodes_from_ps_output(&stdout);
    if capped {
        push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::Python,
            DiagnosticSeverity::Info,
            format!("Python process discovery capped at {MAX_PYTHON_PROCESSES} processes"),
        );
    }
    nodes.extend(found);
}

pub(crate) fn collect_native_processes_with_scope(
    restricted: bool,
    nodes: &mut Vec<RuntimeMapNode>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    collect_native_processes_with_command(
        process_discovery_command(),
        restricted,
        nodes,
        diagnostics,
    );
}

pub(crate) fn process_discovery_command() -> Command {
    let mut command = Command::new("ps");
    command.args(["-eo", "pid=,user:32=,comm=,args="]);
    command
}

pub(crate) fn collect_native_processes_with_command(
    command: Command,
    restricted: bool,
    nodes: &mut Vec<RuntimeMapNode>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    collect_with_command(
        command,
        restricted,
        RuntimeProviderKind::Process,
        "Native",
        nodes,
        diagnostics,
        |output, truncated, nodes, diagnostics| {
            collect_native_processes_from_output(
                &output,
                truncated,
                std::process::id(),
                nodes,
                diagnostics,
            );
        },
    );
}

fn collect_with_command(
    command: Command,
    restricted: bool,
    provider: RuntimeProviderKind,
    name: &str,
    nodes: &mut Vec<RuntimeMapNode>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
    collect: impl FnOnce(Vec<u8>, bool, &mut Vec<RuntimeMapNode>, &mut Vec<RuntimeMapDiagnostic>),
) {
    if restricted {
        push_provider_diagnostic(diagnostics, provider, DiagnosticSeverity::Info, format!("{name} process discovery omitted because the daemon runs in a restricted PID namespace; only the container's own processes would be visible"));
        return;
    }
    let output = match run_command_with_timeout(command, PROVIDER_COMMAND_TIMEOUT) {
        Ok(output) => output,
        Err(error) => {
            let message = if error.is_spawn() {
                format!("{name} process discovery command unavailable")
            } else {
                format!("{name} process discovery skipped: {error}")
            };
            push_provider_diagnostic(diagnostics, provider, DiagnosticSeverity::Warning, message);
            return;
        }
    };
    if !output.status.success() {
        push_provider_diagnostic(
            diagnostics,
            provider,
            DiagnosticSeverity::Warning,
            format!("{name} process discovery command failed"),
        );
        return;
    }
    collect(output.stdout, output.stdout_truncated, nodes, diagnostics);
}

pub(crate) fn collect_native_processes_from_output(
    stdout: &[u8],
    output_truncated: bool,
    self_pid: u32,
    nodes: &mut Vec<RuntimeMapNode>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    if output_truncated {
        push_output_truncation(diagnostics, RuntimeProviderKind::Process);
    }
    let stdout = String::from_utf8_lossy(complete_provider_lines(stdout, output_truncated));
    let (found, capped) = native_process_nodes_from_ps_output(&stdout, self_pid);
    if capped {
        push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::Process,
            DiagnosticSeverity::Info,
            format!("Native process discovery capped at {MAX_NATIVE_PROCESSES} processes"),
        );
    }
    nodes.extend(found);
}

pub(crate) fn native_process_nodes_from_ps_output(
    value: &str,
    self_pid: u32,
) -> (Vec<RuntimeMapNode>, bool) {
    let filtered = parse_ps_table(value)
        .into_iter()
        .filter(|record| {
            is_native_process(&record.args)
                && !is_container_owned(record.pid)
                && record.pid != self_pid
        })
        .collect::<Vec<_>>();
    let capped = filtered.len() > MAX_NATIVE_PROCESSES;
    let nodes = filtered
        .into_iter()
        .take(MAX_NATIVE_PROCESSES)
        .map(|record| {
            let ps_comm = process_comm(&record.comm)
                .and_then(|comm| safe_kernel_comm(&comm))
                .unwrap_or_else(|| "unknown".into());
            let comm = real_comm(record.pid, &ps_comm);
            let mut metadata = BTreeMap::new();
            metadata.insert("pid".into(), record.pid.to_string());
            metadata.insert("user".into(), record.user);
            metadata.insert("comm".into(), comm.clone());
            RuntimeMapNode {
                id: format!("native_process_{}", record.pid),
                provider: RuntimeProviderKind::Process,
                kind: RuntimeNodeKind::Process,
                label: comm,
                status: Some("running".into()),
                layer: Some(RuntimeNodeLayer::Process),
                metadata,
                service: None,
                package: None,
            }
        })
        .collect();
    (nodes, capped)
}

fn safe_kernel_comm(comm: &str) -> Option<String> {
    let comm = comm.trim();
    (!comm.is_empty() && !contains_control_character(comm)).then(|| comm.chars().take(16).collect())
}

pub(crate) fn real_comm(pid: u32, fallback: &str) -> String {
    if let Ok(comm) = std::fs::read_to_string(format!("/proc/{pid}/comm")) {
        if let Some(comm) = safe_kernel_comm(&comm) {
            return comm;
        }
    }
    safe_kernel_comm(fallback).unwrap_or_else(|| "unknown".into())
}

pub(crate) fn process_comm(args: &str) -> Option<String> {
    let executable = effective_executable(args)?;
    Some(if executable.starts_with('[') {
        executable.into()
    } else {
        executable.trim_end_matches(':').into()
    })
}

pub(crate) fn is_native_process(args: &str) -> bool {
    let Some(comm) = effective_executable(args) else {
        return false;
    };
    !comm.starts_with('[')
        && !is_python_owned(comm)
        && comm != "dockermap-daemon"
        && comm != "ps"
        && !comm.starts_with("containerd-shim")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_ownership_never_duplicates_pypy_or_frameworks() {
        for args in [
            "pypy3 /srv/x.py",
            "/usr/bin/pypy3.10 /srv/x.py",
            "gunicorn: master [app]",
            "env python3 -m celery -A tasks",
        ] {
            assert!(is_python_process(args));
            assert!(!is_native_process(args));
        }
        assert!(!is_python_process("/opt/pypy3-tool --serve"));
        assert!(is_native_process("/opt/pypy3-tool --serve"));
    }
    #[test]
    fn parser_requires_kernel_comm_and_preserves_args() {
        assert!(parse_ps_table("1 root python3").is_empty());
        let parsed = parse_ps_table("1 root python3 /usr/bin/python3 /srv/app.py");
        assert_eq!(parsed[0].comm, "python3");
        assert_eq!(parsed[0].args, "/usr/bin/python3 /srv/app.py");
    }
    #[test]
    fn container_filter_precedes_python_cap() {
        let mut table = String::new();
        for pid in 1..=65 {
            table.push_str(&format!("{pid} root python3 python3 /x{pid}.py\n"));
        }
        let (nodes, capped) =
            python_nodes_from_ps_output_with_container_filter(&table, |pid| pid <= 64);
        assert!(!capped);
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].id, "python_process_65");
    }
    #[test]
    fn raw_argv_never_becomes_native_label() {
        let (nodes, _) = native_process_nodes_from_ps_output(
            "9000100 root sleep hunter2 --sleep-forever\n",
            9_000_000,
        );
        assert_eq!(nodes[0].label, "sleep");
        assert!(nodes[0]
            .metadata
            .values()
            .all(|value| !value.contains("hunter2")));
    }
}
