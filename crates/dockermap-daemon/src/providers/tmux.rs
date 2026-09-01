//! Read-only tmux session discovery.
//!
//! The provider invokes only a fixed `tmux list-sessions` command. Session
//! labels and metadata are subsequently passed through the daemon's common
//! runtime redaction boundary before publication.

use crate::process_runner::{run_command_with_timeout, PROVIDER_COMMAND_TIMEOUT};
use crate::{push_provider_diagnostic, safe_runtime_id_component};
use dockermap_core::{
    service_entity_kind_name, DiagnosticSeverity, RuntimeMapDiagnostic, RuntimeMapNode,
    RuntimeNodeKind, RuntimeNodeLayer, RuntimeProviderKind, ServiceEntityKind,
};
use std::{collections::BTreeMap, process::Command};

/// Collect tmux sessions using its documented, fixed read-only listing form.
pub(crate) fn collect_tmux_sessions(
    nodes: &mut Vec<RuntimeMapNode>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    let output = match run_command_with_timeout(
        {
            let mut command = Command::new("tmux");
            command.args([
                "list-sessions",
                "-F",
                "#{session_id}\t#{session_name}\t#{session_attached}\t#{session_windows}",
            ]);
            command
        },
        PROVIDER_COMMAND_TIMEOUT,
    ) {
        Ok(output) => output,
        Err(error) => {
            push_provider_diagnostic(
                diagnostics,
                RuntimeProviderKind::Tmux,
                DiagnosticSeverity::Info,
                format!("tmux discovery skipped: {error}"),
            );
            return;
        }
    };

    if !output.status.success() {
        return;
    }

    nodes.extend(tmux_session_nodes_from_output(&String::from_utf8_lossy(
        &output.stdout,
    )));
}

fn tmux_session_nodes_from_output(value: &str) -> Vec<RuntimeMapNode> {
    let mut nodes = Vec::new();
    for line in value.lines() {
        let parts = line.split('\t').collect::<Vec<_>>();
        if parts.len() < 4 {
            continue;
        }
        let mut metadata = BTreeMap::new();
        metadata.insert("sessionId".into(), parts[0].into());
        metadata.insert("windows".into(), parts[3].into());
        metadata.insert(
            "serviceEntityKind".into(),
            service_entity_kind_name(&ServiceEntityKind::Session).into(),
        );
        nodes.push(RuntimeMapNode {
            id: format!(
                "tmux_session_{}",
                safe_runtime_id_component(parts[0], "session")
            ),
            provider: RuntimeProviderKind::Tmux,
            kind: RuntimeNodeKind::TmuxSession,
            label: parts[1].into(),
            status: Some(
                if parts[2] == "0" {
                    "detached"
                } else {
                    "attached"
                }
                .into(),
            ),
            layer: Some(RuntimeNodeLayer::Session),
            metadata,
            service: None,
            package: None,
        });
    }
    nodes
}

#[cfg(test)]
mod tests {
    use super::tmux_session_nodes_from_output;
    use crate::{redact_runtime_node, REDACTED_VALUE};
    use dockermap_core::RuntimeNodeLayer;

    fn assert_no_raw_secrets<T: serde::Serialize>(value: &T, secrets: &[&str]) {
        let serialized = serde_json::to_string(value).expect("test value serializes");
        for secret in secrets {
            assert!(
                !serialized.contains(secret),
                "published value unexpectedly contains secret sentinel"
            );
        }
    }

    #[test]
    fn redacts_tmux_secret_like_fixture_output() {
        let mut nodes = tmux_session_nodes_from_output(include_str!(
            "../../../../tests/fixtures/providers/redaction/tmux-list-sessions.txt"
        ));
        for node in &mut nodes {
            redact_runtime_node(node);
        }

        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[0].label, REDACTED_VALUE);
        assert_eq!(nodes[1].label, "safe-worker");
        assert_no_raw_secrets(&nodes, &["DOCKERMAP_TEST_FAKE_TMUX_SESSION_SECRET"]);
    }

    #[test]
    fn parses_tmux_sessions_from_fixture() {
        let nodes = tmux_session_nodes_from_output(include_str!(
            "../../../../tests/fixtures/providers/parser/tmux-sessions.txt"
        ));

        assert_eq!(nodes.len(), 3);
        assert!(nodes[0].id.starts_with("tmux_session_0--"));
        assert_eq!(nodes[0].label, "work");
        assert_eq!(nodes[0].status.as_deref(), Some("attached"));
        assert_eq!(
            nodes[0].metadata.get("windows").map(String::as_str),
            Some("3")
        );
        assert_eq!(nodes[1].status.as_deref(), Some("detached"));
        assert_eq!(nodes[2].label, "monitoring");
        assert_eq!(nodes[2].status.as_deref(), Some("attached"));
        assert_eq!(nodes[0].layer, Some(RuntimeNodeLayer::Session));
    }
}
