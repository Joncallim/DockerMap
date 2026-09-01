//! Internal, typed boundary for a single runtime-provider collection pass.
//!
//! Providers contribute observations and diagnostics to this short-lived value;
//! only `runtime_collection` converts it into a public `RuntimeMap`. This is
//! intentionally not a plugin interface: providers remain statically linked,
//! fixed read-only collectors. Keeping their mutable outputs here gives a
//! future scheduler one bounded unit to run without route, cache, or
//! publication authority.

use crate::publication::push_provider_diagnostic;
use dockermap_core::{
    DiagnosticSeverity, RuntimeMapDiagnostic, RuntimeMapEdge, RuntimeMapNode, RuntimeProviderKind,
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
#[derive(Default)]
pub(crate) struct ProviderCollection {
    nodes: Vec<RuntimeMapNode>,
    edges: Vec<RuntimeMapEdge>,
    diagnostics: Vec<RuntimeMapDiagnostic>,
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
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
