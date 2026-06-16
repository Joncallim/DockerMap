use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use bollard::{
    container::LogOutput,
    models::{ContainerSummary, VolumeListResponse},
    query_parameters::{
        ListContainersOptionsBuilder, ListNetworksOptionsBuilder, ListVolumesOptionsBuilder,
        LogsOptionsBuilder,
    },
    Docker,
};
use dockermap_core::{
    derive_graph, derive_images, mock_logs, mock_snapshot, unix_timestamp_millis, ContainerRecord,
    DockerSnapshot, GraphResponse, HealthResponse, HealthState, LogEntry, LogsResponse,
    NetworkRecord, RuntimeMode, VolumeRecord,
};
use futures_util::stream::StreamExt;
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    net::SocketAddr,
    sync::Arc,
    time::Duration,
};
use tokio::{net::TcpListener, sync::RwLock, time::sleep};

#[derive(Clone)]
struct AppState {
    cache: Arc<RwLock<DaemonCache>>,
}

#[derive(Clone)]
struct DaemonCache {
    snapshot: DockerSnapshot,
    health: HealthResponse,
}

#[derive(Debug, Deserialize)]
struct LogsQuery {
    service: Option<String>,
    q: Option<String>,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let body = serde_json::json!({
            "code": self.status.as_str(),
            "message": self.message,
        });
        (self.status, Json(body)).into_response()
    }
}

#[tokio::main]
async fn main() {
    let state = AppState {
        cache: Arc::new(RwLock::new(DaemonCache::mock())),
    };

    refresh_cache(&state).await;
    tokio::spawn(refresh_loop(state.clone()));

    let app = Router::new()
        .route("/daemon/health", get(get_health))
        .route("/daemon/snapshot", get(get_snapshot))
        .route("/daemon/graph", get(get_graph))
        .route("/daemon/containers", get(get_containers))
        .route("/daemon/containers/{name}", get(get_container))
        .route("/daemon/images", get(get_images))
        .route("/daemon/networks", get(get_networks))
        .route("/daemon/volumes", get(get_volumes))
        .route("/daemon/logs", get(get_logs))
        .with_state(state);

    let port = std::env::var("DOCKERMAP_DAEMON_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(4100);
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = TcpListener::bind(address)
        .await
        .expect("daemon listener should bind");

    println!("dockermap-daemon listening on http://{address}");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("daemon server should run");
}

impl DaemonCache {
    fn mock() -> Self {
        let mut snapshot = mock_snapshot();
        snapshot.images = derive_images(&snapshot);

        let health = HealthResponse {
            status: HealthState::Degraded,
            mode: RuntimeMode::Mock,
            docker_reachable: false,
            last_updated: snapshot.last_updated,
            snapshot_version: snapshot.last_updated.to_string(),
            message: Some("Docker unavailable, serving mock data".into()),
        };

        Self { snapshot, health }
    }
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

async fn refresh_loop(state: AppState) {
    loop {
        refresh_cache(&state).await;
        sleep(Duration::from_secs(2)).await;
    }
}

async fn refresh_cache(state: &AppState) {
    let updated = collect_snapshot().await;
    let mut cache = state.cache.write().await;
    *cache = updated;
}

async fn collect_snapshot() -> DaemonCache {
    match DockerCollector::connect() {
        Ok(collector) => match collector.collect_snapshot().await {
            Ok(mut snapshot) => {
                snapshot.images = derive_images(&snapshot);
                let health = HealthResponse {
                    status: HealthState::Ok,
                    mode: RuntimeMode::Docker,
                    docker_reachable: true,
                    last_updated: snapshot.last_updated,
                    snapshot_version: snapshot.last_updated.to_string(),
                    message: Some("Docker engine connected".into()),
                };
                DaemonCache { snapshot, health }
            }
            Err(error) => {
                let mut cache = DaemonCache::mock();
                cache.health.message =
                    Some(format!("Docker read failed, serving mock data: {error}"));
                cache
            }
        },
        Err(error) => {
            let mut cache = DaemonCache::mock();
            cache.health.message = Some(format!("Docker unavailable, serving mock data: {error}"));
            cache
        }
    }
}

struct DockerCollector {
    client: Docker,
}

impl DockerCollector {
    fn connect() -> Result<Self, String> {
        let client = Docker::connect_with_unix_defaults()
            .map_err(|error| format!("failed to connect to docker socket: {error}"))?;
        Ok(Self { client })
    }

    async fn collect_snapshot(&self) -> Result<DockerSnapshot, String> {
        let containers = self
            .client
            .list_containers(Some(ListContainersOptionsBuilder::new().all(true).build()))
            .await
            .map_err(|error| format!("list_containers failed: {error}"))?;

        let networks = self
            .client
            .list_networks(Some(ListNetworksOptionsBuilder::new().build()))
            .await
            .map_err(|error| format!("list_networks failed: {error}"))?;

        let volumes = self
            .client
            .list_volumes(Some(ListVolumesOptionsBuilder::new().build()))
            .await
            .map_err(|error| format!("list_volumes failed: {error}"))?;

        Ok(build_snapshot(containers, networks, volumes))
    }

    async fn collect_logs(
        &self,
        service: Option<&str>,
        query: Option<&str>,
    ) -> Result<LogsResponse, String> {
        let service = match service {
            Some(service) if !service.is_empty() => service,
            _ => return Ok(mock_logs(&mock_snapshot(), service, query)),
        };

        let mut stream = self.client.logs(
            service,
            Some(
                LogsOptionsBuilder::new()
                    .follow(false)
                    .stdout(true)
                    .stderr(true)
                    .tail("100")
                    .timestamps(false)
                    .build(),
            ),
        );

        let mut entries = Vec::new();
        let filter = query.map(|value| value.to_ascii_lowercase());

        while let Some(item) = stream.next().await {
            let output = item.map_err(|error| format!("docker logs failed: {error}"))?;
            let message = match output {
                LogOutput::StdOut { message }
                | LogOutput::StdErr { message }
                | LogOutput::Console { message }
                | LogOutput::StdIn { message } => {
                    String::from_utf8_lossy(&message).trim().to_string()
                }
            };

            if message.is_empty() {
                continue;
            }

            if let Some(filter) = &filter {
                if !message.to_ascii_lowercase().contains(filter) {
                    continue;
                }
            }

            entries.push(LogEntry {
                id: format!("{service}-{}", entries.len()),
                timestamp: unix_timestamp_millis(),
                container: service.to_string(),
                level: if message.to_ascii_lowercase().contains("error") {
                    dockermap_core::LogLevel::Error
                } else if message.to_ascii_lowercase().contains("warn") {
                    dockermap_core::LogLevel::Warn
                } else {
                    dockermap_core::LogLevel::Info
                },
                message,
            });
        }

        Ok(LogsResponse {
            service: Some(service.to_string()),
            entries,
            next_cursor: None,
        })
    }
}

fn build_snapshot(
    containers: Vec<ContainerSummary>,
    networks: Vec<bollard::models::Network>,
    volume_response: VolumeListResponse,
) -> DockerSnapshot {
    let mut member_sets: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut volume_sets: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut container_records = Vec::new();

    for container in containers {
        let id = container.id.unwrap_or_else(|| "unknown-container".into());
        let name = container
            .names
            .as_ref()
            .and_then(|names| names.first())
            .map(|value| value.trim_start_matches('/').to_string())
            .unwrap_or_else(|| id.clone());

        let network_ids = container
            .network_settings
            .and_then(|settings| settings.networks)
            .map(|mapping| {
                mapping
                    .into_iter()
                    .filter_map(|(_, endpoint)| endpoint.network_id)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        for network_id in &network_ids {
            member_sets
                .entry(network_id.clone())
                .or_default()
                .insert(name.clone());
        }

        if let Some(mounts) = &container.mounts {
            for mount in mounts {
                if let Some(volume_name) = &mount.name {
                    volume_sets
                        .entry(volume_name.clone())
                        .or_default()
                        .insert(name.clone());
                }
            }
        }

        let depends_on = container
            .labels
            .as_ref()
            .and_then(|labels| labels.get("com.docker.compose.depends_on"))
            .map(|value| {
                value
                    .split(',')
                    .filter(|item| !item.is_empty())
                    .map(|item| format!("container_{}", item.trim()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        container_records.push(ContainerRecord {
            id,
            name,
            image: container.image.unwrap_or_else(|| "unknown".into()),
            status: container.status.unwrap_or_else(|| "unknown".into()),
            role: container
                .labels
                .as_ref()
                .and_then(|labels| labels.get("com.docker.compose.service"))
                .cloned()
                .unwrap_or_else(|| "service".into()),
            networks: network_ids,
            ports: container
                .ports
                .unwrap_or_default()
                .into_iter()
                .map(|port| {
                    let private = port.private_port;
                    let public = port.public_port.unwrap_or_default();
                    let kind = port
                        .typ
                        .map(|value| format!("{value:?}").to_ascii_lowercase())
                        .unwrap_or_else(|| "tcp".into());
                    if public > 0 {
                        format!("{public}:{private}/{kind}")
                    } else {
                        format!("{private}/{kind}")
                    }
                })
                .collect(),
            depends_on,
        });
    }

    let network_records = networks
        .into_iter()
        .map(|network| {
            let id = network.id.unwrap_or_else(|| "unknown-network".into());
            NetworkRecord {
                members: member_sets
                    .remove(&id)
                    .unwrap_or_default()
                    .into_iter()
                    .collect(),
                id,
                name: network.name.unwrap_or_else(|| "unnamed".into()),
                driver: network.driver.unwrap_or_else(|| "bridge".into()),
                internal: network.internal.unwrap_or(false),
            }
        })
        .collect::<Vec<_>>();

    let volume_records = volume_response
        .volumes
        .unwrap_or_default()
        .into_iter()
        .map(|volume| {
            let name = volume.name;
            VolumeRecord {
                id: name.clone(),
                name: name.clone(),
                attached_to: volume_sets
                    .remove(&name)
                    .unwrap_or_default()
                    .into_iter()
                    .collect(),
            }
        })
        .collect::<Vec<_>>();

    DockerSnapshot {
        images: derive_images(&DockerSnapshot {
            containers: container_records.clone(),
            images: Vec::new(),
            networks: Vec::new(),
            volumes: Vec::new(),
            last_updated: unix_timestamp_millis(),
        }),
        containers: container_records,
        networks: network_records,
        volumes: volume_records,
        last_updated: unix_timestamp_millis(),
    }
}

async fn get_health(State(state): State<AppState>) -> Json<HealthResponse> {
    let cache = state.cache.read().await;
    Json(cache.health.clone())
}

async fn get_snapshot(State(state): State<AppState>) -> Json<DockerSnapshot> {
    let cache = state.cache.read().await;
    Json(cache.snapshot.clone())
}

async fn get_graph(State(state): State<AppState>) -> Json<GraphResponse> {
    let cache = state.cache.read().await;
    Json(derive_graph(&cache.snapshot))
}

async fn get_containers(State(state): State<AppState>) -> Json<serde_json::Value> {
    let cache = state.cache.read().await;
    Json(serde_json::json!({ "containers": cache.snapshot.containers }))
}

async fn get_container(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<ContainerRecord>, ApiError> {
    let cache = state.cache.read().await;
    let container = cache
        .snapshot
        .containers
        .iter()
        .find(|item| item.name == name)
        .cloned()
        .ok_or(ApiError {
            status: StatusCode::NOT_FOUND,
            message: format!("container `{name}` not found"),
        })?;

    Ok(Json(container))
}

async fn get_images(State(state): State<AppState>) -> Json<serde_json::Value> {
    let cache = state.cache.read().await;
    Json(serde_json::json!({ "images": cache.snapshot.images }))
}

async fn get_networks(State(state): State<AppState>) -> Json<serde_json::Value> {
    let cache = state.cache.read().await;
    Json(serde_json::json!({ "networks": cache.snapshot.networks }))
}

async fn get_volumes(State(state): State<AppState>) -> Json<serde_json::Value> {
    let cache = state.cache.read().await;
    Json(serde_json::json!({ "volumes": cache.snapshot.volumes }))
}

async fn get_logs(
    State(state): State<AppState>,
    Query(query): Query<LogsQuery>,
) -> Result<Json<LogsResponse>, ApiError> {
    let cache = state.cache.read().await;

    let response = if cache.health.docker_reachable {
        let collector = DockerCollector::connect().map_err(|message| ApiError {
            status: StatusCode::BAD_GATEWAY,
            message,
        })?;
        collector
            .collect_logs(query.service.as_deref(), query.q.as_deref())
            .await
            .map_err(|message| ApiError {
                status: StatusCode::BAD_GATEWAY,
                message,
            })?
    } else {
        mock_logs(
            &cache.snapshot,
            query.service.as_deref(),
            query.q.as_deref(),
        )
    };

    Ok(Json(response))
}
