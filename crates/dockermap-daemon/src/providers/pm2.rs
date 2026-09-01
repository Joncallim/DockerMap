//! Read-only PM2 process discovery.
//!
//! The provider invokes only the fixed `pm2 jlist` command. Its output is
//! bounded by the shared process runner and is published through the normal
//! runtime-map redaction pass.

use crate::process_runner::{run_command_with_timeout, PROVIDER_COMMAND_TIMEOUT};
use crate::push_provider_diagnostic;
use dockermap_core::{
    collision_resistant_id_component, service_entity_kind_name, DiagnosticSeverity,
    RuntimeMapDiagnostic, RuntimeMapNode, RuntimeNodeKind, RuntimeNodeLayer, RuntimeProviderKind,
    ServiceEntityKind,
};
use std::{collections::BTreeMap, process::Command};

pub(crate) fn collect_pm2_apps(
    nodes: &mut Vec<RuntimeMapNode>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    let output = match run_command_with_timeout(
        {
            let mut command = Command::new("pm2");
            command.arg("jlist");
            command
        },
        PROVIDER_COMMAND_TIMEOUT,
    ) {
        Ok(output) => output,
        Err(error) => {
            push_provider_diagnostic(
                diagnostics,
                RuntimeProviderKind::Pm2,
                DiagnosticSeverity::Info,
                format!("PM2 discovery skipped: {error}"),
            );
            return;
        }
    };

    if !output.status.success() {
        push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::Pm2,
            DiagnosticSeverity::Warning,
            "PM2 discovery command failed".into(),
        );
        return;
    }

    match pm2_app_nodes_from_jlist(&String::from_utf8_lossy(&output.stdout)) {
        Some(app_nodes) => nodes.extend(app_nodes),
        None => push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::Pm2,
            DiagnosticSeverity::Warning,
            "PM2 discovery returned invalid JSON".into(),
        ),
    }
}

fn pm2_app_nodes_from_jlist(value: &str) -> Option<Vec<RuntimeMapNode>> {
    let Ok(apps) = serde_json::from_str::<Vec<serde_json::Value>>(value) else {
        return None;
    };

    let mut nodes = Vec::with_capacity(apps.len());
    for app in apps {
        let id = value_to_string(app.get("pm_id")).unwrap_or_else(|| "unknown".into());
        let env = app.get("pm2_env").unwrap_or(&serde_json::Value::Null);
        let name = env
            .get("name")
            .and_then(serde_json::Value::as_str)
            .or_else(|| app.get("name").and_then(serde_json::Value::as_str))
            .unwrap_or("pm2-app");
        let status = env
            .get("status")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let mut metadata = BTreeMap::new();
        if let Some(cwd) = env.get("pm_cwd").and_then(serde_json::Value::as_str) {
            metadata.insert("cwd".into(), cwd.into());
        }
        if let Some(script) = env.get("pm_exec_path").and_then(serde_json::Value::as_str) {
            metadata.insert("script".into(), script.into());
        }
        if let Some(restarts) = env.get("restart_time").and_then(serde_json::Value::as_i64) {
            metadata.insert("restartCount".into(), restarts.to_string());
        }
        metadata.insert(
            "serviceEntityKind".into(),
            service_entity_kind_name(&ServiceEntityKind::NodeApplication).into(),
        );
        nodes.push(RuntimeMapNode {
            id: format!("pm2_app_{}", collision_resistant_id_component(&id)),
            provider: RuntimeProviderKind::Pm2,
            kind: RuntimeNodeKind::Pm2App,
            label: name.into(),
            status,
            layer: Some(RuntimeNodeLayer::Process),
            metadata,
            service: None,
            package: None,
        });
    }
    Some(nodes)
}

fn value_to_string(value: Option<&serde_json::Value>) -> Option<String> {
    match value {
        Some(serde_json::Value::String(value)) => Some(value.clone()),
        Some(serde_json::Value::Number(value)) => Some(value.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_pm2_nodes_from_fixture_jlist() {
        let nodes = pm2_app_nodes_from_jlist(include_str!(
            "../../../../tests/fixtures/providers/parser/pm2-jlist.json"
        ))
        .expect("fixture jlist must parse");

        assert_eq!(nodes.len(), 3);
        assert!(nodes[0].id.starts_with("pm2_app_0--"));
        assert_eq!(nodes[0].label, "web");
        assert_eq!(nodes[0].status.as_deref(), Some("online"));
        assert_eq!(nodes[0].layer, Some(RuntimeNodeLayer::Process));
        assert_eq!(
            nodes[0].metadata.get("cwd").map(String::as_str),
            Some("/srv/app")
        );
        assert_eq!(
            nodes[0].metadata.get("script").map(String::as_str),
            Some("/srv/app/dist/index.js")
        );
        assert_eq!(
            nodes[0].metadata.get("restartCount").map(String::as_str),
            Some("3")
        );

        assert_eq!(nodes[1].status.as_deref(), Some("stopped"));
        assert!(nodes[2].id.starts_with("pm2_app_2--"));
        assert_eq!(nodes[2].status.as_deref(), Some("errored"));
        assert_eq!(
            nodes[2].metadata.get("restartCount").map(String::as_str),
            Some("12")
        );
    }
}
