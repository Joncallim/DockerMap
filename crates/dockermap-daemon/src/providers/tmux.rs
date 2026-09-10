//! Read-only tmux session discovery.
//!
//! The provider invokes only a fixed `tmux list-sessions` command. Its output
//! is used solely to derive opaque session identity; names, attachment state,
//! window counts, and raw session IDs never enter the public runtime model.

use crate::process_runner::{
    ProviderCommandError, ProviderCommandOutput, PROVIDER_COMMAND_TIMEOUT,
};
use crate::{opaque_runtime_id_component, push_provider_diagnostic};
use dockermap_core::{
    service_entity_kind_name, DiagnosticSeverity, RuntimeMapDiagnostic, RuntimeMapEdge,
    RuntimeMapNode, RuntimeNodeKind, RuntimeNodeLayer, RuntimeProviderKind,
    RuntimeRelationshipKind, ServiceEntityKind,
};
use std::{collections::BTreeMap, process::Command};

/// Private handoff marker. Cache refresh removes it on every path and creates
/// public evidence only after this exact Tmux slot owns a successful revision.
pub(crate) const TMUX_EVIDENCE_SESSION_LISTING_MARKER: &str = "__dockermapTmuxSessionListing";
/// A deliberately small upper bound. Apply it while parsing, before any
/// runtime node or marker edge is allocated from provider output.
pub(crate) const MAX_TMUX_SESSIONS: usize = 64;

pub(crate) fn collect_tmux_sessions_with_runner<F>(
    nodes: &mut Vec<RuntimeMapNode>,
    edges: &mut Vec<RuntimeMapEdge>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
    mut run_command: F,
) -> Result<(), ProviderCommandError>
where
    F: FnMut(
        std::process::Command,
        std::time::Duration,
    ) -> Result<ProviderCommandOutput, ProviderCommandError>,
{
    let output = match run_command(
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
            return Err(error);
        }
    };

    // `tmux list-sessions` exits 1 both for no server and for real failures.
    // Accept only tmux's closed, bounded no-server diagnostic as a fresh empty
    // inventory; all other nonzero results retain the normal failure path.
    if output.status.code() == Some(1)
        && is_tmux_no_server_diagnostic(&output.stderr, output.stderr_truncated)
    {
        return Ok(());
    }

    if !output.status.success() {
        push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::Tmux,
            DiagnosticSeverity::Warning,
            "tmux discovery command failed".into(),
        );
        return Err(ProviderCommandError::Wait);
    }

    let sessions = tmux_session_nodes_from_output(&String::from_utf8_lossy(&output.stdout));
    edges.extend(tmux_session_listing_edges(&sessions));
    nodes.extend(sessions);
    Ok(())
}

fn is_tmux_no_server_diagnostic(stderr: &[u8], truncated: bool) -> bool {
    if truncated {
        return false;
    }
    let Ok(stderr) = std::str::from_utf8(stderr) else {
        return false;
    };
    let diagnostic = stderr.strip_suffix('\n').unwrap_or(stderr);
    diagnostic
        .strip_prefix("no server running on ")
        .is_some_and(|location| !location.is_empty() && !location.contains(['\n', '\r']))
}

fn tmux_session_listing_edges(sessions: &[RuntimeMapNode]) -> Vec<RuntimeMapEdge> {
    sessions
        .iter()
        .filter(|session| {
            session.provider == RuntimeProviderKind::Tmux
                && session.kind == RuntimeNodeKind::TmuxSession
                && session.id.starts_with("tmux_session_")
        })
        .map(|session| RuntimeMapEdge {
            source: session.id.clone(),
            target: "host_local".into(),
            relationship: RuntimeRelationshipKind::RunsOn,
            metadata: BTreeMap::from([(
                TMUX_EVIDENCE_SESSION_LISTING_MARKER.into(),
                "observed".into(),
            )]),
            evidence_refs: Vec::new(),
        })
        .collect()
}

fn tmux_session_nodes_from_output(value: &str) -> Vec<RuntimeMapNode> {
    let mut nodes = Vec::with_capacity(MAX_TMUX_SESSIONS);
    for line in value.lines() {
        let mut parts = line.split('\t');
        let Some(session_id) = parts.next() else {
            continue;
        };
        // The remaining fixed fields establish that this is a full response
        // record, but are intentionally never retained or published.
        if parts.next().is_none() || parts.next().is_none() || parts.next().is_none() {
            continue;
        }
        let mut metadata = BTreeMap::new();
        metadata.insert(
            "serviceEntityKind".into(),
            service_entity_kind_name(&ServiceEntityKind::Session).into(),
        );
        nodes.push(RuntimeMapNode {
            id: format!(
                "tmux_session_{}",
                opaque_runtime_id_component(session_id, "session")
            ),
            provider: RuntimeProviderKind::Tmux,
            kind: RuntimeNodeKind::TmuxSession,
            label: "tmux session".into(),
            status: None,
            layer: Some(RuntimeNodeLayer::Session),
            metadata,
            service: None,
            package: None,
        });
        if nodes.len() == MAX_TMUX_SESSIONS {
            break;
        }
    }
    nodes
}

#[cfg(test)]
mod tests {
    use super::{
        collect_tmux_sessions_with_runner, tmux_session_listing_edges,
        tmux_session_nodes_from_output, MAX_TMUX_SESSIONS, TMUX_EVIDENCE_SESSION_LISTING_MARKER,
    };
    use crate::process_runner::ProviderCommandError;
    use dockermap_core::{RuntimeNodeLayer, RuntimeProviderKind};
    use std::{os::unix::process::ExitStatusExt, process::ExitStatus, time::Duration};

    fn tmux_output(
        exit_code: i32,
        stdout: &str,
        stderr: &str,
    ) -> crate::process_runner::ProviderCommandOutput {
        crate::process_runner::ProviderCommandOutput {
            status: ExitStatus::from_raw(exit_code << 8),
            stdout: stdout.as_bytes().to_vec(),
            stdout_truncated: false,
            stderr: stderr.as_bytes().to_vec(),
            stderr_truncated: false,
        }
    }

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
    fn never_retains_tmux_raw_fixture_output() {
        let nodes = tmux_session_nodes_from_output(include_str!(
            "../../../../tests/fixtures/providers/redaction/tmux-list-sessions.txt"
        ));

        assert_eq!(nodes.len(), 2);
        assert!(nodes.iter().all(|node| node.label == "tmux session"));
        assert!(nodes.iter().all(|node| node.status.is_none()));
        assert!(nodes.iter().all(|node| node.metadata.len() == 1));
        assert_no_raw_secrets(
            &nodes,
            &[
                "DOCKERMAP_TEST_FAKE_TMUX_SESSION_SECRET",
                "safe-worker",
                "$1",
            ],
        );

        let hostile = tmux_session_nodes_from_output("tmux-ID-PRIVATE-7f3d\tinnocent-name\t1\t7\n");
        assert_eq!(hostile.len(), 1);
        assert_no_raw_secrets(&hostile, &["tmux-ID-PRIVATE-7f3d", "innocent-name"]);
    }

    #[test]
    fn parses_tmux_sessions_from_fixture() {
        let nodes = tmux_session_nodes_from_output(include_str!(
            "../../../../tests/fixtures/providers/parser/tmux-sessions.txt"
        ));

        assert_eq!(nodes.len(), 3);
        assert!(nodes[0].id.starts_with("tmux_session_session--"));
        assert!(nodes.iter().all(|node| node.label == "tmux session"));
        assert!(nodes.iter().all(|node| node.status.is_none()));
        assert!(nodes.iter().all(|node| node.metadata.len() == 1));
        assert_eq!(nodes[0].layer, Some(RuntimeNodeLayer::Session));
    }

    #[test]
    fn session_listing_fixture_produces_only_private_observation_markers() {
        let nodes = tmux_session_nodes_from_output(include_str!(
            "../../../../tests/fixtures/providers/parser/tmux-sessions.txt"
        ));
        let edges = tmux_session_listing_edges(&nodes);

        assert_eq!(edges.len(), nodes.len());
        assert!(edges.iter().all(|edge| {
            edge.source.starts_with("tmux_session_")
                && edge.target == "host_local"
                && edge.relationship == dockermap_core::RuntimeRelationshipKind::RunsOn
                && edge.metadata.get(TMUX_EVIDENCE_SESSION_LISTING_MARKER)
                    == Some(&"observed".into())
                && edge.evidence_refs.is_empty()
        }));
    }

    #[test]
    fn session_parser_caps_before_public_node_or_marker_allocation() {
        let output = (0..(MAX_TMUX_SESSIONS + 9))
            .map(|index| format!("private-{index}\tname-{index}\t0\t1"))
            .collect::<Vec<_>>()
            .join("\n");
        let nodes = tmux_session_nodes_from_output(&output);
        let edges = tmux_session_listing_edges(&nodes);

        assert_eq!(nodes.len(), MAX_TMUX_SESSIONS);
        assert_eq!(edges.len(), MAX_TMUX_SESSIONS);
        assert!(nodes.iter().zip(&edges).all(|(node, edge)| {
            edge.source == node.id
                && edge.metadata.get(TMUX_EVIDENCE_SESSION_LISTING_MARKER)
                    == Some(&"observed".into())
        }));
        assert_no_raw_secrets(&nodes, &["private-0", "name-0"]);
        assert_no_raw_secrets(&edges, &["private-0", "name-0"]);
    }

    #[test]
    fn command_timeout_and_ordinary_failure_remain_distinct() {
        for expected in [
            ProviderCommandError::TimedOut(Duration::from_secs(3)),
            ProviderCommandError::Wait,
        ] {
            let mut nodes = Vec::new();
            let mut edges = Vec::new();
            let mut diagnostics = Vec::new();
            let result = collect_tmux_sessions_with_runner(
                &mut nodes,
                &mut edges,
                &mut diagnostics,
                |_command, _timeout| Err(expected),
            );

            assert!(matches!(
                (result, expected),
                (
                    Err(ProviderCommandError::TimedOut(_)),
                    ProviderCommandError::TimedOut(_)
                ) | (Err(ProviderCommandError::Wait), ProviderCommandError::Wait)
            ));
            assert!(nodes.is_empty() && edges.is_empty());
            assert!(diagnostics
                .iter()
                .any(|diagnostic| { diagnostic.provider == RuntimeProviderKind::Tmux }));
        }
    }

    #[test]
    fn normal_no_server_exit_is_a_fresh_empty_listing() {
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        let mut diagnostics = Vec::new();
        let result = collect_tmux_sessions_with_runner(
            &mut nodes,
            &mut edges,
            &mut diagnostics,
            |_command, _timeout| {
                Ok(tmux_output(
                    1,
                    "",
                    "no server running on /tmp/tmux-1000/default\n",
                ))
            },
        );

        assert!(result.is_ok());
        assert!(nodes.is_empty() && edges.is_empty() && diagnostics.is_empty());
    }

    #[test]
    fn nonzero_tmux_error_is_not_misclassified_as_no_server_or_published() {
        let private_error = "permission denied opening private tmux socket";
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        let mut diagnostics = Vec::new();
        let result = collect_tmux_sessions_with_runner(
            &mut nodes,
            &mut edges,
            &mut diagnostics,
            |_command, _timeout| Ok(tmux_output(1, "", private_error)),
        );

        assert!(matches!(result, Err(ProviderCommandError::Wait)));
        assert!(nodes.is_empty() && edges.is_empty());
        assert!(diagnostics
            .iter()
            .all(|diagnostic| !diagnostic.message.contains(private_error)));
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].message, "tmux discovery command failed");
    }

    #[test]
    fn successful_tmux_listing_remains_fresh_and_parsed() {
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        let mut diagnostics = Vec::new();
        let result = collect_tmux_sessions_with_runner(
            &mut nodes,
            &mut edges,
            &mut diagnostics,
            |_command, _timeout| Ok(tmux_output(0, "$0\tprivate-name\t0\t1\n", "")),
        );

        assert!(result.is_ok());
        assert_eq!(nodes.len(), 1);
        assert_eq!(edges.len(), 1);
        assert!(diagnostics.is_empty());
        assert_no_raw_secrets(&nodes, &["$0", "private-name"]);
    }
}
