//! Deterministic sample data used by demo mode and fixture-backed tests.

use std::time::{SystemTime, UNIX_EPOCH};

use crate::{
    page_log_entries, ComposeMountKind, ContainerMount, ContainerRecord, DockerSnapshot,
    ImageRecord, LogCursor, LogEntry, LogLevel, LogsResponse, NetworkRecord, VolumeRecord,
};

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
                mounts: Vec::new(),
                depends_on: vec!["container_api".into()],
            },
            ContainerRecord {
                id: "container_api".into(),
                name: "api".into(),
                image: "python:3.11-slim".into(),
                status: "running".into(),
                role: "api".into(),
                networks: vec!["network_app".into(), "network_data".into()],
                ports: vec!["3233:3233/tcp".into()],
                mounts: vec![
                    ContainerMount {
                        id: "container_api:/workspace/src:/srv/dockermap/src".into(),
                        kind: ComposeMountKind::Bind,
                        source: Some("/srv/dockermap/src".into()),
                        target: "/workspace/src".into(),
                        read_only: false,
                    },
                    ContainerMount {
                        id: "container_api:/workspace/.cache:api-cache".into(),
                        kind: ComposeMountKind::NamedVolume,
                        source: Some("api-cache".into()),
                        target: "/workspace/.cache".into(),
                        read_only: false,
                    },
                ],
                depends_on: vec!["container_db".into(), "container_cache".into()],
            },
            ContainerRecord {
                id: "container_worker".into(),
                name: "worker".into(),
                image: "python:3.11-slim".into(),
                status: "running".into(),
                role: "worker".into(),
                networks: vec!["network_app".into(), "network_data".into()],
                ports: vec![],
                mounts: vec![ContainerMount {
                    id: "container_worker:/var/log/dockermap:logs".into(),
                    kind: ComposeMountKind::NamedVolume,
                    source: Some("logs".into()),
                    target: "/var/log/dockermap".into(),
                    read_only: false,
                }],
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
                mounts: vec![ContainerMount {
                    id: "container_db:/var/lib/postgresql/data:postgres_data".into(),
                    kind: ComposeMountKind::NamedVolume,
                    source: Some("postgres_data".into()),
                    target: "/var/lib/postgresql/data".into(),
                    read_only: false,
                }],
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
                mounts: Vec::new(),
                depends_on: vec![],
            },
            ContainerRecord {
                id: "container_registry".into(),
                name: "registry".into(),
                image: "ghcr.io/dockermap/example:1.0".into(),
                status: "running".into(),
                role: "registry mirror".into(),
                networks: vec![],
                ports: vec![],
                mounts: Vec::new(),
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
            ImageRecord {
                image: "ghcr.io/dockermap/example:1.0".into(),
                containers: vec!["registry".into()],
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
        ..Default::default()
    }
}

pub fn unix_timestamp_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after unix epoch")
        .as_millis() as u64
}

/// Base timestamp for mock log entries, captured ONCE per process.
///
/// A fresh `now` per request would shift the whole mock timeline by the
/// request-to-request delta: a compound cursor (`millis:offset`) produced
/// from page N would land between entries on page N+1, so the boundary
/// entry would be misclassified as already-emitted and skipped, and the
/// same-ms offset logic would never engage in mock mode. A process-wide
/// base keeps the timeline — and therefore cursor matching — stable across
/// requests.
static MOCK_LOG_BASE_MILLIS: std::sync::OnceLock<u64> = std::sync::OnceLock::new();

fn mock_log_base_millis() -> u64 {
    *MOCK_LOG_BASE_MILLIS.get_or_init(unix_timestamp_millis)
}

pub fn mock_log_entries(snapshot: &DockerSnapshot, service: Option<&str>) -> Vec<LogEntry> {
    let mut entries = Vec::new();
    let now = mock_log_base_millis();
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
            entries.push(LogEntry {
                id: format!("{}-{}", container.id, offset),
                timestamp: now.saturating_sub(((index * 3 + offset) as u64) * 15_000),
                container: container.name.clone(),
                level,
                message,
            });
        }
    }
    entries
}

pub fn mock_logs(
    snapshot: &DockerSnapshot,
    service: Option<&str>,
    query: Option<&str>,
    cursor: Option<LogCursor>,
    limit: usize,
) -> LogsResponse {
    let entries = mock_log_entries(snapshot, service);
    let (entries, next_cursor) = page_log_entries(entries, query, cursor, limit);
    LogsResponse {
        service: service.map(str::to_string),
        entries,
        next_cursor,
        ..Default::default()
    }
}
