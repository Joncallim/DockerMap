use crate::snapshot_runtime::is_host_published_docker_port;
use crate::{
    collision_resistant_id_component, Finding, FindingRule, FindingSeverity,
    RuntimeEvidenceAssertionKind, RuntimeEvidenceFreshness, RuntimeEvidenceKind,
    RuntimeEvidenceProvider, RuntimeMap, RuntimeMode, RuntimeNodeKind, RuntimeProviderKind,
    RuntimeRelationshipKind, RuntimeServiceStatus,
};
use std::collections::BTreeMap;

const SUMMARY: &str = "An active systemd service requires a target that is inactive or failed";
const RECOMMENDATION: &str =
    "Inspect the target service state and its declared dependency configuration.";
const INTERNAL_NETWORK_PORT_SUMMARY: &str =
    "A container on an internal Docker network also has a published host port.";
const INTERNAL_NETWORK_PORT_RECOMMENDATION: &str =
    "Review whether the host-port publication is intended for this internal-network service.";
const DOCKER_DAEMON_STATE_SUMMARY: &str =
    "A container has Docker daemon state access that may provide Docker daemon API authority.";
const DOCKER_DAEMON_STATE_RECOMMENDATION: &str =
    "Review whether this container requires Docker daemon API authority.";
const DOCKER_DAEMON_STATE_PUBLISHED_PORT_SUMMARY: &str =
    "A container with Docker daemon state access also has a published host port.";
const DOCKER_DAEMON_STATE_PUBLISHED_PORT_RECOMMENDATION: &str =
    "Review whether the daemon-state access and host-port publication are both intended.";
const DOCKER_DAEMON_STATE_RISK_ID: &str = "host_risk_docker_daemon_state";
const DOCKER_DAEMON_STATE_EVIDENCE_SUMMARY: &str =
    "Docker reported a bind mount exposing Docker daemon state";
const COMPOSE_DECLARED_TARGET_NOT_ACTIVE_SUMMARY: &str =
    "A running Docker Compose service declares a dependency whose container is not active.";
const COMPOSE_DECLARED_TARGET_NOT_ACTIVE_RECOMMENDATION: &str =
    "Review the declared dependency and the target container state.";
const COMPOSE_DEPENDENCY_EVIDENCE_SUMMARY: &str = "Docker recorded Compose dependency declaration";
const COMPOSE_MUTUAL_DEPENDENCY_SUMMARY: &str =
    "Docker recorded mutually declared Compose dependencies between two containers.";
const COMPOSE_MUTUAL_DEPENDENCY_RECOMMENDATION: &str =
    "Review the declared dependencies and remove any unintended mutual dependency.";

/// Derive bounded, deterministic advisory findings from the already-public
/// runtime topology. Every rule intentionally fails closed on its own closed
/// evidence shape and uniquely identified entities. Raw provider material is
/// never copied into a finding.
pub fn derive_findings(runtime_map: &RuntimeMap) -> Vec<Finding> {
    let node_counts = runtime_map
        .nodes
        .iter()
        .fold(BTreeMap::new(), |mut counts, node| {
            *counts.entry(node.id.as_str()).or_insert(0usize) += 1;
            counts
        });
    let nodes = runtime_map
        .nodes
        .iter()
        .filter(|node| node_counts.get(node.id.as_str()) == Some(&1))
        .map(|node| (node.id.as_str(), node))
        .collect::<BTreeMap<_, _>>();

    let mut candidate_counts = BTreeMap::<(&str, &str), usize>::new();
    for edge in &runtime_map.edges {
        if is_candidate_requires(edge) {
            *candidate_counts
                .entry((edge.source.as_str(), edge.target.as_str()))
                .or_default() += 1;
        }
    }

    let mut daemon_state_counts = BTreeMap::<(&str, &str), usize>::new();
    for edge in &runtime_map.edges {
        if is_docker_daemon_state_shape(edge, &nodes) {
            *daemon_state_counts
                .entry((edge.source.as_str(), edge.target.as_str()))
                .or_default() += 1;
        }
    }

    // This stricter rule considers every daemon-state-shaped and port-shaped
    // edge, including malformed ones. A second edge must make the combined
    // assertion ambiguous instead of being silently ignored.
    let mut daemon_state_source_counts = BTreeMap::<&str, usize>::new();
    let mut daemon_state_port_source_counts = BTreeMap::<&str, usize>::new();
    for edge in &runtime_map.edges {
        if is_docker_daemon_state_pair_shape(edge, &nodes) {
            *daemon_state_source_counts
                .entry(edge.source.as_str())
                .or_default() += 1;
        }
        if is_docker_port_publication_pair_shape(edge, &nodes) {
            *daemon_state_port_source_counts
                .entry(edge.source.as_str())
                .or_default() += 1;
        }
    }

    let mut membership_counts = BTreeMap::<(&str, &str), usize>::new();
    let mut port_counts = BTreeMap::<&str, usize>::new();
    for edge in &runtime_map.edges {
        if is_docker_membership_shape(edge, &nodes) {
            *membership_counts
                .entry((edge.source.as_str(), edge.target.as_str()))
                .or_default() += 1;
        }
        if is_docker_port_shape(edge, &nodes) {
            *port_counts.entry(edge.source.as_str()).or_default() += 1;
        }
    }
    let mut compose_dependency_counts = BTreeMap::<(&str, &str), usize>::new();
    let mut compose_dependency_edge_counts = BTreeMap::<(&str, &str), usize>::new();
    for edge in &runtime_map.edges {
        if edge.relationship == RuntimeRelationshipKind::DependsOn {
            *compose_dependency_edge_counts
                .entry((edge.source.as_str(), edge.target.as_str()))
                .or_default() += 1;
        }
        if is_candidate_compose_dependency(edge, &nodes) {
            *compose_dependency_counts
                .entry((edge.source.as_str(), edge.target.as_str()))
                .or_default() += 1;
        }
    }

    let mut findings = Vec::new();
    for edge in &runtime_map.edges {
        let pair = (edge.source.as_str(), edge.target.as_str());
        if candidate_counts.get(&pair) != Some(&1) || !is_candidate_requires(edge) {
            continue;
        }
        let evidence = edge.evidence_refs[0].clone();
        let (Some(source), Some(target)) = (nodes.get(pair.0), nodes.get(pair.1)) else {
            continue;
        };
        if source.provider != RuntimeProviderKind::Systemd
            || target.provider != RuntimeProviderKind::Systemd
            || source.kind != RuntimeNodeKind::SystemdService
            || target.kind != RuntimeNodeKind::SystemdService
            || source.status.as_deref() != Some("active")
            || !matches!(target.status.as_deref(), Some("inactive" | "failed"))
        {
            continue;
        }
        findings.push(Finding {
            id: format!(
                "finding_systemd_requires_target_not_active_{}",
                collision_resistant_id_component(&format!("{}\u{1f}{}", edge.source, edge.target))
            ),
            rule_id: FindingRule::SystemdRequiresTargetNotActive,
            severity: FindingSeverity::Warning,
            summary: SUMMARY.into(),
            recommendation: RECOMMENDATION.into(),
            subject_ref: edge.source.clone(),
            target_ref: edge.target.clone(),
            evidence_refs: vec![evidence],
        });
    }
    for daemon_edge in &runtime_map.edges {
        if daemon_state_source_counts.get(daemon_edge.source.as_str()) != Some(&1)
            || daemon_state_port_source_counts.get(daemon_edge.source.as_str()) != Some(&1)
            || !is_candidate_docker_daemon_state_bind_mount(daemon_edge, &nodes)
        {
            continue;
        }
        let Some(port_edge) = runtime_map.edges.iter().find(|candidate| {
            candidate.source == daemon_edge.source
                && is_candidate_docker_daemon_state_port_publication(candidate, &nodes)
        }) else {
            continue;
        };
        let daemon_evidence = &daemon_edge.evidence_refs[0];
        let port_evidence = &port_edge.evidence_refs[0];
        if daemon_evidence.collected_at != port_evidence.collected_at
            || daemon_evidence.provider_revision != port_evidence.provider_revision
        {
            continue;
        }
        findings.push(Finding {
            id: format!(
                "finding_docker_daemon_state_bind_mount_publishes_port_{}",
                collision_resistant_id_component(&format!(
                    "{}\u{1f}{}",
                    daemon_edge.source, daemon_edge.target
                ))
            ),
            rule_id: FindingRule::DockerDaemonStateBindMountPublishesPort,
            severity: FindingSeverity::Warning,
            summary: DOCKER_DAEMON_STATE_PUBLISHED_PORT_SUMMARY.into(),
            recommendation: DOCKER_DAEMON_STATE_PUBLISHED_PORT_RECOMMENDATION.into(),
            subject_ref: daemon_edge.source.clone(),
            target_ref: daemon_edge.target.clone(),
            evidence_refs: vec![daemon_evidence.clone(), port_evidence.clone()],
        });
    }
    // A mutual declaration is one closed, unordered pair. Iterate only the
    // lexicographically first direction so the emitted subject/target and
    // evidence order do not depend on collector edge ordering.
    for edge in &runtime_map.edges {
        let pair = (edge.source.as_str(), edge.target.as_str());
        if matches!(runtime_map.source.as_ref(), Some(RuntimeMode::Mock))
            || pair.0 >= pair.1
            || compose_dependency_edge_counts.get(&pair) != Some(&1)
            || compose_dependency_counts.get(&pair) != Some(&1)
            || !is_candidate_compose_dependency(edge, &nodes)
        {
            continue;
        }
        let reverse = (pair.1, pair.0);
        if compose_dependency_edge_counts.get(&reverse) != Some(&1)
            || compose_dependency_counts.get(&reverse) != Some(&1)
        {
            continue;
        }
        let Some(reverse_edge) = runtime_map.edges.iter().find(|candidate| {
            candidate.source == edge.target
                && candidate.target == edge.source
                && is_candidate_compose_dependency(candidate, &nodes)
        }) else {
            continue;
        };
        let evidence = &edge.evidence_refs[0];
        let reverse_evidence = &reverse_edge.evidence_refs[0];
        if evidence.collected_at != reverse_evidence.collected_at
            || evidence.provider_revision != reverse_evidence.provider_revision
        {
            continue;
        }
        findings.push(Finding {
            id: format!(
                "finding_docker_compose_mutual_dependency_{}",
                collision_resistant_id_component(&format!("{}\u{1f}{}", edge.source, edge.target))
            ),
            rule_id: FindingRule::DockerComposeMutualDependency,
            severity: FindingSeverity::Advisory,
            summary: COMPOSE_MUTUAL_DEPENDENCY_SUMMARY.into(),
            recommendation: COMPOSE_MUTUAL_DEPENDENCY_RECOMMENDATION.into(),
            subject_ref: edge.source.clone(),
            target_ref: edge.target.clone(),
            evidence_refs: vec![evidence.clone(), reverse_evidence.clone()],
        });
    }
    for edge in &runtime_map.edges {
        let pair = (edge.source.as_str(), edge.target.as_str());
        if compose_dependency_edge_counts.get(&pair) != Some(&1)
            || compose_dependency_counts.get(&pair) != Some(&1)
            || !is_candidate_compose_dependency(edge, &nodes)
        {
            continue;
        }
        let (Some(source), Some(target)) = (nodes.get(pair.0), nodes.get(pair.1)) else {
            continue;
        };
        if !is_docker_container(source)
            || !is_docker_container(target)
            || !matches!(
                source
                    .status
                    .as_deref()
                    .map(RuntimeServiceStatus::from_status_text),
                Some(RuntimeServiceStatus::Running)
            )
            || !matches!(
                target
                    .status
                    .as_deref()
                    .map(RuntimeServiceStatus::from_status_text),
                Some(RuntimeServiceStatus::Stopped | RuntimeServiceStatus::Failed)
            )
        {
            continue;
        }
        findings.push(Finding {
            id: format!(
                "finding_docker_compose_declared_target_not_active_{}",
                collision_resistant_id_component(&format!("{}\u{1f}{}", edge.source, edge.target))
            ),
            rule_id: FindingRule::DockerComposeDeclaredTargetNotActive,
            severity: FindingSeverity::Advisory,
            summary: COMPOSE_DECLARED_TARGET_NOT_ACTIVE_SUMMARY.into(),
            recommendation: COMPOSE_DECLARED_TARGET_NOT_ACTIVE_RECOMMENDATION.into(),
            subject_ref: edge.source.clone(),
            target_ref: edge.target.clone(),
            evidence_refs: vec![edge.evidence_refs[0].clone()],
        });
    }
    for edge in &runtime_map.edges {
        let pair = (edge.source.as_str(), edge.target.as_str());
        if daemon_state_counts.get(&pair) != Some(&1)
            || !is_candidate_docker_daemon_state_bind_mount(edge, &nodes)
        {
            continue;
        }
        findings.push(Finding {
            id: format!(
                "finding_docker_daemon_state_bind_mount_{}",
                collision_resistant_id_component(&format!("{}\u{1f}{}", edge.source, edge.target))
            ),
            rule_id: FindingRule::DockerDaemonStateBindMount,
            severity: FindingSeverity::Warning,
            summary: DOCKER_DAEMON_STATE_SUMMARY.into(),
            recommendation: DOCKER_DAEMON_STATE_RECOMMENDATION.into(),
            subject_ref: edge.source.clone(),
            target_ref: edge.target.clone(),
            evidence_refs: vec![edge.evidence_refs[0].clone()],
        });
    }
    for edge in &runtime_map.edges {
        let pair = (edge.source.as_str(), edge.target.as_str());
        if membership_counts.get(&pair) != Some(&1)
            || port_counts.get(edge.source.as_str()) != Some(&1)
            || !is_candidate_internal_network_membership(edge, &nodes)
        {
            continue;
        }
        let Some(port_edge) = runtime_map.edges.iter().find(|candidate| {
            candidate.source == edge.source && is_candidate_port_publication(candidate, &nodes)
        }) else {
            continue;
        };
        let network_evidence = edge.evidence_refs[0].clone();
        let port_evidence = port_edge.evidence_refs[0].clone();
        findings.push(Finding {
            id: format!(
                "finding_docker_internal_network_member_publishes_port_{}",
                collision_resistant_id_component(&format!("{}\u{1f}{}", edge.source, edge.target))
            ),
            rule_id: FindingRule::DockerInternalNetworkMemberPublishesPort,
            severity: FindingSeverity::Advisory,
            summary: INTERNAL_NETWORK_PORT_SUMMARY.into(),
            recommendation: INTERNAL_NETWORK_PORT_RECOMMENDATION.into(),
            subject_ref: edge.source.clone(),
            target_ref: edge.target.clone(),
            evidence_refs: vec![network_evidence, port_evidence],
        });
    }
    findings.sort_by(|left, right| {
        left.id
            .cmp(&right.id)
            .then_with(|| left.subject_ref.cmp(&right.subject_ref))
            .then_with(|| left.target_ref.cmp(&right.target_ref))
    });
    findings
}

fn is_docker_container(node: &crate::RuntimeMapNode) -> bool {
    node.provider == RuntimeProviderKind::Docker && node.kind == RuntimeNodeKind::Container
}

fn is_docker_daemon_state_risk(node: &crate::RuntimeMapNode) -> bool {
    node.provider == RuntimeProviderKind::Docker
        && node.kind == RuntimeNodeKind::HostRisk
        && node.id == DOCKER_DAEMON_STATE_RISK_ID
        && node.metadata.is_empty()
}

fn is_docker_daemon_state_shape<'a>(
    edge: &crate::RuntimeMapEdge,
    nodes: &BTreeMap<&'a str, &'a crate::RuntimeMapNode>,
) -> bool {
    edge.metadata.is_empty()
        && edge.relationship == RuntimeRelationshipKind::ExposesDaemonState
        && matches!(
            (nodes.get(edge.source.as_str()), nodes.get(edge.target.as_str())),
            (Some(source), Some(target))
                if is_docker_container(source) && is_docker_daemon_state_risk(target)
        )
}

fn is_docker_daemon_state_pair_shape<'a>(
    edge: &crate::RuntimeMapEdge,
    nodes: &BTreeMap<&'a str, &'a crate::RuntimeMapNode>,
) -> bool {
    edge.relationship == RuntimeRelationshipKind::ExposesDaemonState
        && matches!(
            (nodes.get(edge.source.as_str()), nodes.get(edge.target.as_str())),
            (Some(source), Some(target))
                if is_docker_container(source) && is_docker_daemon_state_risk(target)
        )
}

fn is_candidate_docker_daemon_state_bind_mount<'a>(
    edge: &crate::RuntimeMapEdge,
    nodes: &BTreeMap<&'a str, &'a crate::RuntimeMapNode>,
) -> bool {
    is_docker_daemon_state_shape(edge, nodes)
        && is_fresh_docker_evidence(edge, RuntimeEvidenceKind::DockerDaemonStateBindMount)
        && matches!(edge.evidence_refs.first(), Some(evidence) if evidence.summary == DOCKER_DAEMON_STATE_EVIDENCE_SUMMARY)
}

fn is_docker_network(node: &crate::RuntimeMapNode) -> bool {
    node.provider == RuntimeProviderKind::Docker
        && node.kind == RuntimeNodeKind::DockerNetwork
        && node.metadata.get("internal").map(String::as_str) == Some("true")
}

fn is_docker_listener(node: &crate::RuntimeMapNode) -> bool {
    node.provider == RuntimeProviderKind::Network
        && node.kind == RuntimeNodeKind::NetworkListener
        && node
            .metadata
            .get("port")
            .is_some_and(|port| is_host_published_docker_port(port))
}

fn is_docker_membership_shape<'a>(
    edge: &crate::RuntimeMapEdge,
    nodes: &BTreeMap<&'a str, &'a crate::RuntimeMapNode>,
) -> bool {
    edge.relationship == RuntimeRelationshipKind::ConnectedTo
        && matches!((nodes.get(edge.source.as_str()), nodes.get(edge.target.as_str())),
            (Some(source), Some(target)) if is_docker_container(source) && is_docker_network(target))
}

fn is_docker_port_shape<'a>(
    edge: &crate::RuntimeMapEdge,
    nodes: &BTreeMap<&'a str, &'a crate::RuntimeMapNode>,
) -> bool {
    edge.relationship == RuntimeRelationshipKind::Exposes
        && matches!((nodes.get(edge.source.as_str()), nodes.get(edge.target.as_str())),
            (Some(source), Some(target)) if is_docker_container(source) && is_docker_listener(target))
}

fn is_docker_port_publication_pair_shape<'a>(
    edge: &crate::RuntimeMapEdge,
    nodes: &BTreeMap<&'a str, &'a crate::RuntimeMapNode>,
) -> bool {
    edge.relationship == RuntimeRelationshipKind::Exposes
        && matches!(
            (nodes.get(edge.source.as_str()), nodes.get(edge.target.as_str())),
            (Some(source), Some(target))
                if is_docker_container(source)
                    && target.provider == RuntimeProviderKind::Network
                    && target.kind == RuntimeNodeKind::NetworkListener
        )
}

fn is_candidate_internal_network_membership<'a>(
    edge: &crate::RuntimeMapEdge,
    nodes: &BTreeMap<&'a str, &'a crate::RuntimeMapNode>,
) -> bool {
    is_docker_membership_shape(edge, nodes)
        && is_fresh_docker_evidence(edge, RuntimeEvidenceKind::DockerNetworkMembership)
}

fn is_candidate_port_publication<'a>(
    edge: &crate::RuntimeMapEdge,
    nodes: &BTreeMap<&'a str, &'a crate::RuntimeMapNode>,
) -> bool {
    is_docker_port_shape(edge, nodes)
        && is_fresh_docker_evidence(edge, RuntimeEvidenceKind::DockerPortPublication)
}

fn is_candidate_docker_daemon_state_port_publication<'a>(
    edge: &crate::RuntimeMapEdge,
    nodes: &BTreeMap<&'a str, &'a crate::RuntimeMapNode>,
) -> bool {
    edge.metadata.is_empty()
        && is_docker_port_publication_pair_shape(edge, nodes)
        && matches!(
            nodes.get(edge.target.as_str()),
            Some(target) if target.metadata.get("port").is_some_and(|port| is_host_published_docker_port(port))
        )
        && is_fresh_docker_evidence(edge, RuntimeEvidenceKind::DockerPortPublication)
}

fn is_fresh_docker_evidence(edge: &crate::RuntimeMapEdge, kind: RuntimeEvidenceKind) -> bool {
    edge.has_valid_evidence_refs()
        && edge.evidence_refs.len() == 1
        && matches!(edge.evidence_refs.first(), Some(evidence)
            if evidence.version == 1
                && evidence.provider == RuntimeEvidenceProvider::Docker
                && evidence.kind == kind
                && evidence.assertion_kind == RuntimeEvidenceAssertionKind::Observed
                && evidence.freshness == RuntimeEvidenceFreshness::Fresh
                && evidence.subject_ref == edge.source
                && evidence.provider_slot.is_none())
}

fn is_candidate_requires(edge: &crate::RuntimeMapEdge) -> bool {
    edge.has_valid_evidence_refs()
        && edge.relationship == RuntimeRelationshipKind::Requires
        && edge.source != edge.target
        && edge.evidence_refs.len() == 1
        && matches!(
            edge.evidence_refs.first(),
            Some(evidence)
                if evidence.version == 2
                    && evidence.provider == RuntimeEvidenceProvider::Systemd
                    && evidence.kind == RuntimeEvidenceKind::SystemdRequires
                    && evidence.assertion_kind == RuntimeEvidenceAssertionKind::Declared
                    && evidence.freshness == RuntimeEvidenceFreshness::Fresh
                    && evidence.subject_ref == edge.source
                    && evidence.provider_slot == Some(crate::ProviderSlot::Systemd)
        )
}

fn is_candidate_compose_dependency<'a>(
    edge: &crate::RuntimeMapEdge,
    nodes: &BTreeMap<&'a str, &'a crate::RuntimeMapNode>,
) -> bool {
    edge.metadata.is_empty()
        && edge.relationship == RuntimeRelationshipKind::DependsOn
        && edge.source != edge.target
        && matches!(
            (nodes.get(edge.source.as_str()), nodes.get(edge.target.as_str())),
            (Some(source), Some(target)) if is_docker_container(source) && is_docker_container(target)
        )
        && is_fresh_docker_evidence(edge, RuntimeEvidenceKind::DockerComposeDependsOn)
        && matches!(edge.evidence_refs.first(), Some(evidence) if evidence.summary == COMPOSE_DEPENDENCY_EVIDENCE_SUMMARY)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ProviderSlot, RuntimeEvidenceRef, RuntimeMapEdge, RuntimeMapNode, RuntimeNodeLayer,
    };
    use std::collections::BTreeMap;

    fn node(id: &str, status: &str) -> RuntimeMapNode {
        RuntimeMapNode {
            id: id.into(),
            provider: RuntimeProviderKind::Systemd,
            kind: RuntimeNodeKind::SystemdService,
            label: "safe label".into(),
            status: Some(status.into()),
            layer: Some(RuntimeNodeLayer::Service),
            metadata: BTreeMap::from([("fragmentPath".into(), "/secret/path".into())]),
            service: None,
            package: None,
        }
    }
    fn edge(freshness: RuntimeEvidenceFreshness) -> RuntimeMapEdge {
        let source = "systemd_service_source".to_string();
        RuntimeMapEdge {
            source: source.clone(),
            target: "systemd_service_target".into(),
            relationship: RuntimeRelationshipKind::Requires,
            metadata: BTreeMap::new(),
            evidence_refs: vec![RuntimeEvidenceRef {
                version: 2,
                id: "systemd_evidence_requires_safe".into(),
                provider: RuntimeEvidenceProvider::Systemd,
                kind: RuntimeEvidenceKind::SystemdRequires,
                assertion_kind: RuntimeEvidenceAssertionKind::Declared,
                summary: "systemd declared a Requires dependency".into(),
                subject_ref: source,
                collected_at: 1,
                provider_revision: "opaque-safe-revision".into(),
                provider_slot: Some(ProviderSlot::Systemd),
                freshness,
            }],
        }
    }
    fn map(edge: RuntimeMapEdge) -> RuntimeMap {
        RuntimeMap {
            nodes: vec![
                node("systemd_service_source", "active"),
                node("systemd_service_target", "failed"),
            ],
            edges: vec![edge],
            ..Default::default()
        }
    }

    #[test]
    fn emits_a_stable_warning_for_fresh_requires_to_failed_target() {
        let findings = derive_findings(&map(edge(RuntimeEvidenceFreshness::Fresh)));
        assert_eq!(findings.len(), 1);
        assert_eq!(
            findings[0].rule_id,
            FindingRule::SystemdRequiresTargetNotActive
        );
        assert_eq!(findings[0].severity, FindingSeverity::Warning);
        assert_eq!(findings[0].recommendation, RECOMMENDATION);
        assert_eq!(findings[0].evidence_refs.len(), 1);
        assert_eq!(
            findings[0].evidence_refs[0].kind,
            RuntimeEvidenceKind::SystemdRequires
        );
        assert!(findings[0]
            .id
            .starts_with("finding_systemd_requires_target_not_active_"));
    }

    #[test]
    fn fails_closed_for_stale_ambiguous_or_non_matching_inputs() {
        for freshness in [
            RuntimeEvidenceFreshness::Stale,
            RuntimeEvidenceFreshness::TimedOut,
        ] {
            assert!(derive_findings(&map(edge(freshness))).is_empty());
        }
        let mut ambiguous = map(edge(RuntimeEvidenceFreshness::Fresh));
        ambiguous.edges.push(edge(RuntimeEvidenceFreshness::Fresh));
        assert!(derive_findings(&ambiguous).is_empty());
        let mut collision = map(edge(RuntimeEvidenceFreshness::Fresh));
        collision
            .nodes
            .push(node("systemd_service_target", "failed"));
        assert!(derive_findings(&collision).is_empty());
        let mut wants = map(edge(RuntimeEvidenceFreshness::Fresh));
        wants.edges[0].relationship = RuntimeRelationshipKind::Wants;
        assert!(derive_findings(&wants).is_empty());
        let mut wrong_kind = map(edge(RuntimeEvidenceFreshness::Fresh));
        wrong_kind.edges[0].evidence_refs[0].kind = RuntimeEvidenceKind::SystemdWants;
        assert!(derive_findings(&wrong_kind).is_empty());
        let mut inactive_source = map(edge(RuntimeEvidenceFreshness::Fresh));
        inactive_source.nodes[0].status = Some("inactive".into());
        assert!(derive_findings(&inactive_source).is_empty());
        let mut active_target = map(edge(RuntimeEvidenceFreshness::Fresh));
        active_target.nodes[1].status = Some("active".into());
        assert!(derive_findings(&active_target).is_empty());
        let mut non_systemd = map(edge(RuntimeEvidenceFreshness::Fresh));
        non_systemd.nodes[1].provider = RuntimeProviderKind::Docker;
        assert!(derive_findings(&non_systemd).is_empty());
    }

    #[test]
    fn finding_carries_only_the_canonical_evidence_ref_without_node_metadata() {
        let input = map(edge(RuntimeEvidenceFreshness::Fresh));
        let expected_evidence = input.edges[0].evidence_refs[0].clone();
        let findings = derive_findings(&input);
        assert_eq!(findings[0].evidence_refs, vec![expected_evidence]);
        let encoded = serde_json::to_string(&findings).unwrap();
        for forbidden in ["/secret/path", "fragmentPath"] {
            assert!(!encoded.contains(forbidden), "finding leaked {forbidden}");
        }
    }

    #[test]
    fn finding_rejects_an_unvalidated_evidence_ref() {
        let mut input = map(edge(RuntimeEvidenceFreshness::Fresh));
        input.edges[0].evidence_refs[0].provider_revision.clear();
        assert!(derive_findings(&input).is_empty());
    }

    fn docker_node(
        id: &str,
        provider: RuntimeProviderKind,
        kind: RuntimeNodeKind,
        metadata: BTreeMap<String, String>,
    ) -> RuntimeMapNode {
        RuntimeMapNode {
            id: id.into(),
            provider,
            kind,
            label: "safe Docker entity".into(),
            status: None,
            layer: None,
            metadata,
            service: None,
            package: None,
        }
    }

    fn docker_evidence(kind: RuntimeEvidenceKind, source: &str) -> RuntimeEvidenceRef {
        let summary = match kind {
            RuntimeEvidenceKind::DockerComposeDependsOn => COMPOSE_DEPENDENCY_EVIDENCE_SUMMARY,
            _ => "Docker reported a bounded runtime fact",
        };
        RuntimeEvidenceRef {
            version: 1,
            id: format!("docker_evidence_{source}"),
            provider: RuntimeEvidenceProvider::Docker,
            kind,
            assertion_kind: RuntimeEvidenceAssertionKind::Observed,
            summary: summary.into(),
            subject_ref: source.into(),
            collected_at: 1,
            provider_revision: "opaque-docker-observation".into(),
            provider_slot: None,
            freshness: RuntimeEvidenceFreshness::Fresh,
        }
    }

    fn daemon_state_map() -> RuntimeMap {
        let container = "docker_container_daemon_state";
        let risk = DOCKER_DAEMON_STATE_RISK_ID;
        RuntimeMap {
            nodes: vec![
                docker_node(
                    container,
                    RuntimeProviderKind::Docker,
                    RuntimeNodeKind::Container,
                    BTreeMap::new(),
                ),
                docker_node(
                    risk,
                    RuntimeProviderKind::Docker,
                    RuntimeNodeKind::HostRisk,
                    BTreeMap::new(),
                ),
            ],
            edges: vec![RuntimeMapEdge {
                source: container.into(),
                target: risk.into(),
                relationship: RuntimeRelationshipKind::ExposesDaemonState,
                metadata: BTreeMap::new(),
                evidence_refs: vec![RuntimeEvidenceRef {
                    summary: DOCKER_DAEMON_STATE_EVIDENCE_SUMMARY.into(),
                    ..docker_evidence(RuntimeEvidenceKind::DockerDaemonStateBindMount, container)
                }],
            }],
            ..Default::default()
        }
    }

    #[test]
    fn daemon_state_bind_mount_warning_carries_only_canonical_evidence() {
        let input = daemon_state_map();
        let findings = derive_findings(&input);
        assert_eq!(findings.len(), 1);
        let finding = &findings[0];
        assert_eq!(finding.rule_id, FindingRule::DockerDaemonStateBindMount);
        assert_eq!(finding.severity, FindingSeverity::Warning);
        assert_eq!(finding.summary, DOCKER_DAEMON_STATE_SUMMARY);
        assert_eq!(finding.recommendation, DOCKER_DAEMON_STATE_RECOMMENDATION);
        assert_eq!(finding.target_ref, DOCKER_DAEMON_STATE_RISK_ID);
        assert_eq!(finding.evidence_refs, input.edges[0].evidence_refs);
        let encoded = serde_json::to_string(finding).unwrap();
        for forbidden in ["/var/run/docker.sock", "readOnly", "mount-id"] {
            assert!(!encoded.contains(forbidden), "finding leaked {forbidden}");
        }
    }

    #[test]
    fn daemon_state_bind_mount_warning_fails_closed() {
        let mut stale = daemon_state_map();
        stale.edges[0].evidence_refs[0].freshness = RuntimeEvidenceFreshness::Stale;
        assert!(derive_findings(&stale).is_empty());

        let mut duplicate = daemon_state_map();
        duplicate.edges.push(duplicate.edges[0].clone());
        assert!(derive_findings(&duplicate).is_empty());

        let mut wrong_kind = daemon_state_map();
        wrong_kind.edges[0].evidence_refs[0].kind = RuntimeEvidenceKind::DockerVolumeMount;
        assert!(derive_findings(&wrong_kind).is_empty());

        let mut missing = daemon_state_map();
        missing.edges[0].evidence_refs.clear();
        assert!(derive_findings(&missing).is_empty());

        let mut collision = daemon_state_map();
        collision.nodes.push(collision.nodes[1].clone());
        assert!(derive_findings(&collision).is_empty());

        let mut raw_metadata = daemon_state_map();
        raw_metadata.edges[0]
            .metadata
            .insert("mountSource".into(), "/var/run/docker.sock".into());
        assert!(derive_findings(&raw_metadata).is_empty());
    }

    fn daemon_state_port_map() -> RuntimeMap {
        let container = "docker_container_daemon_state_port";
        let risk = DOCKER_DAEMON_STATE_RISK_ID;
        let listener = "network_listener_daemon_state_port";
        RuntimeMap {
            nodes: vec![
                docker_node(
                    container,
                    RuntimeProviderKind::Docker,
                    RuntimeNodeKind::Container,
                    BTreeMap::new(),
                ),
                docker_node(
                    risk,
                    RuntimeProviderKind::Docker,
                    RuntimeNodeKind::HostRisk,
                    BTreeMap::new(),
                ),
                docker_node(
                    listener,
                    RuntimeProviderKind::Network,
                    RuntimeNodeKind::NetworkListener,
                    BTreeMap::from([("port".into(), "2375:2375/tcp".into())]),
                ),
            ],
            edges: vec![
                RuntimeMapEdge {
                    source: container.into(),
                    target: risk.into(),
                    relationship: RuntimeRelationshipKind::ExposesDaemonState,
                    metadata: BTreeMap::new(),
                    evidence_refs: vec![RuntimeEvidenceRef {
                        summary: DOCKER_DAEMON_STATE_EVIDENCE_SUMMARY.into(),
                        ..docker_evidence(
                            RuntimeEvidenceKind::DockerDaemonStateBindMount,
                            container,
                        )
                    }],
                },
                RuntimeMapEdge {
                    source: container.into(),
                    target: listener.into(),
                    relationship: RuntimeRelationshipKind::Exposes,
                    metadata: BTreeMap::new(),
                    evidence_refs: vec![docker_evidence(
                        RuntimeEvidenceKind::DockerPortPublication,
                        container,
                    )],
                },
            ],
            ..Default::default()
        }
    }

    fn daemon_state_port_finding(findings: &[Finding]) -> Option<&Finding> {
        findings
            .iter()
            .find(|finding| finding.rule_id == FindingRule::DockerDaemonStateBindMountPublishesPort)
    }

    #[test]
    fn daemon_state_port_warning_requires_one_coherent_pair_and_preserves_evidence_order() {
        let input = daemon_state_port_map();
        let findings = derive_findings(&input);
        let finding = daemon_state_port_finding(&findings)
            .expect("one coherent Docker daemon-state and host-port pair warns");
        assert_eq!(finding.severity, FindingSeverity::Warning);
        assert_eq!(finding.summary, DOCKER_DAEMON_STATE_PUBLISHED_PORT_SUMMARY);
        assert_eq!(
            finding.recommendation,
            DOCKER_DAEMON_STATE_PUBLISHED_PORT_RECOMMENDATION
        );
        assert_eq!(finding.subject_ref, "docker_container_daemon_state_port");
        assert_eq!(finding.target_ref, DOCKER_DAEMON_STATE_RISK_ID);
        assert_eq!(
            finding.evidence_refs,
            vec![
                input.edges[0].evidence_refs[0].clone(),
                input.edges[1].evidence_refs[0].clone(),
            ]
        );
        assert!(finding
            .id
            .starts_with("finding_docker_daemon_state_bind_mount_publishes_port_"));
        let encoded = serde_json::to_string(finding).unwrap();
        for forbidden in ["2375", "tcp", "network_listener", "exploit", "breach"] {
            assert!(
                !encoded.contains(forbidden),
                "finding leaked or overstated {forbidden}"
            );
        }
    }

    #[test]
    fn daemon_state_port_warning_fails_closed_for_ambiguous_malformed_or_unmatched_inputs() {
        let mut stale_daemon = daemon_state_port_map();
        stale_daemon.edges[0].evidence_refs[0].freshness = RuntimeEvidenceFreshness::Stale;
        assert!(daemon_state_port_finding(&derive_findings(&stale_daemon)).is_none());

        let mut stale_port = daemon_state_port_map();
        stale_port.edges[1].evidence_refs[0].freshness = RuntimeEvidenceFreshness::Stale;
        assert!(daemon_state_port_finding(&derive_findings(&stale_port)).is_none());

        let mut duplicate_daemon = daemon_state_port_map();
        duplicate_daemon
            .edges
            .push(duplicate_daemon.edges[0].clone());
        assert!(daemon_state_port_finding(&derive_findings(&duplicate_daemon)).is_none());

        let mut duplicate_port = daemon_state_port_map();
        duplicate_port.edges.push(duplicate_port.edges[1].clone());
        assert!(daemon_state_port_finding(&derive_findings(&duplicate_port)).is_none());

        let mut malformed_daemon = daemon_state_port_map();
        let mut extra_daemon = malformed_daemon.edges[0].clone();
        extra_daemon.evidence_refs.clear();
        malformed_daemon.edges.push(extra_daemon);
        assert!(daemon_state_port_finding(&derive_findings(&malformed_daemon)).is_none());

        let mut malformed_port = daemon_state_port_map();
        let mut extra_port = malformed_port.edges[1].clone();
        extra_port.metadata.insert("unsafe".into(), "value".into());
        malformed_port.edges.push(extra_port);
        assert!(daemon_state_port_finding(&derive_findings(&malformed_port)).is_none());

        let mut mismatched_collected_at = daemon_state_port_map();
        mismatched_collected_at.edges[1].evidence_refs[0].collected_at = 2;
        assert!(daemon_state_port_finding(&derive_findings(&mismatched_collected_at)).is_none());

        let mut mismatched_revision = daemon_state_port_map();
        mismatched_revision.edges[1].evidence_refs[0].provider_revision = "other".into();
        assert!(daemon_state_port_finding(&derive_findings(&mismatched_revision)).is_none());

        let mut wrong_kind = daemon_state_port_map();
        wrong_kind.edges[1].evidence_refs[0].kind = RuntimeEvidenceKind::DockerNetworkMembership;
        assert!(daemon_state_port_finding(&derive_findings(&wrong_kind)).is_none());

        let mut wrong_source = daemon_state_port_map();
        wrong_source.edges[1].source = "docker_container_other".into();
        assert!(daemon_state_port_finding(&derive_findings(&wrong_source)).is_none());

        let mut wrong_target = daemon_state_port_map();
        wrong_target.edges[0].target = "host_risk_other".into();
        assert!(daemon_state_port_finding(&derive_findings(&wrong_target)).is_none());

        let mut private_port = daemon_state_port_map();
        private_port.nodes[2]
            .metadata
            .insert("port".into(), "2375/tcp".into());
        assert!(daemon_state_port_finding(&derive_findings(&private_port)).is_none());

        let mut invalid_port = daemon_state_port_map();
        invalid_port.nodes[2]
            .metadata
            .insert("port".into(), "0:2375/tcp".into());
        assert!(daemon_state_port_finding(&derive_findings(&invalid_port)).is_none());

        let mut node_collision = daemon_state_port_map();
        node_collision.nodes.push(node_collision.nodes[2].clone());
        assert!(daemon_state_port_finding(&derive_findings(&node_collision)).is_none());

        let mut wrong_slot = daemon_state_port_map();
        wrong_slot.edges[1].evidence_refs[0].provider_slot = Some(ProviderSlot::Systemd);
        assert!(daemon_state_port_finding(&derive_findings(&wrong_slot)).is_none());

        let mut mock_like = daemon_state_port_map();
        mock_like.edges[0].evidence_refs.clear();
        mock_like.edges[1].evidence_refs.clear();
        assert!(daemon_state_port_finding(&derive_findings(&mock_like)).is_none());
    }

    fn internal_network_port_map() -> RuntimeMap {
        let container = "docker_container_safe";
        let network = "docker_network_internal";
        let listener = "network_listener_safe";
        RuntimeMap {
            nodes: vec![
                docker_node(
                    container,
                    RuntimeProviderKind::Docker,
                    RuntimeNodeKind::Container,
                    BTreeMap::new(),
                ),
                docker_node(
                    network,
                    RuntimeProviderKind::Docker,
                    RuntimeNodeKind::DockerNetwork,
                    BTreeMap::from([("internal".into(), "true".into())]),
                ),
                docker_node(
                    listener,
                    RuntimeProviderKind::Network,
                    RuntimeNodeKind::NetworkListener,
                    BTreeMap::from([("port".into(), "8080:80/tcp".into())]),
                ),
            ],
            edges: vec![
                RuntimeMapEdge {
                    source: container.into(),
                    target: network.into(),
                    relationship: RuntimeRelationshipKind::ConnectedTo,
                    metadata: BTreeMap::new(),
                    evidence_refs: vec![docker_evidence(
                        RuntimeEvidenceKind::DockerNetworkMembership,
                        container,
                    )],
                },
                RuntimeMapEdge {
                    source: container.into(),
                    target: listener.into(),
                    relationship: RuntimeRelationshipKind::Exposes,
                    metadata: BTreeMap::new(),
                    evidence_refs: vec![docker_evidence(
                        RuntimeEvidenceKind::DockerPortPublication,
                        container,
                    )],
                },
            ],
            ..Default::default()
        }
    }

    #[test]
    fn emits_a_deterministic_advisory_with_exact_docker_evidence_pair() {
        let input = internal_network_port_map();
        let findings = derive_findings(&input);
        assert_eq!(findings.len(), 1);
        let finding = &findings[0];
        assert_eq!(
            finding.rule_id,
            FindingRule::DockerInternalNetworkMemberPublishesPort
        );
        assert_eq!(finding.severity, FindingSeverity::Advisory);
        assert_eq!(finding.summary, INTERNAL_NETWORK_PORT_SUMMARY);
        assert_eq!(finding.recommendation, INTERNAL_NETWORK_PORT_RECOMMENDATION);
        assert_eq!(finding.subject_ref, "docker_container_safe");
        assert_eq!(finding.target_ref, "docker_network_internal");
        assert_eq!(
            finding.evidence_refs,
            vec![
                input.edges[0].evidence_refs[0].clone(),
                input.edges[1].evidence_refs[0].clone(),
            ]
        );
        assert!(finding
            .id
            .starts_with("finding_docker_internal_network_member_publishes_port_"));
    }

    #[test]
    fn docker_internal_network_port_rule_fails_closed() {
        let mut stale_membership = internal_network_port_map();
        stale_membership.edges[0].evidence_refs[0].freshness = RuntimeEvidenceFreshness::Stale;
        assert!(derive_findings(&stale_membership).is_empty());

        let mut stale_port = internal_network_port_map();
        stale_port.edges[1].evidence_refs[0].freshness = RuntimeEvidenceFreshness::Stale;
        assert!(derive_findings(&stale_port).is_empty());

        let mut duplicate_port = internal_network_port_map();
        duplicate_port.edges.push(duplicate_port.edges[1].clone());
        assert!(derive_findings(&duplicate_port).is_empty());

        let mut duplicate_membership = internal_network_port_map();
        duplicate_membership
            .edges
            .push(duplicate_membership.edges[0].clone());
        assert!(derive_findings(&duplicate_membership).is_empty());

        let mut wrong_kind = internal_network_port_map();
        wrong_kind.edges[1].evidence_refs[0].kind = RuntimeEvidenceKind::DockerNetworkMembership;
        assert!(derive_findings(&wrong_kind).is_empty());

        let mut not_exactly_internal = internal_network_port_map();
        not_exactly_internal.nodes[1]
            .metadata
            .insert("internal".into(), "True".into());
        assert!(derive_findings(&not_exactly_internal).is_empty());

        let mut collision = internal_network_port_map();
        collision.nodes.push(collision.nodes[1].clone());
        assert!(derive_findings(&collision).is_empty());

        let mut wrong_listener = internal_network_port_map();
        wrong_listener.nodes[2].provider = RuntimeProviderKind::Docker;
        assert!(derive_findings(&wrong_listener).is_empty());

        let mut private_only_port = internal_network_port_map();
        private_only_port.nodes[2]
            .metadata
            .insert("port".into(), "80/tcp".into());
        assert!(derive_findings(&private_only_port).is_empty());
    }

    fn compose_dependency_map(source_status: &str, target_status: &str) -> RuntimeMap {
        let source = "docker_container_compose_source";
        let target = "docker_container_compose_target";
        let mut source_node = docker_node(
            source,
            RuntimeProviderKind::Docker,
            RuntimeNodeKind::Container,
            BTreeMap::new(),
        );
        source_node.status = Some(source_status.into());
        let mut target_node = docker_node(
            target,
            RuntimeProviderKind::Docker,
            RuntimeNodeKind::Container,
            BTreeMap::new(),
        );
        target_node.status = Some(target_status.into());
        RuntimeMap {
            nodes: vec![source_node, target_node],
            edges: vec![RuntimeMapEdge {
                source: source.into(),
                target: target.into(),
                relationship: RuntimeRelationshipKind::DependsOn,
                metadata: BTreeMap::new(),
                evidence_refs: vec![docker_evidence(
                    RuntimeEvidenceKind::DockerComposeDependsOn,
                    source,
                )],
            }],
            ..Default::default()
        }
    }

    #[test]
    fn compose_declared_target_rule_is_bounded_and_normalizes_docker_statuses() {
        for (source_status, target_status) in [
            ("Up 3 hours", "Exited (1) 2 seconds ago"),
            ("running", "stopped"),
            ("UP", "failed"),
        ] {
            let input = compose_dependency_map(source_status, target_status);
            let findings = derive_findings(&input);
            assert_eq!(findings.len(), 1, "{source_status} -> {target_status}");
            let finding = &findings[0];
            assert_eq!(
                finding.rule_id,
                FindingRule::DockerComposeDeclaredTargetNotActive
            );
            assert_eq!(finding.severity, FindingSeverity::Advisory);
            assert_eq!(finding.summary, COMPOSE_DECLARED_TARGET_NOT_ACTIVE_SUMMARY);
            assert_eq!(
                finding.recommendation,
                COMPOSE_DECLARED_TARGET_NOT_ACTIVE_RECOMMENDATION
            );
            assert_eq!(finding.subject_ref, "docker_container_compose_source");
            assert_eq!(finding.target_ref, "docker_container_compose_target");
            assert_eq!(
                finding.evidence_refs,
                vec![input.edges[0].evidence_refs[0].clone()]
            );
            assert!(finding
                .id
                .starts_with("finding_docker_compose_declared_target_not_active_"));
        }
    }

    #[test]
    fn compose_declared_target_rule_fails_closed_for_ambiguous_or_non_advisory_inputs() {
        for (source, target) in [
            ("created", "exited"),
            ("stopping", "exited"),
            ("up", "up 1 hour"),
            ("up", "starting"),
            ("up", "unknown"),
        ] {
            assert!(derive_findings(&compose_dependency_map(source, target)).is_empty());
        }
        let mut stale = compose_dependency_map("up", "exited");
        stale.edges[0].evidence_refs[0].freshness = RuntimeEvidenceFreshness::Stale;
        assert!(derive_findings(&stale).is_empty());
        let mut timed_out = compose_dependency_map("up", "failed");
        timed_out.edges[0].evidence_refs[0].freshness = RuntimeEvidenceFreshness::TimedOut;
        assert!(derive_findings(&timed_out).is_empty());
        let mut missing = compose_dependency_map("up", "exited");
        missing.edges[0].evidence_refs.clear();
        assert!(derive_findings(&missing).is_empty());
        let mut duplicate = compose_dependency_map("up", "exited");
        duplicate.edges.push(duplicate.edges[0].clone());
        assert!(derive_findings(&duplicate).is_empty());
        let mut malformed_duplicate = compose_dependency_map("up", "exited");
        let mut malformed_edge = malformed_duplicate.edges[0].clone();
        malformed_edge.evidence_refs.clear();
        malformed_duplicate.edges.push(malformed_edge);
        assert!(derive_findings(&malformed_duplicate).is_empty());
        let mut metadata = compose_dependency_map("up", "exited");
        metadata.edges[0]
            .metadata
            .insert("unsafe".into(), "value".into());
        assert!(derive_findings(&metadata).is_empty());
        let mut collision = compose_dependency_map("up", "exited");
        collision.nodes.push(collision.nodes[0].clone());
        assert!(derive_findings(&collision).is_empty());
        let mut non_docker = compose_dependency_map("up", "exited");
        non_docker.nodes[1].provider = RuntimeProviderKind::Systemd;
        assert!(derive_findings(&non_docker).is_empty());
        let mut wrong_evidence = compose_dependency_map("up", "exited");
        wrong_evidence.edges[0].evidence_refs[0].kind =
            RuntimeEvidenceKind::DockerNetworkMembership;
        assert!(derive_findings(&wrong_evidence).is_empty());
    }

    fn mutual_compose_dependency_map() -> RuntimeMap {
        let mut map = compose_dependency_map("created", "starting");
        let reverse_source = map.edges[0].target.clone();
        let reverse_target = map.edges[0].source.clone();
        map.edges.push(RuntimeMapEdge {
            source: reverse_source.clone(),
            target: reverse_target,
            relationship: RuntimeRelationshipKind::DependsOn,
            metadata: BTreeMap::new(),
            evidence_refs: vec![docker_evidence(
                RuntimeEvidenceKind::DockerComposeDependsOn,
                &reverse_source,
            )],
        });
        map
    }

    fn mutual_compose_finding(findings: &[Finding]) -> Option<&Finding> {
        findings
            .iter()
            .find(|finding| finding.rule_id == FindingRule::DockerComposeMutualDependency)
    }

    #[test]
    fn compose_mutual_dependency_is_deterministic_and_contains_only_canonical_evidence() {
        let input = mutual_compose_dependency_map();
        let finding = mutual_compose_finding(&derive_findings(&input))
            .expect("fresh, reciprocal Docker Compose declarations produce an advisory")
            .clone();
        assert_eq!(finding.severity, FindingSeverity::Advisory);
        assert_eq!(finding.summary, COMPOSE_MUTUAL_DEPENDENCY_SUMMARY);
        assert_eq!(
            finding.recommendation,
            COMPOSE_MUTUAL_DEPENDENCY_RECOMMENDATION
        );
        assert_eq!(finding.subject_ref, "docker_container_compose_source");
        assert_eq!(finding.target_ref, "docker_container_compose_target");
        assert_eq!(
            finding.id,
            format!(
                "finding_docker_compose_mutual_dependency_{}",
                collision_resistant_id_component(
                    "docker_container_compose_source\u{1f}docker_container_compose_target"
                )
            )
        );
        assert_eq!(
            finding.evidence_refs,
            vec![
                input.edges[0].evidence_refs[0].clone(),
                input.edges[1].evidence_refs[0].clone()
            ]
        );

        let mut reversed = input.clone();
        reversed.edges.reverse();
        assert_eq!(
            mutual_compose_finding(&derive_findings(&reversed)),
            Some(&finding),
            "edge ordering cannot change a canonical finding"
        );
    }

    #[test]
    fn compose_mutual_dependency_fails_closed_for_ambiguous_malformed_or_stale_inputs() {
        let mut missing_reverse = mutual_compose_dependency_map();
        missing_reverse.edges.pop();
        assert!(mutual_compose_finding(&derive_findings(&missing_reverse)).is_none());

        let mut duplicate_forward = mutual_compose_dependency_map();
        duplicate_forward
            .edges
            .push(duplicate_forward.edges[0].clone());
        assert!(mutual_compose_finding(&derive_findings(&duplicate_forward)).is_none());

        let mut malformed_reverse = mutual_compose_dependency_map();
        let mut malformed = malformed_reverse.edges[1].clone();
        malformed.evidence_refs.clear();
        malformed_reverse.edges.push(malformed);
        assert!(mutual_compose_finding(&derive_findings(&malformed_reverse)).is_none());

        for freshness in [
            RuntimeEvidenceFreshness::Stale,
            RuntimeEvidenceFreshness::TimedOut,
        ] {
            let mut input = mutual_compose_dependency_map();
            input.edges[1].evidence_refs[0].freshness = freshness;
            assert!(mutual_compose_finding(&derive_findings(&input)).is_none());
        }

        let mut metadata = mutual_compose_dependency_map();
        metadata.edges[0]
            .metadata
            .insert("unsafe".into(), "value".into());
        assert!(mutual_compose_finding(&derive_findings(&metadata)).is_none());

        let mut noncanonical_summary = mutual_compose_dependency_map();
        noncanonical_summary.edges[0].evidence_refs[0].summary = "untrusted summary".into();
        assert!(mutual_compose_finding(&derive_findings(&noncanonical_summary)).is_none());

        let mut mismatched_time = mutual_compose_dependency_map();
        mismatched_time.edges[1].evidence_refs[0].collected_at = 2;
        assert!(mutual_compose_finding(&derive_findings(&mismatched_time)).is_none());

        let mut mismatched_revision = mutual_compose_dependency_map();
        mismatched_revision.edges[1].evidence_refs[0].provider_revision = "other".into();
        assert!(mutual_compose_finding(&derive_findings(&mismatched_revision)).is_none());

        let mut wrong_provider = mutual_compose_dependency_map();
        wrong_provider.nodes[1].provider = RuntimeProviderKind::Systemd;
        assert!(mutual_compose_finding(&derive_findings(&wrong_provider)).is_none());

        let mut collision = mutual_compose_dependency_map();
        collision.nodes.push(collision.nodes[0].clone());
        assert!(mutual_compose_finding(&derive_findings(&collision)).is_none());

        let mut mock = mutual_compose_dependency_map();
        mock.source = Some(RuntimeMode::Mock);
        assert!(mutual_compose_finding(&derive_findings(&mock)).is_none());
    }

    #[test]
    fn host_publication_discriminant_accepts_only_bounded_collector_port_syntax() {
        for port in ["8080:80/tcp", "53:53/udp", "443:443/sctp"] {
            assert!(
                is_host_published_docker_port(port),
                "expected host port {port}"
            );
        }
        for port in [
            "80/tcp",
            "0:80/tcp",
            "8080:80/icmp",
            "127.0.0.1:8080:80/tcp",
            "8080:80/tcp:extra",
            "not-a-port",
        ] {
            assert!(!is_host_published_docker_port(port), "rejected port {port}");
        }
    }
}
