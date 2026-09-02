use crate::{
    collision_resistant_id_component, Finding, FindingRule, FindingSeverity, ObservedDockerEvent,
    ObservedDockerEventCollectionState, ObservedDockerEventEvidenceSource, ObservedDockerEventKind,
    RuntimeEvidenceAssertionKind, RuntimeEvidenceFreshness, RuntimeEvidenceKind,
    RuntimeEvidenceProvider, RuntimeMap, RuntimeMode, RuntimeNodeKind, RuntimeProviderKind,
    RuntimeRelationshipKind, TemporalEvidenceKind, TemporalEvidenceRef, TemporalEvidenceSource,
    REPEATED_CONTAINER_DIED_EVENTS_WINDOW_MS,
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
const DOCKER_DAEMON_STATE_RISK_ID: &str = "host_risk_docker_daemon_state";
const DOCKER_DAEMON_STATE_EVIDENCE_SUMMARY: &str =
    "Docker reported a bind mount exposing Docker daemon state";
const REPEATED_CONTAINER_DIED_EVENTS_SUMMARY: &str =
    "A Docker container had three observed die events within five minutes.";
const REPEATED_CONTAINER_DIED_EVENTS_RECOMMENDATION: &str =
    "Review the container's recent configuration and logs to determine whether the repeated exits are expected.";
const TEMPORAL_EVENT_STREAM_TARGET: &str = "docker_event_stream";

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

    let mut daemon_state_counts = BTreeMap::<(&str, &str), usize>::new();
    for edge in &runtime_map.edges {
        if is_docker_daemon_state_shape(edge, &nodes) {
            *daemon_state_counts
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
            temporal_evidence_refs: Vec::new(),
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
            temporal_evidence_refs: Vec::new(),
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
            temporal_evidence_refs: Vec::new(),
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

/// Derive the first bounded temporal finding from previously retained,
/// sanitized Docker event observations. This intentionally does not receive a
/// runtime map: the opaque event subject is never joined to a current runtime
/// node, and the result makes no claim about crash cause, restart behavior,
/// log contents, or current container status.
pub fn derive_temporal_docker_findings(
    source: RuntimeMode,
    collection_state: ObservedDockerEventCollectionState,
    events: &[ObservedDockerEvent],
) -> Vec<Finding> {
    if source != RuntimeMode::Docker
        || collection_state != ObservedDockerEventCollectionState::Collecting
    {
        return Vec::new();
    }

    let mut candidates = BTreeMap::<String, Vec<&ObservedDockerEvent>>::new();
    for event in events {
        if event.evidence_source != ObservedDockerEventEvidenceSource::DockerEventStream
            || event.kind != ObservedDockerEventKind::ContainerDied
            || !is_valid_temporal_input(event)
        {
            continue;
        }
        candidates
            .entry(event.container_id.clone())
            .or_default()
            .push(event);
    }

    let mut findings = Vec::new();
    for (container_id, mut candidate_events) in candidates {
        candidate_events.sort_by(|left, right| {
            left.source_occurred_at_ms
                .cmp(&right.source_occurred_at_ms)
                .then_with(|| left.id.cmp(&right.id))
        });

        // Any duplicate retained ID is ambiguous hostile input. The daemon
        // journal already deduplicates it, but this core boundary also fails
        // closed rather than allowing one event to count twice.
        if candidate_events
            .windows(2)
            .any(|pair| pair[0].id == pair[1].id)
        {
            continue;
        }

        let Some(window) = candidate_events.windows(3).find(|window| {
            window[2]
                .source_occurred_at_ms
                .saturating_sub(window[0].source_occurred_at_ms)
                <= REPEATED_CONTAINER_DIED_EVENTS_WINDOW_MS
        }) else {
            continue;
        };

        let temporal_evidence_refs = window
            .iter()
            .map(|event| TemporalEvidenceRef {
                event_id: event.id.clone(),
                source: TemporalEvidenceSource::DockerEventStream,
                kind: TemporalEvidenceKind::ContainerDied,
                source_occurred_at_ms: event.source_occurred_at_ms,
                anchor_model_revision: event.anchor_model_revision.clone(),
                anchor_observation_revision: event.anchor_observation_revision.clone(),
            })
            .collect();
        findings.push(Finding {
            id: format!(
                "finding_docker_repeated_container_died_events_{}",
                collision_resistant_id_component(&container_id)
            ),
            rule_id: FindingRule::DockerRepeatedContainerDiedEvents,
            severity: FindingSeverity::Advisory,
            summary: REPEATED_CONTAINER_DIED_EVENTS_SUMMARY.into(),
            recommendation: REPEATED_CONTAINER_DIED_EVENTS_RECOMMENDATION.into(),
            subject_ref: container_id,
            target_ref: TEMPORAL_EVENT_STREAM_TARGET.into(),
            evidence_refs: Vec::new(),
            temporal_evidence_refs,
        });
    }
    findings.sort_by(|left, right| {
        left.id
            .cmp(&right.id)
            .then_with(|| left.subject_ref.cmp(&right.subject_ref))
    });
    findings
}

fn is_valid_temporal_input(event: &ObservedDockerEvent) -> bool {
    const MAX_SAFE_JS_INTEGER: u64 = 9_007_199_254_740_991;
    const MAX_REVISION_CHARS: usize = 64;
    event
        .id
        .strip_prefix("docker_event_")
        .is_some_and(|suffix| {
            suffix.len() == 64
                && suffix.bytes().all(|byte| {
                    byte.is_ascii_digit() || (byte.is_ascii_lowercase() && byte <= b'f')
                })
        })
        && event
            .container_id
            .strip_prefix("docker_container_")
            .is_some_and(|suffix| {
                suffix.len() == 64
                    && suffix.bytes().all(|byte| {
                        byte.is_ascii_digit() || (byte.is_ascii_lowercase() && byte <= b'f')
                    })
            })
        && event.source_occurred_at_ms <= MAX_SAFE_JS_INTEGER
        && !event.anchor_model_revision.is_empty()
        && event.anchor_model_revision.chars().count() <= MAX_REVISION_CHARS
        && !event.anchor_observation_revision.is_empty()
        && event.anchor_observation_revision.chars().count() <= MAX_REVISION_CHARS
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
        && is_host_published_port(node.metadata.get("port").map(String::as_str))
}

/// Docker's bounded collector format is either `private/protocol` for an
/// un-published container port or `host:private/protocol` for a host
/// publication. Accept only the latter strict grammar; the rule never emits
/// the port or a bind address, so this is a boolean discriminant only.
fn is_host_published_port(port: Option<&str>) -> bool {
    let Some((host, private_and_protocol)) = port.and_then(|value| value.split_once(':')) else {
        return false;
    };
    if host.is_empty()
        || !host.bytes().all(|byte| byte.is_ascii_digit())
        || host
            .parse::<u16>()
            .ok()
            .filter(|value| *value > 0)
            .is_none()
        || private_and_protocol.contains(':')
    {
        return false;
    }
    let Some((private, protocol)) = private_and_protocol.split_once('/') else {
        return false;
    };
    !private.is_empty()
        && private.bytes().all(|byte| byte.is_ascii_digit())
        && private
            .parse::<u16>()
            .ok()
            .filter(|value| *value > 0)
            .is_some()
        && matches!(protocol, "tcp" | "udp" | "sctp")
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

    #[test]
    fn host_publication_discriminant_accepts_only_bounded_collector_port_syntax() {
        for port in ["8080:80/tcp", "53:53/udp", "443:443/sctp"] {
            assert!(
                is_host_published_port(Some(port)),
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
            assert!(!is_host_published_port(Some(port)), "rejected port {port}");
        }
    }

    fn temporal_event(
        container_marker: char,
        event_marker: char,
        source_at_ms: u64,
    ) -> ObservedDockerEvent {
        ObservedDockerEvent {
            id: format!("docker_event_{}", event_marker.to_string().repeat(64)),
            kind: ObservedDockerEventKind::ContainerDied,
            evidence_source: ObservedDockerEventEvidenceSource::DockerEventStream,
            observed_at_ms: source_at_ms.saturating_add(1),
            source_occurred_at_ms: source_at_ms,
            container_id: format!(
                "docker_container_{}",
                container_marker.to_string().repeat(64)
            ),
            anchor_model_revision: format!("model-{event_marker}"),
            anchor_observation_revision: format!("observation-{event_marker}"),
        }
    }

    #[test]
    fn repeated_died_events_emit_one_advisory_with_the_first_chronological_window() {
        let mut events = vec![
            temporal_event('a', 'c', 400_000),
            temporal_event('a', 'a', 100_000),
            temporal_event('a', 'd', 900_001),
            temporal_event('a', 'b', 250_000),
        ];
        events.reverse();
        let findings = derive_temporal_docker_findings(
            RuntimeMode::Docker,
            ObservedDockerEventCollectionState::Collecting,
            &events,
        );
        assert_eq!(findings.len(), 1);
        let finding = &findings[0];
        assert_eq!(
            finding.rule_id,
            FindingRule::DockerRepeatedContainerDiedEvents
        );
        assert_eq!(finding.severity, FindingSeverity::Advisory);
        assert_eq!(finding.summary, REPEATED_CONTAINER_DIED_EVENTS_SUMMARY);
        assert_eq!(
            finding.recommendation,
            REPEATED_CONTAINER_DIED_EVENTS_RECOMMENDATION
        );
        assert_eq!(finding.target_ref, TEMPORAL_EVENT_STREAM_TARGET);
        assert!(finding.subject_ref.starts_with("docker_container_"));
        assert!(finding.evidence_refs.is_empty());
        assert_eq!(finding.temporal_evidence_refs.len(), 3);
        assert_eq!(
            finding
                .temporal_evidence_refs
                .iter()
                .map(|evidence| evidence.source_occurred_at_ms)
                .collect::<Vec<_>>(),
            vec![100_000, 250_000, 400_000]
        );
        assert_eq!(
            finding.temporal_evidence_refs[0].anchor_model_revision,
            "model-a"
        );
        assert_eq!(
            finding.temporal_evidence_refs[2].anchor_observation_revision,
            "observation-c"
        );
    }

    #[test]
    fn repeated_died_events_are_strictly_source_and_state_bound() {
        let events = vec![
            temporal_event('a', 'a', 0),
            temporal_event('a', 'b', 150_000),
            temporal_event('a', 'c', 300_000),
        ];
        for state in [
            ObservedDockerEventCollectionState::Connecting,
            ObservedDockerEventCollectionState::Reconnecting,
            ObservedDockerEventCollectionState::Unavailable,
        ] {
            assert!(
                derive_temporal_docker_findings(RuntimeMode::Docker, state, &events).is_empty()
            );
        }
        assert!(derive_temporal_docker_findings(
            RuntimeMode::Mock,
            ObservedDockerEventCollectionState::Collecting,
            &events,
        )
        .is_empty());
        assert_eq!(
            derive_temporal_docker_findings(
                RuntimeMode::Docker,
                ObservedDockerEventCollectionState::Collecting,
                &events,
            )
            .len(),
            1,
            "the fixed 300,000ms boundary is inclusive"
        );
    }

    #[test]
    fn repeated_died_events_fail_closed_for_wrong_or_ambiguous_input() {
        let valid = vec![
            temporal_event('a', 'a', 0),
            temporal_event('a', 'b', 100_000),
            temporal_event('a', 'c', 300_001),
        ];
        assert!(derive_temporal_docker_findings(
            RuntimeMode::Docker,
            ObservedDockerEventCollectionState::Collecting,
            &valid,
        )
        .is_empty());

        let mut wrong_kind = valid.clone();
        wrong_kind[2].source_occurred_at_ms = 200_000;
        wrong_kind[0].kind = ObservedDockerEventKind::ContainerRestarted;
        assert!(derive_temporal_docker_findings(
            RuntimeMode::Docker,
            ObservedDockerEventCollectionState::Collecting,
            &wrong_kind,
        )
        .is_empty());

        let mut wrong_source = valid.clone();
        wrong_source[2].source_occurred_at_ms = 200_000;
        wrong_source[0].evidence_source = ObservedDockerEventEvidenceSource::DockerEventStream;
        wrong_source[0].id = "docker_event_not-a-digest".into();
        assert!(derive_temporal_docker_findings(
            RuntimeMode::Docker,
            ObservedDockerEventCollectionState::Collecting,
            &wrong_source,
        )
        .is_empty());

        let mut duplicate = valid.clone();
        duplicate[2].source_occurred_at_ms = 200_000;
        duplicate[2].id = duplicate[1].id.clone();
        assert!(derive_temporal_docker_findings(
            RuntimeMode::Docker,
            ObservedDockerEventCollectionState::Collecting,
            &duplicate,
        )
        .is_empty());

        let mut invalid_anchor = valid;
        invalid_anchor[2].source_occurred_at_ms = 200_000;
        invalid_anchor[2].anchor_model_revision.clear();
        assert!(derive_temporal_docker_findings(
            RuntimeMode::Docker,
            ObservedDockerEventCollectionState::Collecting,
            &invalid_anchor,
        )
        .is_empty());
    }

    #[test]
    fn repeated_died_events_group_by_opaque_subject_and_sort_stably() {
        let events = vec![
            temporal_event('b', 'd', 1),
            temporal_event('a', 'c', 10),
            temporal_event('b', 'e', 2),
            temporal_event('a', 'a', 10),
            temporal_event('b', 'f', 3),
            temporal_event('a', 'b', 10),
        ];
        let findings = derive_temporal_docker_findings(
            RuntimeMode::Docker,
            ObservedDockerEventCollectionState::Collecting,
            &events,
        );
        assert_eq!(findings.len(), 2);
        assert!(findings[0].subject_ref < findings[1].subject_ref);
        assert_eq!(
            findings[0]
                .temporal_evidence_refs
                .iter()
                .map(|evidence| evidence.event_id.as_str())
                .collect::<Vec<_>>(),
            vec![
                format!("docker_event_{}", "a".repeat(64)),
                format!("docker_event_{}", "b".repeat(64)),
                format!("docker_event_{}", "c".repeat(64)),
            ]
        );
    }
}
