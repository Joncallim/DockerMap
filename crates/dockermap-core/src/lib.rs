use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    Container,
    Network,
    Volume,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RelationshipKind {
    ConnectedTo,
    Mounts,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GraphNode {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: NodeKind,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    pub relationship: RelationshipKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GraphResponse {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContainerRecord {
    pub id: String,
    pub name: String,
    pub image: String,
    pub status: String,
    pub role: String,
    pub networks: Vec<String>,
    pub ports: Vec<String>,
    #[serde(rename = "dependsOn")]
    pub depends_on: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ImageRecord {
    pub image: String,
    pub containers: Vec<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NetworkRecord {
    pub id: String,
    pub name: String,
    pub driver: String,
    pub internal: bool,
    pub members: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VolumeRecord {
    pub id: String,
    pub name: String,
    #[serde(rename = "attachedTo")]
    pub attached_to: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DockerSnapshot {
    pub containers: Vec<ContainerRecord>,
    pub images: Vec<ImageRecord>,
    pub networks: Vec<NetworkRecord>,
    pub volumes: Vec<VolumeRecord>,
    #[serde(rename = "lastUpdated")]
    pub last_updated: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeMode {
    Docker,
    Mock,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HealthState {
    Ok,
    Degraded,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HealthResponse {
    pub status: HealthState,
    pub mode: RuntimeMode,
    #[serde(rename = "dockerReachable")]
    pub docker_reachable: bool,
    #[serde(rename = "lastUpdated")]
    pub last_updated: u64,
    #[serde(rename = "snapshotVersion")]
    pub snapshot_version: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LogEntry {
    pub id: String,
    pub timestamp: u64,
    pub container: String,
    pub level: LogLevel,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LogsResponse {
    pub service: Option<String>,
    pub entries: Vec<LogEntry>,
    #[serde(rename = "nextCursor")]
    pub next_cursor: Option<String>,
}

pub fn mock_snapshot() -> DockerSnapshot {
    DockerSnapshot {
        containers: vec![
            ContainerRecord {
                id: "container_gateway".into(),
                name: "gateway".into(),
                image: "nginx:1.27-alpine".into(),
                status: "running".into(),
                role: "edge proxy".into(),
                networks: vec!["network_edge".into(), "network_app".into()],
                ports: vec!["3233:80/tcp".into()],
                depends_on: vec!["container_api".into()],
            },
            ContainerRecord {
                id: "container_api".into(),
                name: "api".into(),
                image: "python:3.11-slim".into(),
                status: "running".into(),
                role: "api service".into(),
                networks: vec!["network_app".into(), "network_data".into()],
                ports: vec!["3233:3233/tcp".into()],
                depends_on: vec!["container_db".into(), "container_cache".into()],
            },
            ContainerRecord {
                id: "container_worker".into(),
                name: "worker".into(),
                image: "python:3.11-slim".into(),
                status: "running".into(),
                role: "background jobs".into(),
                networks: vec!["network_app".into(), "network_data".into()],
                ports: vec![],
                depends_on: vec!["container_db".into(), "container_cache".into()],
            },
            ContainerRecord {
                id: "container_db".into(),
                name: "postgres".into(),
                image: "postgres:16-alpine".into(),
                status: "running".into(),
                role: "primary database".into(),
                networks: vec!["network_data".into()],
                ports: vec!["5432:5432/tcp".into()],
                depends_on: vec![],
            },
            ContainerRecord {
                id: "container_cache".into(),
                name: "redis".into(),
                image: "redis:7-alpine".into(),
                status: "running".into(),
                role: "cache and queue broker".into(),
                networks: vec!["network_data".into()],
                ports: vec!["6379:6379/tcp".into()],
                depends_on: vec![],
            },
        ],
        images: vec![
            ImageRecord {
                image: "nginx:1.27-alpine".into(),
                containers: vec!["gateway".into()],
                status: "running".into(),
            },
            ImageRecord {
                image: "python:3.11-slim".into(),
                containers: vec!["api".into(), "worker".into()],
                status: "running".into(),
            },
            ImageRecord {
                image: "postgres:16-alpine".into(),
                containers: vec!["postgres".into()],
                status: "running".into(),
            },
            ImageRecord {
                image: "redis:7-alpine".into(),
                containers: vec!["redis".into()],
                status: "running".into(),
            },
        ],
        networks: vec![
            NetworkRecord {
                id: "network_edge".into(),
                name: "edge".into(),
                driver: "bridge".into(),
                internal: false,
                members: vec!["gateway".into()],
            },
            NetworkRecord {
                id: "network_app".into(),
                name: "application".into(),
                driver: "bridge".into(),
                internal: false,
                members: vec!["gateway".into(), "api".into(), "worker".into()],
            },
            NetworkRecord {
                id: "network_data".into(),
                name: "data".into(),
                driver: "bridge".into(),
                internal: true,
                members: vec![
                    "api".into(),
                    "worker".into(),
                    "postgres".into(),
                    "redis".into(),
                ],
            },
        ],
        volumes: vec![
            VolumeRecord {
                id: "volume_postgres_data".into(),
                name: "postgres_data".into(),
                attached_to: vec!["postgres".into()],
            },
            VolumeRecord {
                id: "volume_app_cache".into(),
                name: "app_cache".into(),
                attached_to: vec!["api".into(), "worker".into()],
            },
        ],
        last_updated: unix_timestamp_millis(),
    }
}

pub fn unix_timestamp_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after unix epoch")
        .as_millis() as u64
}

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

    let volume_by_attached_container: BTreeMap<&str, Vec<&VolumeRecord>> = {
        let mut mapping: BTreeMap<&str, Vec<&VolumeRecord>> = BTreeMap::new();
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
            let target = container_by_name.get(dependency_name).copied().or_else(|| {
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

pub fn mock_logs(
    snapshot: &DockerSnapshot,
    service: Option<&str>,
    query: Option<&str>,
) -> LogsResponse {
    let mut entries = Vec::new();
    let now = unix_timestamp_millis();
    let filter = query.map(|value| value.to_ascii_lowercase());

    for (index, container) in snapshot.containers.iter().enumerate() {
        if let Some(service_filter) = service {
            if container.name != service_filter {
                continue;
            }
        }

        let candidates = [
            (
                LogLevel::Info,
                format!("{} accepted traffic on {}", container.name, container.role),
            ),
            (
                LogLevel::Info,
                format!("{} attached to {}", container.name, container.image),
            ),
            (
                LogLevel::Warn,
                format!(
                    "{} waiting on dependencies {:?}",
                    container.name, container.depends_on
                ),
            ),
        ];

        for (offset, (level, message)) in candidates.into_iter().enumerate() {
            if let Some(filter) = &filter {
                if !message.to_ascii_lowercase().contains(filter) {
                    continue;
                }
            }

            entries.push(LogEntry {
                id: format!("{}-{}", container.id, offset),
                timestamp: now.saturating_sub(((index * 3 + offset) as u64) * 15_000),
                container: container.name.clone(),
                level,
                message,
            });
        }
    }

    entries.sort_by(|left, right| right.timestamp.cmp(&left.timestamp));

    LogsResponse {
        service: service.map(str::to_string),
        entries,
        next_cursor: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_snapshot_has_expected_shape() {
        let snapshot = mock_snapshot();
        assert_eq!(snapshot.containers.len(), 5);
        assert_eq!(snapshot.networks.len(), 3);
        assert_eq!(snapshot.volumes.len(), 2);
        assert!(snapshot.last_updated > 0);
    }

    #[test]
    fn derives_images_from_containers() {
        let snapshot = mock_snapshot();
        let images = derive_images(&snapshot);
        let python = images
            .iter()
            .find(|image| image.image == "python:3.11-slim")
            .expect("python image should exist");
        assert_eq!(
            python.containers,
            vec!["api".to_string(), "worker".to_string()]
        );
    }

    #[test]
    fn derives_graph_with_nodes_and_edges() {
        let snapshot = mock_snapshot();
        let graph = derive_graph(&snapshot);
        assert_eq!(graph.nodes.len(), 10);
        assert!(graph.edges.iter().any(|edge| edge.target == "network_data"));
        assert!(graph
            .edges
            .iter()
            .any(|edge| edge.target == "volume_postgres_data"));
    }

    #[test]
    fn filters_mock_logs_by_service_and_query() {
        let snapshot = mock_snapshot();
        let logs = mock_logs(&snapshot, Some("api"), Some("python"));
        assert!(logs.entries.iter().all(|entry| entry.container == "api"));
        assert!(!logs.entries.is_empty());
    }
}
