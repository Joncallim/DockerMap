//! Docker snapshot projections used by both live and mock collection paths.
//!
//! This module deliberately contains only deterministic derivation from a
//! `DockerSnapshot`; collection and publication remain outside the core model.

use std::collections::{BTreeMap, BTreeSet};

use crate::{
    collision_resistant_id_component, compose::is_docker_daemon_state_bind_source,
    service_entity_kind_name, ContainerRecord, DiagnosticSeverity, DockerSnapshot, GraphEdge,
    GraphNode, GraphResponse, ImageRecord, NodeKind, RelationshipKind,
    RuntimeEvidenceAssertionKind, RuntimeEvidenceFreshness, RuntimeEvidenceKind,
    RuntimeEvidenceProvider, RuntimeEvidenceRef, RuntimeMap, RuntimeMapDiagnostic, RuntimeMapEdge,
    RuntimeMapNode, RuntimeNodeKind, RuntimeNodeLayer, RuntimeProviderKind,
    RuntimeRelationshipKind, RuntimeServiceEntity, RuntimeServiceStatus,
};

pub fn derive_images(snapshot: &DockerSnapshot) -> Vec<ImageRecord> {
    let mut grouped: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut status_by_image: BTreeMap<String, String> = BTreeMap::new();

    for container in &snapshot.containers {
        grouped
            .entry(container.image.clone())
            .or_default()
            .insert(container.name.clone());
        status_by_image
            .entry(container.image.clone())
            .or_insert_with(|| container.status.clone());
    }

    grouped
        .into_iter()
        .map(|(image, containers)| ImageRecord {
            status: status_by_image
                .get(&image)
                .cloned()
                .unwrap_or_else(|| "unknown".into()),
            image,
            containers: containers.into_iter().collect(),
        })
        .collect()
}

pub fn derive_graph(snapshot: &DockerSnapshot) -> GraphResponse {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();

    for container in &snapshot.containers {
        nodes.push(GraphNode {
            id: container.id.clone(),
            kind: NodeKind::Container,
            label: container.name.clone(),
        });
    }

    for network in &snapshot.networks {
        nodes.push(GraphNode {
            id: network.id.clone(),
            kind: NodeKind::Network,
            label: network.name.clone(),
        });
    }

    for volume in &snapshot.volumes {
        nodes.push(GraphNode {
            id: volume.id.clone(),
            kind: NodeKind::Volume,
            label: volume.name.clone(),
        });
    }

    let container_aliases = ContainerAliases::from_containers(&snapshot.containers);
    let graph_ids = GraphIdentityIndex::from_snapshot(snapshot);

    let volume_by_attached_container: BTreeMap<&str, Vec<&crate::VolumeRecord>> = {
        let mut mapping: BTreeMap<&str, Vec<&crate::VolumeRecord>> = BTreeMap::new();
        for volume in &snapshot.volumes {
            for attached in &volume.attached_to {
                mapping.entry(attached.as_str()).or_default().push(volume);
            }
        }
        mapping
    };

    for container in &snapshot.containers {
        for network_id in &container.networks {
            // Network membership is also semantic topology. It must name one
            // actual network and both public graph endpoints must have unique
            // non-empty IDs; otherwise retain the nodes but omit the edge.
            if graph_ids.has_unique_container_id(container)
                && graph_ids.has_unique_network_id(network_id)
                && graph_ids.has_unique_node_id(network_id)
            {
                edges.push(GraphEdge {
                    source: container.id.clone(),
                    target: network_id.clone(),
                    relationship: RelationshipKind::ConnectedTo,
                });
            }
        }

        if container_aliases.has_unique_name(container) {
            if let Some(volumes) = volume_by_attached_container.get(container.name.as_str()) {
                for volume in volumes {
                    if graph_ids.has_unique_container_id(container)
                        && graph_ids.has_unique_node_id(volume.id.as_str())
                    {
                        edges.push(GraphEdge {
                            source: container.id.clone(),
                            target: volume.id.clone(),
                            relationship: RelationshipKind::Mounts,
                        });
                    }
                }
            }
        }

        for dependency in &container.depends_on {
            // A dependency is semantic topology, so fail closed when either
            // endpoint lacks one unambiguous, non-empty raw Docker identity.
            // Do not make a duplicate compose role/name appear to point at an
            // arbitrary container merely because a different alias happens to
            // be unique.
            if let Some(target) = container_aliases.resolve_dependency(dependency) {
                if !graph_ids.has_unique_container_id(container)
                    || !graph_ids.has_unique_container_id(target)
                    || std::ptr::eq(container, target)
                {
                    continue;
                }
                edges.push(GraphEdge {
                    source: container.id.clone(),
                    target: target.id.clone(),
                    relationship: RelationshipKind::ConnectedTo,
                });
            }
        }
    }

    nodes.sort_by_key(graph_node_sort_key);
    nodes.dedup();
    edges.sort_by_key(graph_edge_sort_key);
    edges.dedup();

    GraphResponse { nodes, edges }
}

/// The public graph uses one `id` namespace across its node kinds. A graph
/// edge is valid only if the referenced ID identifies exactly one retained
/// node, not merely one record in a particular Docker collection.
struct GraphIdentityIndex<'a> {
    node_ids: BTreeMap<&'a str, usize>,
    network_ids: BTreeMap<&'a str, usize>,
    container_ids: BTreeMap<&'a str, usize>,
}

impl<'a> GraphIdentityIndex<'a> {
    fn from_snapshot(snapshot: &'a DockerSnapshot) -> Self {
        let mut index = Self {
            node_ids: BTreeMap::new(),
            network_ids: BTreeMap::new(),
            container_ids: BTreeMap::new(),
        };
        for container in &snapshot.containers {
            Self::count(&mut index.node_ids, container.id.as_str());
            Self::count(&mut index.container_ids, container.id.as_str());
        }
        for network in &snapshot.networks {
            Self::count(&mut index.node_ids, network.id.as_str());
            Self::count(&mut index.network_ids, network.id.as_str());
        }
        for volume in &snapshot.volumes {
            Self::count(&mut index.node_ids, volume.id.as_str());
        }
        index
    }

    fn count(counts: &mut BTreeMap<&'a str, usize>, id: &'a str) {
        if !id.is_empty() {
            *counts.entry(id).or_default() += 1;
        }
    }

    fn has_unique_node_id(&self, id: &str) -> bool {
        self.node_ids.get(id) == Some(&1)
    }

    fn has_unique_network_id(&self, id: &str) -> bool {
        self.network_ids.get(id) == Some(&1)
    }

    fn has_unique_container_id(&self, container: &ContainerRecord) -> bool {
        self.container_ids.get(container.id.as_str()) == Some(&1)
            && self.has_unique_node_id(container.id.as_str())
    }
}

/// A raw Docker identity can be safely used for graph resolution only when it
/// occurs exactly once and is non-empty. `None` deliberately represents both
/// duplicate and absent values, neither of which may route a semantic edge.
struct ContainerAliases<'a> {
    ids: BTreeMap<&'a str, Option<&'a ContainerRecord>>,
    names: BTreeMap<&'a str, Option<&'a ContainerRecord>>,
    roles: BTreeMap<&'a str, Option<&'a ContainerRecord>>,
}

impl<'a> ContainerAliases<'a> {
    fn from_containers(containers: &'a [ContainerRecord]) -> Self {
        let mut aliases = Self {
            ids: BTreeMap::new(),
            names: BTreeMap::new(),
            roles: BTreeMap::new(),
        };
        for container in containers {
            Self::insert(&mut aliases.ids, container.id.as_str(), container);
            Self::insert(&mut aliases.names, container.name.as_str(), container);
            Self::insert(&mut aliases.roles, container.role.as_str(), container);
        }
        aliases
    }

    fn insert(
        aliases: &mut BTreeMap<&'a str, Option<&'a ContainerRecord>>,
        alias: &'a str,
        container: &'a ContainerRecord,
    ) {
        if alias.is_empty() {
            return;
        }
        match aliases.entry(alias) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(Some(container));
            }
            std::collections::btree_map::Entry::Occupied(mut entry) => {
                entry.insert(None);
            }
        }
    }

    fn has_unique_name(&self, container: &ContainerRecord) -> bool {
        !container.name.is_empty()
            && self
                .names
                .get(container.name.as_str())
                .and_then(|candidate| *candidate)
                .is_some_and(|candidate| std::ptr::eq(candidate, container))
    }

    fn resolve_dependency(&self, dependency: &str) -> Option<&'a ContainerRecord> {
        if dependency.is_empty() {
            return None;
        }

        let dependency_name = dependency.strip_prefix("container_").unwrap_or(dependency);
        if dependency_name.is_empty() {
            return None;
        }

        // Existing Compose semantics resolve a `container_<service>` ref by
        // service role/name and a raw value by any raw identity. Any matching
        // ambiguous alias makes the reference unsafe, even if another alias
        // would otherwise select one container.
        let lookups = [
            self.roles.get(dependency_name),
            self.names.get(dependency_name),
            self.ids.get(dependency),
        ];
        let mut candidate: Option<&ContainerRecord> = None;
        for lookup in lookups.into_iter().flatten() {
            let resolved = (*lookup)?;
            if let Some(existing) = candidate {
                if !std::ptr::eq(existing, resolved) {
                    return None;
                }
            } else {
                candidate = Some(resolved);
            }
        }
        candidate
    }
}

fn graph_node_sort_key(node: &GraphNode) -> String {
    serde_json::to_string(node).expect("graph nodes must serialize")
}

fn graph_edge_sort_key(edge: &GraphEdge) -> String {
    serde_json::to_string(edge).expect("graph edges must serialize")
}

fn duplicate_runtime_node_ids(nodes: &[RuntimeMapNode]) -> BTreeSet<String> {
    let mut counts = BTreeMap::<&str, usize>::new();
    for node in nodes {
        *counts.entry(&node.id).or_default() += 1;
    }
    counts
        .into_iter()
        .filter(|(_, count)| *count > 1)
        .map(|(id, _)| id.to_string())
        .collect()
}

/// Runtime dependency edges may only use a container identity when that
/// generated public identity names exactly one non-empty Docker record. This
/// is intentionally narrower than a best-effort Compose join: duplicate,
/// empty, and self references remain visible in inventory but cannot create a
/// misleading topology relationship.
struct RuntimeContainerIdentityIndex {
    counts: BTreeMap<String, usize>,
}

impl RuntimeContainerIdentityIndex {
    fn from_containers(containers: &[ContainerRecord]) -> Self {
        let mut counts = BTreeMap::new();
        for container in containers {
            if !container.id.is_empty() {
                *counts.entry(runtime_container_id(container)).or_default() += 1;
            }
        }
        Self { counts }
    }

    fn has_unique_id(&self, container: &ContainerRecord) -> bool {
        !container.id.is_empty() && self.counts.get(&runtime_container_id(container)) == Some(&1)
    }
}

fn runtime_container_id(container: &ContainerRecord) -> String {
    format!(
        "docker_container_{}",
        collision_resistant_id_component(&container.id)
    )
}

fn runtime_node_sort_key(node: &RuntimeMapNode) -> String {
    serde_json::to_string(node).expect("runtime nodes must serialize")
}

fn runtime_edge_sort_key(edge: &RuntimeMapEdge) -> String {
    serde_json::to_string(edge).expect("runtime edges must serialize")
}

/// Construct evidence only from already-derived runtime identities and a
/// closed fact family. No raw Docker value is copied into the evidence record:
/// labels and detail stay on their existing, independently redacted entities.
fn docker_runtime_evidence(
    snapshot: &DockerSnapshot,
    source: &str,
    target: &str,
    kind: RuntimeEvidenceKind,
    provider_revision: &str,
) -> RuntimeEvidenceRef {
    let kind_id = match kind {
        RuntimeEvidenceKind::DockerNetworkMembership => "network-membership",
        RuntimeEvidenceKind::DockerVolumeMount => "volume-mount",
        RuntimeEvidenceKind::DockerPortPublication => "port-publication",
        RuntimeEvidenceKind::DockerComposeDependsOn => "compose-depends-on",
        RuntimeEvidenceKind::DockerDaemonStateBindMount => "daemon-state-bind-mount",
        RuntimeEvidenceKind::SystemdRequires
        | RuntimeEvidenceKind::SystemdWants
        | RuntimeEvidenceKind::SystemdPartOf => {
            unreachable!("Docker evidence helper only accepts Docker evidence kinds")
        }
    };
    let summary = match kind {
        RuntimeEvidenceKind::DockerNetworkMembership => {
            "Docker reported container network membership"
        }
        RuntimeEvidenceKind::DockerVolumeMount => "Docker reported volume attachment",
        RuntimeEvidenceKind::DockerPortPublication => "Docker reported container port publication",
        RuntimeEvidenceKind::DockerComposeDependsOn => {
            "Docker recorded Compose dependency declaration"
        }
        RuntimeEvidenceKind::DockerDaemonStateBindMount => {
            "Docker reported a bind mount exposing Docker daemon state"
        }
        RuntimeEvidenceKind::SystemdRequires
        | RuntimeEvidenceKind::SystemdWants
        | RuntimeEvidenceKind::SystemdPartOf => {
            unreachable!("Docker evidence helper only accepts Docker evidence kinds")
        }
    };
    RuntimeEvidenceRef {
        version: 1,
        id: format!(
            "docker_evidence_{}_{}",
            kind_id,
            collision_resistant_id_component(&format!("{source}\u{1f}{target}"))
        ),
        provider: RuntimeEvidenceProvider::Docker,
        kind,
        assertion_kind: RuntimeEvidenceAssertionKind::Observed,
        summary: summary.into(),
        subject_ref: source.into(),
        collected_at: snapshot.last_updated,
        provider_revision: provider_revision.into(),
        provider_slot: None,
        freshness: RuntimeEvidenceFreshness::Fresh,
    }
}

/// Derive runtime topology with the daemon-owned opaque Docker observation
/// token that attests the bounded snapshot used for this map. Callers must
/// supply a nonempty opaque token; a timestamp fallback would falsely claim a
/// provider revision and is intentionally not exposed.
pub fn derive_runtime_map(
    snapshot: &DockerSnapshot,
    mut nodes: Vec<RuntimeMapNode>,
    mut edges: Vec<RuntimeMapEdge>,
    mut diagnostics: Vec<RuntimeMapDiagnostic>,
    evidence_provider_revision: &str,
) -> RuntimeMap {
    assert!(
        !evidence_provider_revision.is_empty(),
        "runtime evidence requires a nonempty opaque Docker observation token"
    );
    let container_aliases = ContainerAliases::from_containers(&snapshot.containers);
    let runtime_container_ids =
        RuntimeContainerIdentityIndex::from_containers(&snapshot.containers);
    for container in &snapshot.containers {
        let mut metadata = BTreeMap::new();
        metadata.insert("image".into(), container.image.clone());
        metadata.insert("role".into(), container.role.clone());
        metadata.insert(
            "serviceEntityKind".into(),
            service_entity_kind_name(&crate::ServiceEntityKind::Service).into(),
        );
        if !container.ports.is_empty() {
            metadata.insert("ports".into(), container.ports.join(","));
        }

        nodes.push(RuntimeMapNode {
            id: runtime_container_id(container),
            provider: RuntimeProviderKind::Docker,
            kind: RuntimeNodeKind::Container,
            label: container.name.clone(),
            status: Some(container.status.clone()),
            layer: Some(RuntimeNodeLayer::Container),
            metadata,
            service: Some(RuntimeServiceEntity::minimal(
                container.name.clone(),
                RuntimeServiceStatus::from_status_text(&container.status),
            )),
            package: None,
        });

        for network_id in &container.networks {
            let source = runtime_container_id(container);
            let target = format!(
                "docker_network_{}",
                collision_resistant_id_component(network_id)
            );
            edges.push(RuntimeMapEdge {
                evidence_refs: vec![docker_runtime_evidence(
                    snapshot,
                    &source,
                    &target,
                    RuntimeEvidenceKind::DockerNetworkMembership,
                    evidence_provider_revision,
                )],
                source,
                target,
                relationship: RuntimeRelationshipKind::ConnectedTo,
                metadata: BTreeMap::new(),
            });
        }

        for port in &container.ports {
            // A published/private port string is only an attribute of a
            // listener. It is not its identity: two distinct containers may
            // legitimately expose the same port. Include the owning container
            // identity so each recorded runtime entity has a stable ID.
            let listener_id = format!(
                "network_listener_{}_{}",
                collision_resistant_id_component(&container.id),
                collision_resistant_id_component(port)
            );
            let mut metadata = BTreeMap::new();
            metadata.insert("port".into(), port.clone());
            nodes.push(RuntimeMapNode {
                id: listener_id.clone(),
                provider: RuntimeProviderKind::Network,
                kind: RuntimeNodeKind::NetworkListener,
                label: port.clone(),
                status: Some("listening".into()),
                layer: Some(RuntimeNodeLayer::Host),
                metadata,
                service: None,
                package: None,
            });
            let source = runtime_container_id(container);
            edges.push(RuntimeMapEdge {
                evidence_refs: vec![docker_runtime_evidence(
                    snapshot,
                    &source,
                    &listener_id,
                    RuntimeEvidenceKind::DockerPortPublication,
                    evidence_provider_revision,
                )],
                source,
                target: listener_id,
                relationship: RuntimeRelationshipKind::Exposes,
                metadata: BTreeMap::new(),
            });
        }

        for dependency in &container.depends_on {
            // A Docker Compose label is a direct declaration, but it is not a
            // sufficient basis for a relationship unless both container
            // endpoints resolve uniquely. In particular, never select an
            // arbitrary duplicate role/name or turn a self/empty reference
            // into topology.
            let Some(target) = container_aliases.resolve_dependency(dependency) else {
                continue;
            };
            if !runtime_container_ids.has_unique_id(container)
                || !runtime_container_ids.has_unique_id(target)
                || std::ptr::eq(container, target)
            {
                continue;
            }
            let source = runtime_container_id(container);
            let target = runtime_container_id(target);
            if source == target {
                continue;
            }
            edges.push(RuntimeMapEdge {
                evidence_refs: vec![docker_runtime_evidence(
                    snapshot,
                    &source,
                    &target,
                    RuntimeEvidenceKind::DockerComposeDependsOn,
                    evidence_provider_revision,
                )],
                source,
                target,
                relationship: RuntimeRelationshipKind::DependsOn,
                metadata: BTreeMap::new(),
            });
        }
    }

    for network in &snapshot.networks {
        let mut metadata = BTreeMap::new();
        metadata.insert("driver".into(), network.driver.clone());
        metadata.insert("internal".into(), network.internal.to_string());
        nodes.push(RuntimeMapNode {
            id: format!(
                "docker_network_{}",
                collision_resistant_id_component(&network.id)
            ),
            provider: RuntimeProviderKind::Docker,
            kind: RuntimeNodeKind::DockerNetwork,
            label: network.name.clone(),
            status: None,
            layer: Some(RuntimeNodeLayer::Network),
            metadata,
            service: None,
            package: None,
        });
    }

    for volume in &snapshot.volumes {
        let mut metadata = BTreeMap::new();
        metadata.insert(
            "serviceEntityKind".into(),
            service_entity_kind_name(&crate::ServiceEntityKind::Storage).into(),
        );
        nodes.push(RuntimeMapNode {
            id: format!(
                "docker_volume_{}",
                collision_resistant_id_component(&volume.id)
            ),
            provider: RuntimeProviderKind::Docker,
            kind: RuntimeNodeKind::DockerVolume,
            label: volume.name.clone(),
            status: None,
            layer: Some(RuntimeNodeLayer::Storage),
            metadata,
            service: None,
            package: None,
        });

        for attached in &volume.attached_to {
            if let Some(container) = snapshot
                .containers
                .iter()
                .find(|container| container.name == *attached)
            {
                let source = runtime_container_id(container);
                let target = format!(
                    "docker_volume_{}",
                    collision_resistant_id_component(&volume.id)
                );
                edges.push(RuntimeMapEdge {
                    evidence_refs: vec![docker_runtime_evidence(
                        snapshot,
                        &source,
                        &target,
                        RuntimeEvidenceKind::DockerVolumeMount,
                        evidence_provider_revision,
                    )],
                    source,
                    target,
                    relationship: RuntimeRelationshipKind::Mounts,
                    metadata: BTreeMap::new(),
                });
            }
        }
    }

    const DOCKER_DAEMON_STATE_RISK_ID: &str = "host_risk_docker_daemon_state";
    let daemon_state_sources = snapshot
        .containers
        .iter()
        .filter(|container| {
            runtime_container_ids.has_unique_id(container)
                && container.mounts.iter().any(|mount| {
                    mount.kind == crate::ComposeMountKind::Bind
                        && mount
                            .source
                            .as_deref()
                            .is_some_and(is_docker_daemon_state_bind_source)
                })
        })
        .map(runtime_container_id)
        .collect::<BTreeSet<_>>();
    if !daemon_state_sources.is_empty()
        && !nodes
            .iter()
            .any(|node| node.id == DOCKER_DAEMON_STATE_RISK_ID)
    {
        nodes.push(RuntimeMapNode {
            id: DOCKER_DAEMON_STATE_RISK_ID.into(),
            provider: RuntimeProviderKind::Docker,
            kind: RuntimeNodeKind::HostRisk,
            label: "Docker daemon state exposure".into(),
            status: None,
            layer: Some(RuntimeNodeLayer::Host),
            metadata: BTreeMap::new(),
            service: None,
            package: None,
        });
        for source in daemon_state_sources {
            if nodes.iter().filter(|node| node.id == source).count() != 1 {
                continue;
            }
            edges.push(RuntimeMapEdge {
                evidence_refs: vec![docker_runtime_evidence(
                    snapshot,
                    &source,
                    DOCKER_DAEMON_STATE_RISK_ID,
                    RuntimeEvidenceKind::DockerDaemonStateBindMount,
                    evidence_provider_revision,
                )],
                source,
                target: DOCKER_DAEMON_STATE_RISK_ID.into(),
                relationship: RuntimeRelationshipKind::ExposesDaemonState,
                metadata: BTreeMap::new(),
            });
        }
    }

    let duplicate_node_ids = duplicate_runtime_node_ids(&nodes);
    nodes.sort_by_key(runtime_node_sort_key);
    for _ in duplicate_node_ids {
        diagnostics.push(RuntimeMapDiagnostic {
            provider: RuntimeProviderKind::Other,
            severity: DiagnosticSeverity::Warning,
            message:
                "Duplicate generated runtime topology ID; records remain visible and non-routable"
                    .into(),
        });
    }
    edges.sort_by_key(runtime_edge_sort_key);
    edges.dedup();

    RuntimeMap {
        nodes,
        edges,
        diagnostics,
        last_updated: snapshot.last_updated,
        ..Default::default()
    }
}
