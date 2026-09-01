//! Docker snapshot projections used by both live and mock collection paths.
//!
//! This module deliberately contains only deterministic derivation from a
//! `DockerSnapshot`; collection and publication remain outside the core model.

use std::collections::{BTreeMap, BTreeSet};

use crate::{
    collision_resistant_id_component, service_entity_kind_name, ContainerRecord,
    DiagnosticSeverity, DockerSnapshot, GraphEdge, GraphNode, GraphResponse, ImageRecord, NodeKind,
    RelationshipKind, RuntimeMap, RuntimeMapDiagnostic, RuntimeMapEdge, RuntimeMapNode,
    RuntimeNodeKind, RuntimeNodeLayer, RuntimeProviderKind, RuntimeRelationshipKind,
    RuntimeServiceEntity, RuntimeServiceStatus,
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

    let container_by_name: BTreeMap<&str, &ContainerRecord> = snapshot
        .containers
        .iter()
        .map(|container| (container.name.as_str(), container))
        .collect();

    // Compose depends_on refs name the compose SERVICE, which the daemon
    // records as the container's `role` (the com.docker.compose.service
    // label) — live container names are project-prefixed (`immich_redis`)
    // and never match the ref directly. Resolve by role first, then by
    // name, then by full id.
    let container_by_role: BTreeMap<&str, &ContainerRecord> = snapshot
        .containers
        .iter()
        .map(|container| (container.role.as_str(), container))
        .collect();

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
            edges.push(GraphEdge {
                source: container.id.clone(),
                target: network_id.clone(),
                relationship: RelationshipKind::ConnectedTo,
            });
        }

        if let Some(volumes) = volume_by_attached_container.get(container.name.as_str()) {
            for volume in volumes {
                edges.push(GraphEdge {
                    source: container.id.clone(),
                    target: volume.id.clone(),
                    relationship: RelationshipKind::Mounts,
                });
            }
        }

        for dependency in &container.depends_on {
            let dependency_name = dependency.strip_prefix("container_").unwrap_or(dependency);
            let target = container_by_role
                .get(dependency_name)
                .copied()
                .or_else(|| container_by_name.get(dependency_name).copied())
                .or_else(|| {
                    snapshot
                        .containers
                        .iter()
                        .find(|item| item.id == *dependency)
                });

            if let Some(target) = target {
                edges.push(GraphEdge {
                    source: container.id.clone(),
                    target: target.id.clone(),
                    relationship: RelationshipKind::ConnectedTo,
                });
            }
        }
    }

    GraphResponse { nodes, edges }
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

fn runtime_node_sort_key(node: &RuntimeMapNode) -> String {
    serde_json::to_string(node).expect("runtime nodes must serialize")
}

fn runtime_edge_sort_key(edge: &RuntimeMapEdge) -> String {
    serde_json::to_string(edge).expect("runtime edges must serialize")
}

pub fn derive_runtime_map(
    snapshot: &DockerSnapshot,
    mut nodes: Vec<RuntimeMapNode>,
    mut edges: Vec<RuntimeMapEdge>,
    mut diagnostics: Vec<RuntimeMapDiagnostic>,
) -> RuntimeMap {
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
            id: format!(
                "docker_container_{}",
                collision_resistant_id_component(&container.id)
            ),
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
            edges.push(RuntimeMapEdge {
                source: format!(
                    "docker_container_{}",
                    collision_resistant_id_component(&container.id)
                ),
                target: format!(
                    "docker_network_{}",
                    collision_resistant_id_component(network_id)
                ),
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
            edges.push(RuntimeMapEdge {
                source: format!(
                    "docker_container_{}",
                    collision_resistant_id_component(&container.id)
                ),
                target: listener_id,
                relationship: RuntimeRelationshipKind::Exposes,
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
                edges.push(RuntimeMapEdge {
                    source: format!(
                        "docker_container_{}",
                        collision_resistant_id_component(&container.id)
                    ),
                    target: format!(
                        "docker_volume_{}",
                        collision_resistant_id_component(&volume.id)
                    ),
                    relationship: RuntimeRelationshipKind::Mounts,
                    metadata: BTreeMap::new(),
                });
            }
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
