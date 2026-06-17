use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_COMPOSE_FILE_BYTES: u64 = 1_048_576;

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ComposeMountKind {
    Bind,
    NamedVolume,
    AnonymousVolume,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticSeverity {
    Info,
    Warning,
    Error,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ComposeFileOrigin {
    pub file: String,
    pub service: Option<String>,
    pub field: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ComposeDiagnostic {
    pub id: String,
    pub severity: DiagnosticSeverity,
    pub message: String,
    pub origin: ComposeFileOrigin,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ComposeMount {
    pub id: String,
    pub service: String,
    pub kind: ComposeMountKind,
    pub source: Option<String>,
    #[serde(rename = "resolvedSource")]
    pub resolved_source: Option<String>,
    pub target: String,
    #[serde(rename = "readOnly")]
    pub read_only: bool,
    pub origin: ComposeFileOrigin,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ComposeService {
    pub name: String,
    pub image: Option<String>,
    #[serde(rename = "dependsOn")]
    pub depends_on: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ComposeScan {
    pub files: Vec<String>,
    #[serde(rename = "projectRoot")]
    pub project_root: String,
    pub services: Vec<ComposeService>,
    pub mounts: Vec<ComposeMount>,
    pub diagnostics: Vec<ComposeDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ComposeNodeKind {
    Service,
    HostPath,
    ContainerPath,
    NamedVolume,
    AnonymousVolume,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ComposeRelationshipKind {
    DeclaresMount,
    MountedAt,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ComposeGraphNode {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: ComposeNodeKind,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ComposeGraphEdge {
    pub source: String,
    pub target: String,
    pub relationship: ComposeRelationshipKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ComposeGraph {
    pub nodes: Vec<ComposeGraphNode>,
    pub edges: Vec<ComposeGraphEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ComposeEditPlan {
    pub file: String,
    pub service: String,
    #[serde(rename = "mountId")]
    pub mount_id: String,
    #[serde(rename = "originalSource")]
    pub original_source: Option<String>,
    #[serde(rename = "originalTarget")]
    pub original_target: String,
    #[serde(rename = "newSource")]
    pub new_source: Option<String>,
    #[serde(rename = "newTarget")]
    pub new_target: Option<String>,
    #[serde(rename = "unifiedDiff")]
    pub unified_diff: String,
    pub diagnostics: Vec<ComposeDiagnostic>,
    #[serde(rename = "willWrite")]
    pub will_write: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeProviderKind {
    Docker,
    Compose,
    Systemd,
    ScheduledJob,
    Pm2,
    Tmux,
    Tailscale,
    Headscale,
    ReverseProxy,
    LocalDns,
    Process,
    Network,
    Kubernetes,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeNodeKind {
    Container,
    DockerNetwork,
    DockerVolume,
    SystemdService,
    ScheduledJob,
    Pm2App,
    TmuxSession,
    TailnetNode,
    ReverseProxy,
    LocalDnsResolver,
    Process,
    NetworkListener,
    OrchestratorWorkload,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeRelationshipKind {
    ConnectedTo,
    Mounts,
    Manages,
    Exposes,
    Owns,
    RelatedTo,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeMapNode {
    pub id: String,
    pub provider: RuntimeProviderKind,
    #[serde(rename = "type")]
    pub kind: RuntimeNodeKind,
    pub label: String,
    pub status: Option<String>,
    pub metadata: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeMapEdge {
    pub source: String,
    pub target: String,
    pub relationship: RuntimeRelationshipKind,
    pub metadata: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeMapDiagnostic {
    pub provider: RuntimeProviderKind,
    pub severity: DiagnosticSeverity,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeMap {
    pub nodes: Vec<RuntimeMapNode>,
    pub edges: Vec<RuntimeMapEdge>,
    pub diagnostics: Vec<RuntimeMapDiagnostic>,
    #[serde(rename = "lastUpdated")]
    pub last_updated: u64,
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

pub fn derive_runtime_map(
    snapshot: &DockerSnapshot,
    mut nodes: Vec<RuntimeMapNode>,
    mut edges: Vec<RuntimeMapEdge>,
    diagnostics: Vec<RuntimeMapDiagnostic>,
) -> RuntimeMap {
    for container in &snapshot.containers {
        let mut metadata = BTreeMap::new();
        metadata.insert("image".into(), container.image.clone());
        metadata.insert("role".into(), container.role.clone());
        if !container.ports.is_empty() {
            metadata.insert("ports".into(), container.ports.join(","));
        }

        nodes.push(RuntimeMapNode {
            id: format!("docker_container_{}", sanitize_id(&container.id)),
            provider: RuntimeProviderKind::Docker,
            kind: RuntimeNodeKind::Container,
            label: container.name.clone(),
            status: Some(container.status.clone()),
            metadata,
        });

        for network_id in &container.networks {
            edges.push(RuntimeMapEdge {
                source: format!("docker_container_{}", sanitize_id(&container.id)),
                target: format!("docker_network_{}", sanitize_id(network_id)),
                relationship: RuntimeRelationshipKind::ConnectedTo,
                metadata: BTreeMap::new(),
            });
        }

        for port in &container.ports {
            let listener_id = format!("network_listener_{}", sanitize_id(port));
            let mut metadata = BTreeMap::new();
            metadata.insert("port".into(), port.clone());
            nodes.push(RuntimeMapNode {
                id: listener_id.clone(),
                provider: RuntimeProviderKind::Network,
                kind: RuntimeNodeKind::NetworkListener,
                label: port.clone(),
                status: Some("listening".into()),
                metadata,
            });
            edges.push(RuntimeMapEdge {
                source: format!("docker_container_{}", sanitize_id(&container.id)),
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
            id: format!("docker_network_{}", sanitize_id(&network.id)),
            provider: RuntimeProviderKind::Docker,
            kind: RuntimeNodeKind::DockerNetwork,
            label: network.name.clone(),
            status: None,
            metadata,
        });
    }

    for volume in &snapshot.volumes {
        nodes.push(RuntimeMapNode {
            id: format!("docker_volume_{}", sanitize_id(&volume.id)),
            provider: RuntimeProviderKind::Docker,
            kind: RuntimeNodeKind::DockerVolume,
            label: volume.name.clone(),
            status: None,
            metadata: BTreeMap::new(),
        });

        for attached in &volume.attached_to {
            if let Some(container) = snapshot
                .containers
                .iter()
                .find(|container| container.name == *attached)
            {
                edges.push(RuntimeMapEdge {
                    source: format!("docker_container_{}", sanitize_id(&container.id)),
                    target: format!("docker_volume_{}", sanitize_id(&volume.id)),
                    relationship: RuntimeRelationshipKind::Mounts,
                    metadata: BTreeMap::new(),
                });
            }
        }
    }

    nodes.sort_by(|left, right| left.id.cmp(&right.id));
    nodes.dedup_by(|left, right| left.id == right.id);
    edges.sort_by(|left, right| {
        left.source
            .cmp(&right.source)
            .then(left.target.cmp(&right.target))
    });
    edges.dedup_by(|left, right| {
        left.source == right.source
            && left.target == right.target
            && left.relationship == right.relationship
    });

    RuntimeMap {
        nodes,
        edges,
        diagnostics,
        last_updated: snapshot.last_updated,
    }
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

pub fn discover_compose_files(project_root: impl AsRef<Path>) -> Vec<PathBuf> {
    let root = project_root.as_ref();
    [
        "compose.yaml",
        "compose.yml",
        "docker-compose.yaml",
        "docker-compose.yml",
    ]
    .into_iter()
    .map(|name| root.join(name))
    .filter(|path| path.is_file())
    .collect()
}

pub fn scan_compose_files(
    project_root: impl AsRef<Path>,
    files: &[PathBuf],
) -> Result<ComposeScan, String> {
    let project_root = project_root.as_ref();
    let mut scan = ComposeScan {
        files: files
            .iter()
            .map(|path| display_path(path))
            .collect::<Vec<_>>(),
        project_root: display_path(project_root),
        services: Vec::new(),
        mounts: Vec::new(),
        diagnostics: Vec::new(),
    };

    if files.is_empty() {
        scan.diagnostics.push(ComposeDiagnostic {
            id: "compose_no_files".into(),
            severity: DiagnosticSeverity::Warning,
            message: "No Compose files were discovered or supplied.".into(),
            origin: ComposeFileOrigin {
                file: display_path(project_root),
                service: None,
                field: "files".into(),
            },
        });
        return Ok(scan);
    }

    for file in files {
        let metadata = fs::metadata(file)
            .map_err(|error| format!("failed to inspect {}: {error}", file.display()))?;
        if metadata.len() > MAX_COMPOSE_FILE_BYTES {
            return Err(format!(
                "compose file `{}` is too large; limit is {MAX_COMPOSE_FILE_BYTES} bytes",
                file.display()
            ));
        }
        let content = fs::read_to_string(file)
            .map_err(|error| format!("failed to read {}: {error}", file.display()))?;
        parse_compose_file(file, &content, &mut scan);
    }

    validate_compose_scan(&mut scan);
    Ok(scan)
}

pub fn derive_compose_graph(scan: &ComposeScan) -> ComposeGraph {
    let mut nodes_by_id: BTreeMap<String, ComposeGraphNode> = BTreeMap::new();
    let mut edges = Vec::new();

    for service in &scan.services {
        let id = compose_service_node_id(&service.name);
        nodes_by_id.entry(id.clone()).or_insert(ComposeGraphNode {
            id,
            kind: ComposeNodeKind::Service,
            label: service.name.clone(),
        });
    }

    for mount in &scan.mounts {
        let service_id = compose_service_node_id(&mount.service);
        nodes_by_id
            .entry(service_id.clone())
            .or_insert(ComposeGraphNode {
                id: service_id.clone(),
                kind: ComposeNodeKind::Service,
                label: mount.service.clone(),
            });

        let target_id = format!(
            "compose_container_path_{}_{}",
            sanitize_id(&mount.service),
            sanitize_id(&mount.target)
        );
        nodes_by_id
            .entry(target_id.clone())
            .or_insert(ComposeGraphNode {
                id: target_id.clone(),
                kind: ComposeNodeKind::ContainerPath,
                label: format!("{}:{}", mount.service, mount.target),
            });
        edges.push(ComposeGraphEdge {
            source: service_id,
            target: target_id.clone(),
            relationship: ComposeRelationshipKind::DeclaresMount,
        });

        let source_node = match mount.kind {
            ComposeMountKind::Bind => mount
                .resolved_source
                .as_ref()
                .or(mount.source.as_ref())
                .map(|source| {
                    let id = format!("compose_host_path_{}", sanitize_id(source));
                    (id, ComposeNodeKind::HostPath, source.clone())
                }),
            ComposeMountKind::NamedVolume => mount.source.as_ref().map(|source| {
                let id = format!("compose_named_volume_{}", sanitize_id(source));
                (id, ComposeNodeKind::NamedVolume, source.clone())
            }),
            ComposeMountKind::AnonymousVolume => Some((
                format!("compose_anonymous_volume_{}", sanitize_id(&mount.id)),
                ComposeNodeKind::AnonymousVolume,
                "anonymous volume".into(),
            )),
            ComposeMountKind::Unsupported => None,
        };

        if let Some((source_id, kind, label)) = source_node {
            nodes_by_id
                .entry(source_id.clone())
                .or_insert(ComposeGraphNode {
                    id: source_id.clone(),
                    kind,
                    label,
                });
            edges.push(ComposeGraphEdge {
                source: source_id,
                target: target_id,
                relationship: ComposeRelationshipKind::MountedAt,
            });
        }
    }

    ComposeGraph {
        nodes: nodes_by_id.into_values().collect(),
        edges,
    }
}

pub fn plan_compose_mount_edit(
    file: &Path,
    content: &str,
    mount: &ComposeMount,
    new_source: Option<&str>,
    new_target: Option<&str>,
) -> ComposeEditPlan {
    let mut diagnostics = Vec::new();
    let clean_source = new_source.map(str::trim).filter(|value| !value.is_empty());
    let clean_target = new_target.map(str::trim).filter(|value| !value.is_empty());

    if clean_source.is_none() && clean_target.is_none() {
        diagnostics.push(ComposeDiagnostic {
            id: "edit_noop".into(),
            severity: DiagnosticSeverity::Error,
            message: "Edit plan requires a new source, target, or both.".into(),
            origin: mount.origin.clone(),
        });
    }

    if clean_source.is_some() && !matches!(mount.kind, ComposeMountKind::Bind) {
        diagnostics.push(ComposeDiagnostic {
            id: "edit_source_requires_bind".into(),
            severity: DiagnosticSeverity::Blocked,
            message: "Only bind mount sources can be changed by this dry-run planner.".into(),
            origin: mount.origin.clone(),
        });
    }

    if let Some(target) = clean_target {
        if target.contains('\0') || !looks_like_container_path(target) {
            diagnostics.push(ComposeDiagnostic {
                id: "edit_invalid_target".into(),
                severity: DiagnosticSeverity::Blocked,
                message: "New mount target must be an absolute container path.".into(),
                origin: mount.origin.clone(),
            });
        }
    }

    if let Some(source) = clean_source {
        if source.contains('\0') {
            diagnostics.push(ComposeDiagnostic {
                id: "edit_invalid_source".into(),
                severity: DiagnosticSeverity::Blocked,
                message: "New mount source contains a NUL byte.".into(),
                origin: mount.origin.clone(),
            });
        }
    }

    let mut planned = content.to_string();
    if diagnostics
        .iter()
        .any(|diagnostic| matches!(diagnostic.severity, DiagnosticSeverity::Blocked))
    {
        return edit_plan(
            file,
            mount,
            clean_source,
            clean_target,
            String::new(),
            diagnostics,
        );
    }

    if let Some(source) = clean_source {
        if has_parent_traversal(Path::new(source)) {
            diagnostics.push(ComposeDiagnostic {
                id: "edit_source_parent_traversal".into(),
                severity: DiagnosticSeverity::Blocked,
                message: "New mount source must not contain parent traversal.".into(),
                origin: mount.origin.clone(),
            });
        }

        if let Some(original) = &mount.source {
            planned = replace_mount_line_token(
                &planned,
                mount,
                original,
                source,
                "edit_original_source_not_found",
                "Original mount source could not be uniquely found on the mount declaration line.",
                &mut diagnostics,
            );
        } else {
            diagnostics.push(ComposeDiagnostic {
                id: "edit_missing_original_source".into(),
                severity: DiagnosticSeverity::Blocked,
                message: "Mount has no original source to replace.".into(),
                origin: mount.origin.clone(),
            });
        }
    }

    if let Some(target) = clean_target {
        planned = replace_mount_line_token(
            &planned,
            mount,
            &mount.target,
            target,
            "edit_original_target_not_found",
            "Original mount target could not be uniquely found on the mount declaration line.",
            &mut diagnostics,
        );
    }

    let diff = if diagnostics
        .iter()
        .any(|diagnostic| matches!(diagnostic.severity, DiagnosticSeverity::Blocked))
        || planned == content
    {
        String::new()
    } else {
        unified_diff(&display_path(file), content, &planned)
    };

    edit_plan(file, mount, clean_source, clean_target, diff, diagnostics)
}

fn replace_mount_line_token(
    content: &str,
    mount: &ComposeMount,
    old: &str,
    new: &str,
    diagnostic_id: &str,
    diagnostic_message: &str,
    diagnostics: &mut Vec<ComposeDiagnostic>,
) -> String {
    let lines = content.lines().collect::<Vec<_>>();
    let candidates = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| line.contains(old) && line.contains(&mount.target))
        .map(|(index, _)| index)
        .collect::<Vec<_>>();

    if candidates.len() != 1 {
        diagnostics.push(ComposeDiagnostic {
            id: diagnostic_id.into(),
            severity: DiagnosticSeverity::Blocked,
            message: diagnostic_message.into(),
            origin: mount.origin.clone(),
        });
        return content.to_string();
    }

    let mut output = String::new();
    let had_trailing_newline = content.ends_with('\n');
    for (index, line) in lines.iter().enumerate() {
        if index > 0 {
            output.push('\n');
        }
        if index == candidates[0] {
            output.push_str(&line.replacen(old, new, 1));
        } else {
            output.push_str(line);
        }
    }
    if had_trailing_newline {
        output.push('\n');
    }
    output
}

fn parse_compose_file(file: &Path, content: &str, scan: &mut ComposeScan) {
    let base_dir = file.parent().unwrap_or_else(|| Path::new("."));
    let document = match yaml_serde::from_str::<yaml_serde::Value>(content) {
        Ok(value) => value,
        Err(error) => {
            scan.diagnostics.push(ComposeDiagnostic {
                id: "compose_yaml_parse_error".into(),
                severity: DiagnosticSeverity::Blocked,
                message: format!("Compose YAML could not be parsed: {error}"),
                origin: origin(file, None, "document"),
            });
            return;
        }
    };

    let Some(services) = mapping_get(&document, "services").and_then(|value| value.as_mapping())
    else {
        scan.diagnostics.push(ComposeDiagnostic {
            id: "compose_missing_services".into(),
            severity: DiagnosticSeverity::Error,
            message: "Compose file does not contain a services mapping.".into(),
            origin: origin(file, None, "services"),
        });
        return;
    };

    for (service_key, service_value) in services {
        let Some(service_name) = service_key.as_str() else {
            scan.diagnostics.push(ComposeDiagnostic {
                id: "compose_non_string_service_name".into(),
                severity: DiagnosticSeverity::Error,
                message: "Service names must be strings.".into(),
                origin: origin(file, None, "services"),
            });
            continue;
        };

        let image = mapping_get(service_value, "image")
            .and_then(|value| value.as_str())
            .map(str::to_string);
        let depends_on = parse_depends_on(mapping_get(service_value, "depends_on"));
        scan.services.push(ComposeService {
            name: service_name.to_string(),
            image,
            depends_on,
        });

        let Some(volumes) = mapping_get(service_value, "volumes") else {
            continue;
        };

        let Some(items) = volumes.as_sequence() else {
            scan.diagnostics.push(ComposeDiagnostic {
                id: "compose_invalid_volumes".into(),
                severity: DiagnosticSeverity::Error,
                message: "Service volumes must be a sequence.".into(),
                origin: origin(file, Some(service_name), "services.volumes"),
            });
            continue;
        };

        for (index, item) in items.iter().enumerate() {
            match parse_mount(file, base_dir, service_name, index, item) {
                Ok(mount) => scan.mounts.push(mount),
                Err(diagnostic) => scan.diagnostics.push(*diagnostic),
            }
        }
    }
}

fn parse_mount(
    file: &Path,
    base_dir: &Path,
    service_name: &str,
    index: usize,
    item: &yaml_serde::Value,
) -> Result<ComposeMount, Box<ComposeDiagnostic>> {
    let field = format!("services.{service_name}.volumes[{index}]");
    let mount_origin = origin(file, Some(service_name), &field);

    if let Some(short) = item.as_str() {
        return parse_short_mount(file, base_dir, service_name, index, short);
    }

    let Some(mapping) = item.as_mapping() else {
        return Err(Box::new(ComposeDiagnostic {
            id: "compose_unsupported_mount".into(),
            severity: DiagnosticSeverity::Error,
            message: "Volume entries must be strings or mappings.".into(),
            origin: mount_origin,
        }));
    };

    let mount_type = mapping
        .get(yaml_serde::Value::String("type".into()))
        .and_then(|value| value.as_str())
        .unwrap_or("volume");
    let source = mapping
        .get(yaml_serde::Value::String("source".into()))
        .or_else(|| mapping.get(yaml_serde::Value::String("src".into())))
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let Some(target) = mapping
        .get(yaml_serde::Value::String("target".into()))
        .or_else(|| mapping.get(yaml_serde::Value::String("dst".into())))
        .or_else(|| mapping.get(yaml_serde::Value::String("destination".into())))
        .and_then(|value| value.as_str())
    else {
        return Err(Box::new(ComposeDiagnostic {
            id: "compose_mount_missing_target".into(),
            severity: DiagnosticSeverity::Error,
            message: "Volume mapping is missing a target path.".into(),
            origin: mount_origin,
        }));
    };

    let read_only = mapping
        .get(yaml_serde::Value::String("read_only".into()))
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let kind = match mount_type {
        "bind" => ComposeMountKind::Bind,
        "volume" if source.is_some() => ComposeMountKind::NamedVolume,
        "volume" => ComposeMountKind::AnonymousVolume,
        _ => ComposeMountKind::Unsupported,
    };
    let resolved_source = resolve_source(base_dir, &kind, source.as_deref());

    Ok(ComposeMount {
        id: format!("{}:{service_name}:{index}", display_path(file)),
        service: service_name.to_string(),
        kind,
        source,
        resolved_source,
        target: target.to_string(),
        read_only,
        origin: mount_origin,
    })
}

fn parse_short_mount(
    file: &Path,
    base_dir: &Path,
    service_name: &str,
    index: usize,
    raw: &str,
) -> Result<ComposeMount, Box<ComposeDiagnostic>> {
    let parts = split_short_volume(raw);
    let field = format!("services.{service_name}.volumes[{index}]");
    let mount_origin = origin(file, Some(service_name), &field);

    if parts.is_empty() || parts.len() > 3 {
        return Err(Box::new(ComposeDiagnostic {
            id: "compose_invalid_short_mount".into(),
            severity: DiagnosticSeverity::Error,
            message: "Short volume syntax must be target, source:target, or source:target:mode."
                .into(),
            origin: mount_origin,
        }));
    }

    let (source, target, mode) = match parts.as_slice() {
        [target] => (None, (*target).to_string(), None),
        [source, target] => (Some((*source).to_string()), (*target).to_string(), None),
        [source, target, mode] => (
            Some((*source).to_string()),
            (*target).to_string(),
            Some((*mode).to_string()),
        ),
        _ => unreachable!("parts length checked above"),
    };

    let read_only = mode
        .as_deref()
        .map(|value| {
            value
                .split(',')
                .any(|part| part == "ro" || part == "readonly")
        })
        .unwrap_or(false);
    let kind = classify_short_source(source.as_deref());
    let resolved_source = resolve_source(base_dir, &kind, source.as_deref());

    Ok(ComposeMount {
        id: format!("{}:{service_name}:{index}", display_path(file)),
        service: service_name.to_string(),
        kind,
        source,
        resolved_source,
        target,
        read_only,
        origin: mount_origin,
    })
}

fn validate_compose_scan(scan: &mut ComposeScan) {
    let mut targets_by_service: BTreeMap<(String, String), Vec<ComposeFileOrigin>> =
        BTreeMap::new();

    for mount in &scan.mounts {
        if mount.target.trim().is_empty() || !looks_like_container_path(&mount.target) {
            scan.diagnostics.push(ComposeDiagnostic {
                id: "compose_invalid_container_target".into(),
                severity: DiagnosticSeverity::Error,
                message: format!(
                    "Mount target `{}` is not an absolute container path.",
                    mount.target
                ),
                origin: mount.origin.clone(),
            });
        }

        targets_by_service
            .entry((mount.service.clone(), mount.target.clone()))
            .or_default()
            .push(mount.origin.clone());

        if matches!(mount.kind, ComposeMountKind::Unsupported) {
            scan.diagnostics.push(ComposeDiagnostic {
                id: "compose_unsupported_mount_type".into(),
                severity: DiagnosticSeverity::Warning,
                message: "Unsupported mount type was preserved but cannot be validated yet.".into(),
                origin: mount.origin.clone(),
            });
        }

        if let Some(source) = &mount.source {
            if source.contains("${") || source.contains('$') {
                scan.diagnostics.push(ComposeDiagnostic {
                    id: "compose_unresolved_variable".into(),
                    severity: DiagnosticSeverity::Warning,
                    message: format!("Mount source `{source}` contains an unresolved variable."),
                    origin: mount.origin.clone(),
                });
            }

            if source.contains('\0') {
                scan.diagnostics.push(ComposeDiagnostic {
                    id: "compose_invalid_source_path".into(),
                    severity: DiagnosticSeverity::Blocked,
                    message: "Mount source contains a NUL byte.".into(),
                    origin: mount.origin.clone(),
                });
            }
        }

        if matches!(mount.kind, ComposeMountKind::Bind) {
            if let Some(resolved) = &mount.resolved_source {
                let path = Path::new(resolved);
                if has_parent_traversal(path) {
                    scan.diagnostics.push(ComposeDiagnostic {
                        id: "compose_parent_traversal".into(),
                        severity: DiagnosticSeverity::Warning,
                        message: format!(
                            "Bind source `{resolved}` traverses outside its compose directory."
                        ),
                        origin: mount.origin.clone(),
                    });
                }

                match fs::symlink_metadata(path) {
                    Ok(metadata) if metadata.file_type().is_symlink() => {
                        scan.diagnostics.push(ComposeDiagnostic {
                            id: "compose_bind_source_symlink".into(),
                            severity: DiagnosticSeverity::Warning,
                            message: format!("Bind source `{resolved}` is a symlink; DockerMap will not follow it during validation."),
                            origin: mount.origin.clone(),
                        });
                    }
                    Ok(_) => {}
                    Err(_) => {
                        scan.diagnostics.push(ComposeDiagnostic {
                            id: "compose_missing_bind_source".into(),
                            severity: DiagnosticSeverity::Warning,
                            message: format!(
                                "Bind source `{resolved}` does not exist on the host."
                            ),
                            origin: mount.origin.clone(),
                        });
                    }
                }
            }
        }
    }

    for ((service, target), origins) in targets_by_service {
        if origins.len() > 1 {
            for origin in origins {
                scan.diagnostics.push(ComposeDiagnostic {
                    id: "compose_duplicate_target".into(),
                    severity: DiagnosticSeverity::Error,
                    message: format!(
                        "Service `{service}` declares multiple mounts for `{target}`."
                    ),
                    origin,
                });
            }
        }
    }
}

fn parse_depends_on(value: Option<&yaml_serde::Value>) -> Vec<String> {
    match value {
        Some(yaml_serde::Value::Sequence(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
        Some(yaml_serde::Value::Mapping(mapping)) => mapping
            .keys()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    }
}

fn split_short_volume(raw: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0;
    for (index, ch) in raw.char_indices() {
        if ch != ':' {
            continue;
        }
        if index == 1 && raw.as_bytes().first().is_some_and(u8::is_ascii_alphabetic) {
            continue;
        }
        parts.push(&raw[start..index]);
        start = index + 1;
    }
    parts.push(&raw[start..]);
    parts
}

fn classify_short_source(source: Option<&str>) -> ComposeMountKind {
    match source {
        None => ComposeMountKind::AnonymousVolume,
        Some(value) if looks_like_host_path(value) => ComposeMountKind::Bind,
        Some(_) => ComposeMountKind::NamedVolume,
    }
}

fn resolve_source(
    base_dir: &Path,
    kind: &ComposeMountKind,
    source: Option<&str>,
) -> Option<String> {
    let source = source?;
    if !matches!(kind, ComposeMountKind::Bind) {
        return None;
    }

    let interpolated = interpolate_default(source);
    let source_path = Path::new(&interpolated);
    let resolved = if source_path.is_absolute() || is_windows_absolute_path(&interpolated) {
        PathBuf::from(interpolated)
    } else {
        base_dir.join(interpolated)
    };
    Some(display_path(&normalize_lexical(&resolved)))
}

fn interpolate_default(value: &str) -> String {
    let Some(start) = value.find("${") else {
        return value.to_string();
    };
    let Some(end_offset) = value[start + 2..].find('}') else {
        return value.to_string();
    };
    let end = start + 2 + end_offset;
    let expression = &value[start + 2..end];
    let default = expression
        .split_once(":-")
        .or_else(|| expression.split_once('-'))
        .map(|(_, default)| default);

    if let Some(default) = default {
        let mut output = String::new();
        output.push_str(&value[..start]);
        output.push_str(default);
        output.push_str(&value[end + 1..]);
        output
    } else {
        value.to_string()
    }
}

fn looks_like_host_path(value: &str) -> bool {
    value.starts_with('.')
        || value.starts_with('/')
        || value.starts_with('~')
        || value.starts_with('\\')
        || is_windows_absolute_path(value)
}

fn looks_like_container_path(value: &str) -> bool {
    value.starts_with('/') || is_windows_absolute_path(value)
}

fn is_windows_absolute_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

fn has_parent_traversal(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, Component::ParentDir))
}

fn normalize_lexical(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn mapping_get<'a>(value: &'a yaml_serde::Value, key: &str) -> Option<&'a yaml_serde::Value> {
    value
        .as_mapping()?
        .get(yaml_serde::Value::String(key.to_string()))
}

fn origin(file: &Path, service: Option<&str>, field: &str) -> ComposeFileOrigin {
    ComposeFileOrigin {
        file: display_path(file),
        service: service.map(str::to_string),
        field: field.to_string(),
    }
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn edit_plan(
    file: &Path,
    mount: &ComposeMount,
    new_source: Option<&str>,
    new_target: Option<&str>,
    unified_diff: String,
    diagnostics: Vec<ComposeDiagnostic>,
) -> ComposeEditPlan {
    ComposeEditPlan {
        file: display_path(file),
        service: mount.service.clone(),
        mount_id: mount.id.clone(),
        original_source: mount.source.clone(),
        original_target: mount.target.clone(),
        new_source: new_source.map(str::to_string),
        new_target: new_target.map(str::to_string),
        unified_diff,
        diagnostics,
        will_write: false,
    }
}

fn unified_diff(file: &str, original: &str, planned: &str) -> String {
    let mut output = format!("--- {file}\n+++ {file} (dry-run)\n");
    let original_lines = original.lines().collect::<Vec<_>>();
    let planned_lines = planned.lines().collect::<Vec<_>>();
    let max_len = original_lines.len().max(planned_lines.len());

    for index in 0..max_len {
        match (original_lines.get(index), planned_lines.get(index)) {
            (Some(left), Some(right)) if left == right => {
                output.push(' ');
                output.push_str(left);
                output.push('\n');
            }
            (Some(left), Some(right)) => {
                output.push('-');
                output.push_str(left);
                output.push('\n');
                output.push('+');
                output.push_str(right);
                output.push('\n');
            }
            (Some(left), None) => {
                output.push('-');
                output.push_str(left);
                output.push('\n');
            }
            (None, Some(right)) => {
                output.push('+');
                output.push_str(right);
                output.push('\n');
            }
            (None, None) => {}
        }
    }

    output
}

fn compose_service_node_id(service: &str) -> String {
    format!("compose_service_{}", sanitize_id(service))
}

fn sanitize_id(value: &str) -> String {
    let mut output = String::new();
    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            output.push(character.to_ascii_lowercase());
        } else {
            output.push('_');
        }
    }
    output.trim_matches('_').to_string()
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

    #[test]
    fn derives_runtime_map_from_docker_snapshot() {
        let snapshot = mock_snapshot();
        let runtime_map = derive_runtime_map(&snapshot, Vec::new(), Vec::new(), Vec::new());

        assert!(runtime_map
            .nodes
            .iter()
            .any(|node| node.provider == RuntimeProviderKind::Docker
                && node.kind == RuntimeNodeKind::Container
                && node.label == "api"));
        assert!(runtime_map
            .nodes
            .iter()
            .any(|node| node.kind == RuntimeNodeKind::DockerNetwork));
        assert!(runtime_map
            .edges
            .iter()
            .any(|edge| edge.relationship == RuntimeRelationshipKind::ConnectedTo));
    }

    #[test]
    fn scans_compose_fixture_mounts_and_diagnostics() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("tests/fixtures/compose");
        let file = root.join("path-mapping.compose.yaml");
        let scan = scan_compose_files(&root, &[file]).expect("fixture should scan");

        assert_eq!(scan.services.len(), 2);
        assert_eq!(scan.mounts.len(), 7);
        assert!(scan.mounts.iter().any(|mount| {
            mount.service == "api"
                && mount.kind == ComposeMountKind::Bind
                && mount.target == "/workspace/src"
        }));
        assert!(scan.mounts.iter().any(|mount| {
            mount.service == "api"
                && mount.kind == ComposeMountKind::NamedVolume
                && mount.source.as_deref() == Some("api-cache")
        }));
        assert!(scan
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.id == "compose_missing_bind_source"));
    }

    #[test]
    fn handles_windows_drive_short_volume_syntax() {
        let parts = split_short_volume(r"C:\Users\me\project:/workspace:ro");
        assert_eq!(parts, vec![r"C:\Users\me\project", "/workspace", "ro"]);
    }

    #[test]
    fn reports_duplicate_container_targets() {
        let root = PathBuf::from("/tmp/dockermap-test");
        let file = root.join("compose.yaml");
        let yaml = r#"
services:
  api:
    volumes:
      - ./a:/workspace
      - ./b:/workspace
"#;
        let mut scan = ComposeScan {
            files: vec![display_path(&file)],
            project_root: display_path(&root),
            services: Vec::new(),
            mounts: Vec::new(),
            diagnostics: Vec::new(),
        };
        parse_compose_file(&file, yaml, &mut scan);
        validate_compose_scan(&mut scan);

        assert_eq!(
            scan.diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.id == "compose_duplicate_target")
                .count(),
            2
        );
    }

    #[test]
    fn rejects_oversized_compose_file_before_parsing() {
        let root = std::env::temp_dir().join(format!(
            "dockermap-oversized-compose-{}",
            unix_timestamp_millis()
        ));
        std::fs::create_dir_all(&root).expect("temp dir should be created");
        let file = root.join("compose.yaml");
        std::fs::write(&file, vec![b'a'; (MAX_COMPOSE_FILE_BYTES + 1) as usize])
            .expect("oversized fixture should be written");

        let error = scan_compose_files(&root, std::slice::from_ref(&file))
            .expect_err("oversized file should be rejected");
        assert!(error.contains("too large"));

        let _ = std::fs::remove_file(file);
        let _ = std::fs::remove_dir(root);
    }

    #[test]
    fn derives_compose_graph_from_scan() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("tests/fixtures/compose");
        let file = root.join("path-mapping.compose.yaml");
        let scan = scan_compose_files(&root, &[file]).expect("fixture should scan");
        let graph = derive_compose_graph(&scan);

        assert!(graph
            .nodes
            .iter()
            .any(|node| node.kind == ComposeNodeKind::Service && node.label == "api"));
        assert!(graph
            .nodes
            .iter()
            .any(|node| node.kind == ComposeNodeKind::HostPath));
        assert!(graph
            .nodes
            .iter()
            .any(|node| node.kind == ComposeNodeKind::NamedVolume));
        assert!(graph
            .edges
            .iter()
            .any(|edge| edge.relationship == ComposeRelationshipKind::MountedAt));
    }

    #[test]
    fn plans_bind_mount_edit_without_writing() {
        let file = PathBuf::from("/tmp/compose.yaml");
        let content = r#"
services:
  api:
    volumes:
      - ./src:/workspace/src:ro
"#;
        let mut scan = ComposeScan {
            files: vec![display_path(&file)],
            project_root: "/tmp".into(),
            services: Vec::new(),
            mounts: Vec::new(),
            diagnostics: Vec::new(),
        };
        parse_compose_file(&file, content, &mut scan);
        validate_compose_scan(&mut scan);

        let plan = plan_compose_mount_edit(
            &file,
            content,
            &scan.mounts[0],
            Some("./app"),
            Some("/workspace/app"),
        );

        assert!(!plan.will_write);
        assert!(plan
            .unified_diff
            .contains("-      - ./src:/workspace/src:ro"));
        assert!(plan
            .unified_diff
            .contains("+      - ./app:/workspace/app:ro"));
    }

    #[test]
    fn blocks_parent_traversal_in_planned_source() {
        let file = PathBuf::from("/tmp/compose.yaml");
        let content = r#"
services:
  api:
    volumes:
      - ./src:/workspace/src:ro
"#;
        let mut scan = ComposeScan {
            files: vec![display_path(&file)],
            project_root: "/tmp".into(),
            services: Vec::new(),
            mounts: Vec::new(),
            diagnostics: Vec::new(),
        };
        parse_compose_file(&file, content, &mut scan);
        validate_compose_scan(&mut scan);

        let plan =
            plan_compose_mount_edit(&file, content, &scan.mounts[0], Some("../secrets"), None);

        assert!(plan.unified_diff.is_empty());
        assert!(plan
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.id == "edit_source_parent_traversal"));
    }

    #[test]
    fn blocks_ambiguous_mount_line_replacements() {
        let file = PathBuf::from("/tmp/compose.yaml");
        let content = r#"
services:
  api:
    environment:
      NOTE: "./src:/workspace/src appears in documentation"
    volumes:
      - ./src:/workspace/src:ro
"#;
        let mut scan = ComposeScan {
            files: vec![display_path(&file)],
            project_root: "/tmp".into(),
            services: Vec::new(),
            mounts: Vec::new(),
            diagnostics: Vec::new(),
        };
        parse_compose_file(&file, content, &mut scan);
        validate_compose_scan(&mut scan);

        let plan = plan_compose_mount_edit(&file, content, &scan.mounts[0], Some("./app"), None);

        assert!(plan.unified_diff.is_empty());
        assert!(plan
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.id == "edit_original_source_not_found"));
    }
}
