//! Internal, typed boundary for a single runtime-provider collection pass.
//!
//! Providers contribute observations and diagnostics to this short-lived value;
//! only `runtime_collection` converts it into a public `RuntimeMap`. This is
//! intentionally not a plugin interface: providers remain statically linked,
//! fixed read-only collectors. Keeping their mutable outputs here gives a
//! future scheduler one bounded unit to run without route, cache, or
//! publication authority.

use crate::publication::{
    push_provider_diagnostic, redact_runtime_diagnostics, redact_runtime_edges,
    redact_runtime_nodes,
};
use dockermap_core::{
    DiagnosticSeverity, ProviderSlot, ProviderState, ProviderStateKind, RuntimeMapDiagnostic,
    RuntimeMapEdge, RuntimeMapNode, RuntimeProviderKind,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProviderDiagnostic {
    pub(crate) provider: RuntimeProviderKind,
    pub(crate) severity: DiagnosticSeverity,
    pub(crate) message: String,
}

impl ProviderDiagnostic {
    pub(crate) fn new(
        provider: RuntimeProviderKind,
        severity: DiagnosticSeverity,
        message: impl Into<String>,
    ) -> Self {
        Self {
            provider,
            severity,
            message: message.into(),
        }
    }
}

/// Accumulates only provider observations for one refresh. Diagnostics enter
/// through this boundary so they retain the existing redaction-before-storage
/// invariant even before publication.
#[derive(Clone, Default)]
pub(crate) struct ProviderCollection {
    nodes: Vec<RuntimeMapNode>,
    edges: Vec<RuntimeMapEdge>,
    diagnostics: Vec<RuntimeMapDiagnostic>,
    states: Vec<ProviderState>,
}

impl ProviderCollection {
    pub(crate) fn nodes_mut(&mut self) -> &mut Vec<RuntimeMapNode> {
        &mut self.nodes
    }

    pub(crate) fn parts_mut(
        &mut self,
    ) -> (
        &mut Vec<RuntimeMapNode>,
        &mut Vec<RuntimeMapEdge>,
        &mut Vec<RuntimeMapDiagnostic>,
    ) {
        (&mut self.nodes, &mut self.edges, &mut self.diagnostics)
    }

    pub(crate) fn push_diagnostic(&mut self, diagnostic: ProviderDiagnostic) {
        push_provider_diagnostic(
            &mut self.diagnostics,
            diagnostic.provider,
            diagnostic.severity,
            diagnostic.message,
        );
    }

    pub(crate) fn into_parts(
        self,
    ) -> (
        Vec<RuntimeMapNode>,
        Vec<RuntimeMapEdge>,
        Vec<RuntimeMapDiagnostic>,
    ) {
        (self.nodes, self.edges, self.diagnostics)
    }

    /// Fixed static-slot state is collected independently of human-readable
    /// diagnostics. That keeps the public freshness contract bounded and
    /// prevents consumers from reverse-engineering state from error strings.
    pub(crate) fn set_state(&mut self, slot: ProviderSlot, state: ProviderStateKind) {
        if let Some(existing) = self
            .states
            .iter_mut()
            .find(|existing| existing.slot == slot)
        {
            existing.state = state;
        } else {
            // These collection-local values are later projected through the
            // cache scheduler, which supplies public freshness metadata. A
            // provider implementation cannot forge timestamps or revisions.
            self.states.push(ProviderState {
                slot,
                state,
                last_attempt_ms: None,
                last_success_ms: None,
                last_duration_ms: None,
                consecutive_failure_count: 0,
                data_revision: None,
                status_reason: None,
            });
            self.states.sort_by_key(|state| state.slot);
        }
    }

    pub(crate) fn states(&self) -> &[ProviderState] {
        &self.states
    }

    /// A private equality key for an already-sanitized retained collection.
    /// It is intentionally not a hash and never leaves the daemon: the public
    /// cache exposes only an opaque CSPRNG-backed revision when this safe
    /// observable evidence changes.
    pub(crate) fn sanitized_observable_identity(&self) -> String {
        serde_json::to_string(&(&self.nodes, &self.edges, &self.diagnostics, &self.states))
            .expect("sanitized provider collection is serializable")
    }

    /// The cache can retain a successful provider pass across later failures.
    /// Provider implementations may add node, edge, and diagnostic fields
    /// directly, so sanitize every retained field before it becomes
    /// long-lived. Do not run topology normalization here: provider edges may
    /// intentionally target Docker nodes that are added only when the public
    /// map is derived from a snapshot.
    pub(crate) fn sanitized_for_retention(mut self) -> Self {
        redact_runtime_nodes(&mut self.nodes);
        redact_runtime_edges(&mut self.edges);
        redact_runtime_diagnostics(&mut self.diagnostics);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dockermap_core::{RuntimeNodeKind, RuntimeRelationshipKind};
    use std::collections::BTreeMap;

    #[test]
    fn diagnostics_are_redacted_before_the_collection_exposes_them() {
        let mut collection = ProviderCollection::default();
        collection.push_diagnostic(ProviderDiagnostic::new(
            RuntimeProviderKind::Other,
            DiagnosticSeverity::Warning,
            "provider failed with token=DOCKERMAP_TEST_PROVIDER_CONTRACT_SECRET",
        ));

        let (_, _, diagnostics) = collection.into_parts();
        assert_eq!(diagnostics.len(), 1);
        assert!(!diagnostics[0]
            .message
            .contains("DOCKERMAP_TEST_PROVIDER_CONTRACT_SECRET"));
    }

    #[test]
    fn retained_observations_sanitize_node_edge_and_diagnostic_fields_before_cache_storage() {
        let secret = "DOCKERMAP_TEST_FAKE_RETAINED_PROVIDER_SECRET";
        let mut collection = ProviderCollection::default();
        let mut node_metadata = BTreeMap::new();
        node_metadata.insert("token".into(), secret.into());
        collection.nodes.push(RuntimeMapNode {
            id: format!("provider-{secret}"),
            provider: RuntimeProviderKind::Process,
            kind: RuntimeNodeKind::Process,
            label: secret.into(),
            status: Some(secret.into()),
            layer: None,
            metadata: node_metadata,
            service: None,
            package: None,
        });
        let mut edge_metadata = BTreeMap::new();
        edge_metadata.insert("credential".into(), secret.into());
        collection.edges.push(RuntimeMapEdge {
            source: format!("provider-{secret}"),
            target: "docker_container_target".into(),
            relationship: RuntimeRelationshipKind::RelatedTo,
            metadata: edge_metadata,
            evidence_refs: Vec::new(),
        });
        collection.diagnostics.push(RuntimeMapDiagnostic {
            provider: RuntimeProviderKind::Process,
            severity: DiagnosticSeverity::Warning,
            message: format!("provider failed with token={secret}"),
        });

        let (nodes, edges, diagnostics) = collection.sanitized_for_retention().into_parts();
        let stored = serde_json::to_string(&(nodes, edges, diagnostics))
            .expect("retained observations should serialize");
        assert!(
            !stored.contains(secret),
            "raw provider data must not survive in the retained cache"
        );
    }
}
