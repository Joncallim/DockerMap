//! Explicitly opt-in overlay-network discovery.
//!
//! These collectors only run fixed local CLI commands. They deliberately do
//! not configure a tailnet, authenticate to a control plane, or make network
//! requests on DockerMap's behalf.

use crate::process_runner::{run_command_with_timeout, PROVIDER_COMMAND_TIMEOUT};
use crate::{push_provider_diagnostic, safe_runtime_id_component};
#[cfg(test)]
use crate::{redact_runtime_node, REDACTED_VALUE};
use dockermap_core::{
    DiagnosticSeverity, RuntimeMapDiagnostic, RuntimeMapNode, RuntimeNodeKind, RuntimeNodeLayer,
    RuntimeProviderKind,
};
use std::{collections::BTreeMap, process::Command};

/// Provider collection is intentionally off unless the operator explicitly
/// supplies the exact string `true`.
pub(crate) fn provider_opt_in(name: &str) -> bool {
    std::env::var(name).ok().as_deref() == Some("true")
}

pub(crate) fn collect_tailscale(
    nodes: &mut Vec<RuntimeMapNode>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    let output = match run_command_with_timeout(
        {
            let mut command = Command::new("tailscale");
            command.args(["status", "--json"]);
            command
        },
        PROVIDER_COMMAND_TIMEOUT,
    ) {
        Ok(output) => output,
        Err(error) => {
            push_provider_diagnostic(
                diagnostics,
                RuntimeProviderKind::Tailscale,
                DiagnosticSeverity::Info,
                format!("Tailscale discovery skipped: {error}"),
            );
            return;
        }
    };

    if !output.status.success() {
        push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::Tailscale,
            DiagnosticSeverity::Warning,
            "Tailscale status command failed".into(),
        );
        return;
    }

    let Ok(status) = serde_json::from_slice::<serde_json::Value>(&output.stdout) else {
        push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::Tailscale,
            DiagnosticSeverity::Warning,
            "Tailscale status returned invalid JSON".into(),
        );
        return;
    };

    if let Some(self_node) = status.get("Self") {
        push_tailnet_node(nodes, RuntimeProviderKind::Tailscale, "self", self_node);
    }

    if let Some(peers) = status.get("Peer").and_then(serde_json::Value::as_object) {
        for (index, peer) in peers.values().enumerate() {
            push_tailnet_node(
                nodes,
                RuntimeProviderKind::Tailscale,
                &format!("peer_{index}"),
                peer,
            );
        }
    }
}

pub(crate) fn collect_headscale(
    nodes: &mut Vec<RuntimeMapNode>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    let output = match run_command_with_timeout(
        {
            let mut command = Command::new("headscale");
            command.args(["nodes", "list", "--output", "json"]);
            command
        },
        PROVIDER_COMMAND_TIMEOUT,
    ) {
        Ok(output) => output,
        Err(error) => {
            push_provider_diagnostic(
                diagnostics,
                RuntimeProviderKind::Headscale,
                DiagnosticSeverity::Info,
                format!("Headscale discovery skipped: {error}"),
            );
            return;
        }
    };

    if !output.status.success() {
        push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::Headscale,
            DiagnosticSeverity::Warning,
            "Headscale nodes command failed".into(),
        );
        return;
    }

    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&output.stdout) else {
        push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::Headscale,
            DiagnosticSeverity::Warning,
            "Headscale nodes command returned invalid JSON".into(),
        );
        return;
    };

    let nodes_json = value
        .as_array()
        .cloned()
        .or_else(|| {
            value
                .get("nodes")
                .and_then(serde_json::Value::as_array)
                .cloned()
        })
        .unwrap_or_default();

    for (index, node) in nodes_json.into_iter().enumerate() {
        push_tailnet_node(
            nodes,
            RuntimeProviderKind::Headscale,
            &format!("node_{index}"),
            &node,
        );
    }
}

fn push_tailnet_node(
    nodes: &mut Vec<RuntimeMapNode>,
    provider: RuntimeProviderKind,
    fallback_id: &str,
    value: &serde_json::Value,
) {
    let label = value
        .get("DNSName")
        .and_then(serde_json::Value::as_str)
        .or_else(|| value.get("HostName").and_then(serde_json::Value::as_str))
        .or_else(|| value.get("givenName").and_then(serde_json::Value::as_str))
        .or_else(|| value.get("name").and_then(serde_json::Value::as_str))
        .unwrap_or(fallback_id)
        .trim_end_matches('.')
        .to_string();
    let online = value
        .get("Online")
        .and_then(serde_json::Value::as_bool)
        .or_else(|| value.get("online").and_then(serde_json::Value::as_bool));
    let mut metadata = BTreeMap::new();
    if let Some(addresses) = value
        .get("TailscaleIPs")
        .and_then(serde_json::Value::as_array)
        .or_else(|| {
            value
                .get("ipAddresses")
                .and_then(serde_json::Value::as_array)
        })
    {
        let ips = addresses
            .iter()
            .filter_map(serde_json::Value::as_str)
            .collect::<Vec<_>>();
        if !ips.is_empty() {
            metadata.insert("ips".into(), ips.join(","));
        }
    }
    if let Some(user) = value
        .get("User")
        .and_then(serde_json::Value::as_str)
        .or_else(|| value.get("user").and_then(serde_json::Value::as_str))
    {
        metadata.insert("user".into(), user.into());
    }

    let provider_id = match provider {
        RuntimeProviderKind::Tailscale => "tailscale",
        RuntimeProviderKind::Headscale => "headscale",
        _ => "tailnet",
    };
    nodes.push(RuntimeMapNode {
        id: format!(
            "{provider_id}_node_{}",
            safe_runtime_id_component(&label, fallback_id)
        ),
        provider,
        kind: RuntimeNodeKind::TailnetNode,
        label,
        status: online.map(|value| if value { "online" } else { "offline" }.into()),
        layer: Some(RuntimeNodeLayer::Edge),
        metadata,
        service: None,
        package: None,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_no_raw_secrets<T: serde::Serialize>(value: &T, secrets: &[&str]) {
        let rendered = serde_json::to_string(value).expect("test values serialize");
        for secret in secrets {
            assert!(
                !rendered.contains(secret),
                "published value leaked {secret}"
            );
        }
    }

    #[test]
    fn providers_are_opt_in_by_default() {
        assert!(!provider_opt_in("DOCKERMAP_TEST_TAILNET_PROVIDER_OPT_IN"));
    }

    #[test]
    fn redacts_secret_like_ids_and_metadata() {
        let value = serde_json::json!({
            "DNSName": "worker.token=DOCKERMAP_TEST_FAKE_TAILNET_ID_TOKEN.example.",
            "User": "operator SECRET_KEY=DOCKERMAP_TEST_FAKE_TAILNET_USER_SECRET",
            "TailscaleIPs": ["100.64.0.2"],
            "Online": true
        });
        let mut nodes = Vec::new();
        push_tailnet_node(&mut nodes, RuntimeProviderKind::Tailscale, "peer_0", &value);
        redact_runtime_node(&mut nodes[0]);

        assert!(nodes[0].id.starts_with("tailscale_node_peer_0--"));
        assert_eq!(nodes[0].label, REDACTED_VALUE);
        assert_eq!(
            nodes[0].metadata.get("user").map(String::as_str),
            Some(REDACTED_VALUE)
        );
        assert_no_raw_secrets(
            &nodes,
            &[
                "DOCKERMAP_TEST_FAKE_TAILNET_ID_TOKEN",
                "DOCKERMAP_TEST_FAKE_TAILNET_USER_SECRET",
            ],
        );
    }

    #[test]
    fn builds_tailscale_nodes_from_fixture() {
        let status: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/providers/parser/tailscale-status.json"
        ))
        .expect("fixture must parse");
        let mut nodes = Vec::new();
        if let Some(self_node) = status.get("Self") {
            push_tailnet_node(
                &mut nodes,
                RuntimeProviderKind::Tailscale,
                "self",
                self_node,
            );
        }
        if let Some(peers) = status.get("Peer").and_then(serde_json::Value::as_object) {
            for (index, peer) in peers.values().enumerate() {
                push_tailnet_node(
                    &mut nodes,
                    RuntimeProviderKind::Tailscale,
                    &format!("peer_{index}"),
                    peer,
                );
            }
        }

        assert_eq!(nodes.len(), 3);
        assert_eq!(nodes[0].label, "hearth.example");
        assert_eq!(nodes[0].status.as_deref(), Some("online"));
        assert_eq!(
            nodes[0].metadata.get("ips").map(String::as_str),
            Some("100.64.0.1")
        );
        assert_eq!(
            nodes[0].metadata.get("user").map(String::as_str),
            Some("operator")
        );
        assert_eq!(nodes[1].label, "nas.example");
        assert_eq!(nodes[2].label, "laptop.example");
        assert_eq!(nodes[2].status.as_deref(), Some("offline"));
        assert_eq!(
            nodes[2].metadata.get("ips").map(String::as_str),
            Some("100.64.0.3,fd7a:115c:a1e0::3")
        );
        for node in &nodes {
            assert_eq!(node.layer, Some(RuntimeNodeLayer::Edge));
            assert!(node.id.starts_with("tailscale_node_"));
        }
    }

    #[test]
    fn builds_headscale_nodes_from_fixture() {
        let value: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/providers/parser/headscale-nodes.json"
        ))
        .expect("fixture must parse");
        let nodes_json = value
            .as_array()
            .cloned()
            .or_else(|| {
                value
                    .get("nodes")
                    .and_then(serde_json::Value::as_array)
                    .cloned()
            })
            .unwrap_or_default();
        let mut nodes = Vec::new();
        for (index, node) in nodes_json.into_iter().enumerate() {
            push_tailnet_node(
                &mut nodes,
                RuntimeProviderKind::Headscale,
                &format!("node_{index}"),
                &node,
            );
        }

        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[0].label, "nas");
        assert_eq!(nodes[0].status.as_deref(), Some("online"));
        assert_eq!(nodes[0].provider, RuntimeProviderKind::Headscale);
        assert_eq!(
            nodes[0].metadata.get("user").map(String::as_str),
            Some("ops")
        );
        assert!(nodes[0].id.starts_with("headscale_node_"));
        assert_eq!(nodes[1].label, "laptop");
        assert_eq!(nodes[1].status.as_deref(), Some("offline"));
    }
}
