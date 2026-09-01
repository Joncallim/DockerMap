use crate::process_runner::{run_command_with_timeout, PROVIDER_COMMAND_TIMEOUT};
use crate::providers::{looks_like_ai_agent, non_empty_string};
use crate::{push_provider_diagnostic, safe_runtime_id_component};
#[cfg(test)]
use crate::{redact_runtime_node, REDACTED_VALUE};
use dockermap_core::{
    service_entity_kind_name, DiagnosticSeverity, RuntimeMapDiagnostic, RuntimeMapEdge,
    RuntimeMapNode, RuntimeNodeKind, RuntimeNodeLayer, RuntimeProviderKind,
    RuntimeRelationshipKind, ServiceEntityKind,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    process::Command,
};

const MAX_SYSTEMD_UNITS: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq)]
struct SystemdUnitSummary {
    unit: String,
    active_state: String,
    sub_state: String,
    description: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct SystemdUnitDetails {
    id: String,
    active_state: Option<String>,
    sub_state: Option<String>,
    description: Option<String>,
    fragment_path: Option<String>,
    load_state: Option<String>,
    exec_start: Option<String>,
    restart: Option<String>,
    active_enter_timestamp: Option<String>,
    active_enter_monotonic_us: Option<u64>,
    requires: Vec<String>,
    wants: Vec<String>,
    part_of: Vec<String>,
}

pub(crate) fn collect_systemd_services(
    nodes: &mut Vec<RuntimeMapNode>,
    edges: &mut Vec<RuntimeMapEdge>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    let system_uptime = system_uptime_seconds_from_proc();
    let output = match run_command_with_timeout(
        {
            let mut command = Command::new("systemctl");
            command.args([
                "list-units",
                "--type=service",
                "--all",
                "--no-legend",
                "--no-pager",
                "--plain",
            ]);
            command
        },
        PROVIDER_COMMAND_TIMEOUT,
    ) {
        Ok(output) => output,
        Err(error) => {
            push_provider_diagnostic(
                diagnostics,
                RuntimeProviderKind::Systemd,
                DiagnosticSeverity::Info,
                format!("systemd discovery skipped: {error}"),
            );
            return;
        }
    };

    if !output.status.success() {
        push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::Systemd,
            DiagnosticSeverity::Warning,
            "systemd discovery command failed".into(),
        );
        return;
    }

    let mut summaries = parse_systemd_list_units(&String::from_utf8_lossy(&output.stdout));
    if summaries.len() > MAX_SYSTEMD_UNITS {
        summaries.truncate(MAX_SYSTEMD_UNITS);
        push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::Systemd,
            DiagnosticSeverity::Info,
            format!("systemd discovery capped at {MAX_SYSTEMD_UNITS} services"),
        );
    }

    let mut details_by_unit = BTreeMap::new();
    if !summaries.is_empty() {
        let units = summaries
            .iter()
            .map(|summary| summary.unit.as_str())
            .collect::<Vec<_>>();
        match run_command_with_timeout(
            {
                let mut command = Command::new("systemctl");
                command.arg("show");
                command.arg("--no-pager");
                command.arg(
                    "--property=Id,ActiveState,SubState,Description,FragmentPath,LoadState,ExecStart,Restart,ActiveEnterTimestamp,ActiveEnterTimestampMonotonic,Requires,Wants,PartOf",
                );
                command.args(units);
                command
            },
            PROVIDER_COMMAND_TIMEOUT,
        ) {
            Ok(show_output) if show_output.status.success() => {
                for detail in
                    parse_systemd_show_records(&String::from_utf8_lossy(&show_output.stdout))
                {
                    if !detail.id.is_empty() {
                        details_by_unit.insert(detail.id.clone(), detail);
                    }
                }
            }
            Ok(_) => push_provider_diagnostic(
                diagnostics,
                RuntimeProviderKind::Systemd,
                DiagnosticSeverity::Warning,
                "systemd show command failed; dependency edges omitted".into(),
            ),
            Err(error) => push_provider_diagnostic(
                diagnostics,
                RuntimeProviderKind::Systemd,
                DiagnosticSeverity::Info,
                format!("systemd dependency discovery skipped: {error}"),
            ),
        }
    }

    let summary_by_unit = summaries
        .iter()
        .map(|summary| (summary.unit.clone(), summary.clone()))
        .collect::<BTreeMap<_, _>>();

    for summary in &summaries {
        let detail = details_by_unit.get(&summary.unit);
        nodes.push(systemd_runtime_node(
            &summary.unit,
            Some(summary),
            detail,
            system_uptime,
        ));
    }

    let mut dependency_reasons = BTreeMap::<(String, String), BTreeSet<String>>::new();
    for detail in details_by_unit.values() {
        for (property, dependency) in systemd_dependency_pairs(detail) {
            let source = systemd_node_id(&detail.id);
            let target = systemd_node_id(&dependency);
            if source == target {
                continue;
            }
            dependency_reasons
                .entry((source, target))
                .or_default()
                .insert(property);
            if !summary_by_unit.contains_key(&dependency) {
                nodes.push(systemd_runtime_node(&dependency, None, None, system_uptime));
            }
        }
    }

    for ((source, target), reasons) in dependency_reasons {
        let mut metadata = BTreeMap::new();
        metadata.insert(
            "systemdProperties".into(),
            reasons.into_iter().collect::<Vec<_>>().join(","),
        );
        edges.push(RuntimeMapEdge {
            source,
            target,
            relationship: RuntimeRelationshipKind::DependsOn,
            metadata,
            evidence_refs: Vec::new(),
        });
    }
}

fn parse_systemd_list_units(value: &str) -> Vec<SystemdUnitSummary> {
    value
        .lines()
        .filter_map(|line| {
            let parts = line.split_whitespace().collect::<Vec<_>>();
            if parts.len() < 4 || !parts[0].ends_with(".service") {
                return None;
            }
            Some(SystemdUnitSummary {
                unit: parts[0].to_string(),
                active_state: parts[2].to_string(),
                sub_state: parts[3].to_string(),
                description: parts
                    .get(4..)
                    .map(|items| items.join(" "))
                    .unwrap_or_default(),
            })
        })
        .collect()
}

fn parse_systemd_show_records(value: &str) -> Vec<SystemdUnitDetails> {
    let mut records = Vec::new();
    let mut current = SystemdUnitDetails::default();

    for line in value.lines() {
        if line.trim().is_empty() {
            if !current.id.is_empty() {
                records.push(current);
            }
            current = SystemdUnitDetails::default();
            continue;
        }

        let Some((key, raw_value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let parsed_value = raw_value.trim();
        match key {
            "Id" => current.id = parsed_value.to_string(),
            "ActiveState" => current.active_state = non_empty_string(parsed_value),
            "SubState" => current.sub_state = non_empty_string(parsed_value),
            "Description" => current.description = non_empty_string(parsed_value),
            "FragmentPath" => current.fragment_path = non_empty_string(parsed_value),
            "LoadState" => current.load_state = non_empty_string(parsed_value),
            "ExecStart" => current.exec_start = non_empty_string(parsed_value),
            "Restart" => current.restart = non_empty_string(parsed_value),
            "ActiveEnterTimestamp" => {
                current.active_enter_timestamp = non_empty_string(parsed_value);
            }
            "ActiveEnterTimestampMonotonic" => {
                current.active_enter_monotonic_us = parsed_value.parse::<u64>().ok();
            }
            "Requires" => current.requires = parse_systemd_unit_list(parsed_value),
            "Wants" => current.wants = parse_systemd_unit_list(parsed_value),
            "PartOf" => current.part_of = parse_systemd_unit_list(parsed_value),
            _ => {}
        }
    }

    if !current.id.is_empty() {
        records.push(current);
    }

    records
}

fn parse_systemd_unit_list(value: &str) -> Vec<String> {
    value
        .split_whitespace()
        .filter(|unit| unit.ends_with(".service"))
        .map(str::to_string)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn systemd_dependency_pairs(detail: &SystemdUnitDetails) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    for dependency in &detail.requires {
        pairs.push(("requires".into(), dependency.clone()));
    }
    for dependency in &detail.wants {
        pairs.push(("wants".into(), dependency.clone()));
    }
    for dependency in &detail.part_of {
        pairs.push(("part_of".into(), dependency.clone()));
    }
    pairs
}

fn systemd_runtime_node(
    unit: &str,
    summary: Option<&SystemdUnitSummary>,
    detail: Option<&SystemdUnitDetails>,
    system_uptime: Option<f64>,
) -> RuntimeMapNode {
    let active_state = detail
        .and_then(|value| value.active_state.as_deref())
        .or_else(|| summary.map(|value| value.active_state.as_str()))
        .map(str::to_string);
    let mut metadata = BTreeMap::new();
    metadata.insert("unit".into(), unit.to_string());
    metadata.insert(
        "serviceEntityKind".into(),
        service_entity_kind_name(&classify_systemd_service_entity(detail)).into(),
    );

    if let Some(sub_state) = detail
        .and_then(|value| value.sub_state.as_deref())
        .or_else(|| summary.map(|value| value.sub_state.as_str()))
    {
        metadata.insert("subState".into(), sub_state.to_string());
    }
    if let Some(description) = detail
        .and_then(|value| value.description.as_deref())
        .or_else(|| summary.map(|value| value.description.as_str()))
        .filter(|value| !value.is_empty())
    {
        metadata.insert("description".into(), description.to_string());
    }
    if let Some(fragment_path) = detail.and_then(|value| value.fragment_path.as_deref()) {
        metadata.insert("fragmentPath".into(), fragment_path.to_string());
    }
    if let Some(load_state) = detail.and_then(|value| value.load_state.as_deref()) {
        metadata.insert("loadState".into(), load_state.to_string());
    }
    if let Some(restart) = detail
        .and_then(|value| value.restart.as_deref())
        .filter(|value| !value.is_empty() && *value != "no")
    {
        metadata.insert("restartPolicy".into(), restart.to_string());
    }
    if let Some(active_enter) = detail.and_then(|value| value.active_enter_timestamp.as_deref()) {
        metadata.insert("activeEnter".into(), active_enter.to_string());
    }
    if let Some(uptime) = detail.and_then(|value| systemd_uptime_seconds(value, system_uptime)) {
        metadata.insert("uptimeSeconds".into(), uptime.to_string());
    }

    RuntimeMapNode {
        id: systemd_node_id(unit),
        provider: RuntimeProviderKind::Systemd,
        kind: RuntimeNodeKind::SystemdService,
        label: unit.trim_end_matches(".service").to_string(),
        status: active_state,
        layer: Some(RuntimeNodeLayer::Service),
        metadata,
        service: None,
        package: None,
    }
}

/// Uptime of an active unit in whole seconds, derived from the monotonic
/// active-enter clock and `/proc/uptime`. Returns `None` when the unit is not
/// currently active or the host does not expose `/proc/uptime`.
fn systemd_uptime_seconds(detail: &SystemdUnitDetails, system_uptime: Option<f64>) -> Option<u64> {
    if detail.active_state.as_deref() != Some("active") {
        return None;
    }
    let monotonic_us = detail.active_enter_monotonic_us?;
    let uptime = system_uptime?;
    let seconds = (uptime - monotonic_us as f64 / 1_000_000.0).max(0.0);
    Some(seconds.round() as u64)
}

fn system_uptime_seconds_from_proc() -> Option<f64> {
    let content = fs::read_to_string("/proc/uptime").ok()?;
    content.split_whitespace().next()?.parse::<f64>().ok()
}

fn classify_systemd_service_entity(detail: Option<&SystemdUnitDetails>) -> ServiceEntityKind {
    let Some(exec_start) = detail.and_then(|value| value.exec_start.as_deref()) else {
        return ServiceEntityKind::Service;
    };
    let haystack = exec_start.to_ascii_lowercase();
    if looks_like_ai_agent(&haystack) {
        ServiceEntityKind::AiAgent
    } else if haystack.contains("python")
        || haystack.contains(".py")
        || haystack.contains("uvicorn")
        || haystack.contains("gunicorn")
        || haystack.contains("celery")
    {
        ServiceEntityKind::PythonApplication
    } else if haystack.contains("node")
        || haystack.contains("npm")
        || haystack.contains("npx")
        || haystack.contains(".js")
        || haystack.contains(".mjs")
    {
        ServiceEntityKind::NodeApplication
    } else {
        ServiceEntityKind::Service
    }
}

fn systemd_node_id(unit: &str) -> String {
    format!(
        "systemd_service_{}",
        safe_runtime_id_component(unit, "redacted")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_no_raw_secrets<T: serde::Serialize>(value: &T, secrets: &[&str]) {
        let serialized = serde_json::to_string(value).expect("value should serialize");
        for secret in secrets {
            assert!(
                !serialized.contains(secret),
                "serialized provider output leaked `{secret}`: {serialized}"
            );
        }
    }

    #[test]
    fn parses_systemd_list_units_and_filters_non_services() {
        let units = parse_systemd_list_units(
            "ssh.service loaded active running OpenSSH server daemon\n\
             var-lib.mount loaded active mounted /var/lib\n\
             docker.service loaded inactive dead Docker Application Container Engine",
        );

        assert_eq!(units.len(), 2);
        assert_eq!(units[0].unit, "ssh.service");
        assert_eq!(units[0].description, "OpenSSH server daemon");
        assert_eq!(units[1].unit, "docker.service");
    }

    #[test]
    fn parses_systemd_show_dependency_records() {
        let records = parse_systemd_show_records(
            "Id=app.service\n\
             ActiveState=active\n\
             SubState=running\n\
             Description=App Service\n\
             ExecStart={ path=/usr/bin/python ; argv[]=python app.py ; }\n\
             Restart=always\n\
             ActiveEnterTimestamp=Wed 2026-08-19 04:05:06 UTC\n\
             ActiveEnterTimestampMonotonic=1200000000\n\
             Requires=network-online.target redis.service\n\
             Wants=postgres.service\n\
             PartOf=worker.service\n\
             \n\
             Id=redis.service\n\
             ActiveState=active\n",
        );

        assert_eq!(records.len(), 2);
        assert_eq!(records[0].id, "app.service");
        assert_eq!(
            systemd_dependency_pairs(&records[0]),
            vec![
                ("requires".to_string(), "redis.service".to_string()),
                ("wants".to_string(), "postgres.service".to_string()),
                ("part_of".to_string(), "worker.service".to_string())
            ]
        );
        assert_eq!(
            classify_systemd_service_entity(records.first()),
            ServiceEntityKind::PythonApplication
        );
        assert_eq!(records[0].restart.as_deref(), Some("always"));
        assert_eq!(
            records[0].active_enter_timestamp.as_deref(),
            Some("Wed 2026-08-19 04:05:06 UTC")
        );
        assert_eq!(records[0].active_enter_monotonic_us, Some(1_200_000_000));
    }

    #[test]
    fn computes_systemd_uptime_only_for_active_units() {
        let active = SystemdUnitDetails {
            id: "app.service".into(),
            active_state: Some("active".into()),
            active_enter_monotonic_us: Some(10_000_000),
            ..SystemdUnitDetails::default()
        };
        let inactive = SystemdUnitDetails {
            id: "idle.service".into(),
            active_state: Some("inactive".into()),
            active_enter_monotonic_us: Some(10_000_000),
            ..SystemdUnitDetails::default()
        };

        assert_eq!(
            systemd_uptime_seconds(&active, Some(1_010.0)),
            Some(1_000),
            "uptime is system uptime minus monotonic active-enter clock"
        );
        assert_eq!(systemd_uptime_seconds(&active, None), None);
        assert_eq!(systemd_uptime_seconds(&inactive, Some(1_010.0)), None);
    }

    #[test]
    fn redacts_systemd_secret_like_fixture_output() {
        let details = parse_systemd_show_records(include_str!(
            "../../../../tests/fixtures/providers/redaction/systemd-show.txt"
        ));
        let summary = SystemdUnitSummary {
            unit: "redaction-worker.service".into(),
            active_state: "active".into(),
            sub_state: "running".into(),
            description: "Worker started with token=DOCKERMAP_TEST_FAKE_SYSTEMD_SUMMARY_TOKEN"
                .into(),
        };

        let mut node = systemd_runtime_node(
            "redaction-worker.service",
            Some(&summary),
            details.first(),
            None,
        );
        redact_runtime_node(&mut node);

        assert_eq!(
            node.metadata.get("serviceEntityKind").map(String::as_str),
            Some("python_application")
        );
        assert_eq!(
            node.metadata.get("description").map(String::as_str),
            Some(REDACTED_VALUE)
        );
        assert_no_raw_secrets(
            &node,
            &[
                "DOCKERMAP_TEST_FAKE_SYSTEMD_DESCRIPTION_TOKEN",
                "DOCKERMAP_TEST_FAKE_SYSTEMD_EXEC_TOKEN",
                "DOCKERMAP_TEST_FAKE_SYSTEMD_URL_TOKEN",
                "DOCKERMAP_TEST_FAKE_SYSTEMD_SUMMARY_TOKEN",
            ],
        );
    }

    #[test]
    fn parses_systemd_list_units_from_fixture() {
        let summaries = parse_systemd_list_units(include_str!(
            "../../../../tests/fixtures/providers/parser/systemd-list-units.txt"
        ));

        let names = summaries
            .iter()
            .map(|summary| summary.unit.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            vec![
                "app-worker.service",
                "db.service",
                "masked-unit.service",
                "postgres.service"
            ]
        );
        assert_eq!(summaries[0].active_state, "active");
        assert_eq!(summaries[0].sub_state, "running");
        assert_eq!(summaries[0].description, "Application worker");
        assert_eq!(summaries[3].active_state, "failed");
        assert!(!names.iter().any(|name| name.contains("timer")));
    }

    #[test]
    fn parses_systemd_show_records_from_fixture() {
        let records = parse_systemd_show_records(include_str!(
            "../../../../tests/fixtures/providers/parser/systemd-show.txt"
        ));

        assert_eq!(records.len(), 3);

        let worker = &records[0];
        assert_eq!(worker.id, "app-worker.service");
        assert_eq!(worker.restart.as_deref(), Some("on-failure"));
        assert_eq!(
            worker.active_enter_timestamp.as_deref(),
            Some("Tue 2026-08-18 04:05:06 UTC")
        );
        assert_eq!(
            worker.active_enter_monotonic_us,
            Some(1_723_942_196_123_456)
        );
        assert_eq!(worker.requires, vec!["redis.service"]);
        assert_eq!(worker.wants, vec!["postgres.service"]);
        assert!(worker.part_of.is_empty());

        let db = &records[1];
        assert_eq!(db.id, "db.service");
        assert_eq!(db.active_state.as_deref(), Some("inactive"));
        assert_eq!(db.restart.as_deref(), Some("no"));
        assert_eq!(db.active_enter_monotonic_us, Some(0));

        assert_eq!(records[2].id, "masked-unit.service");
    }
}
