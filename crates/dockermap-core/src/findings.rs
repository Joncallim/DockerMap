use crate::{
    collision_resistant_id_component, Finding, FindingRule, FindingSeverity,
    RuntimeEvidenceAssertionKind, RuntimeEvidenceFreshness, RuntimeEvidenceKind,
    RuntimeEvidenceProvider, RuntimeMap, RuntimeNodeKind, RuntimeProviderKind,
    RuntimeRelationshipKind,
};
use std::collections::BTreeMap;

const SUMMARY: &str = "An active systemd service requires a target that is inactive or failed";
const RECOMMENDATION: &str =
    "Inspect the target service state and its declared dependency configuration.";
const INTERNAL_NETWORK_PORT_SUMMARY: &str =
    "A container on an internal Docker network also has a published host port.";
const INTERNAL_NETWORK_PORT_RECOMMENDATION: &str =
    "Review whether the host-port publication is intended for this internal-network service.";

/// Derive bounded, deterministic advisory findings from the already-public
/// runtime topology. The rule intentionally fails closed: it acts only on one
/// fresh V2 systemd `Requires=` declaration between uniquely identified
/// systemd services. Raw provider material is never copied into a finding.
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

fn is_docker_network(node: &crate::RuntimeMapNode) -> bool {
    node.provider == RuntimeProviderKind::Docker
        && node.kind == RuntimeNodeKind::DockerNetwork
        && node.metadata.get("internal").map(String::as_str) == Some("true")
}

fn is_docker_listener(node: &crate::RuntimeMapNode) -> bool {
    node.provider == RuntimeProviderKind::Network && node.kind == RuntimeNodeKind::NetworkListener
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
        RuntimeEvidenceRef {
            version: 1,
            id: format!("docker_evidence_{source}"),
            provider: RuntimeEvidenceProvider::Docker,
            kind,
            assertion_kind: RuntimeEvidenceAssertionKind::Observed,
            summary: "Docker reported a bounded runtime fact".into(),
            subject_ref: source.into(),
            collected_at: 1,
            provider_revision: "opaque-docker-observation".into(),
            provider_slot: None,
            freshness: RuntimeEvidenceFreshness::Fresh,
        }
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
                    BTreeMap::new(),
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
    }
}
