use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{any, get},
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
    derive_compose_graph, derive_graph, derive_images, discover_compose_files, mock_logs,
    mock_snapshot, plan_compose_mount_edit, scan_compose_files, unix_timestamp_millis,
    ComposeDiagnostic, ComposeEditPlan, ComposeGraph, ComposeScan, ContainerRecord, DockerSnapshot,
    GraphResponse, HealthResponse, HealthState, LogEntry, LogsResponse, NetworkRecord, RuntimeMode,
    VolumeRecord,
};
use futures_util::stream::StreamExt;
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    net::{IpAddr, SocketAddr},
    path::{Component, Path as StdPath, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{net::TcpListener, sync::RwLock, time::sleep};

const MAX_LOG_QUERY_CHARS: usize = 256;
const MAX_LOG_SERVICE_CHARS: usize = 128;
const MAX_LOG_MESSAGE_CHARS: usize = 4_096;
const MAX_COMPOSE_FILES: usize = 8;
const MAX_COMPOSE_FILE_CHARS: usize = 512;

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

#[derive(Debug, Deserialize)]
struct ComposeScanQuery {
    file: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ComposeEditPlanQuery {
    file: String,
    service: String,
    mount: usize,
    source: Option<String>,
    target: Option<String>,
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
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if let Some(command) = args.first() {
        if matches!(command.as_str(), "scan" | "validate" | "export") {
            match run_cli(command, &args[1..]) {
                Ok(code) => std::process::exit(code),
                Err(error) => {
                    eprintln!("{error}");
                    std::process::exit(2);
                }
            }
        }
    }

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
        .route("/daemon/compose/scan", get(get_compose_scan))
        .route("/daemon/compose/graph", get(get_compose_graph))
        .route("/daemon/compose/edit-plan", get(get_compose_edit_plan))
        .fallback(any(not_found))
        .with_state(state);

    let port = read_port_env("DOCKERMAP_DAEMON_PORT", 4100);
    let host = read_bind_host_env("DOCKERMAP_DAEMON_HOST");
    let address = SocketAddr::from((host, port));
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
        service: &str,
        query: Option<&str>,
    ) -> Result<LogsResponse, String> {
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
                | LogOutput::StdIn { message } => truncate_chars(
                    String::from_utf8_lossy(&message).trim(),
                    MAX_LOG_MESSAGE_CHARS,
                ),
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

            if entries.len() >= 100 {
                break;
            }
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
    let service =
        validate_optional_query(query.service.as_deref(), "service", MAX_LOG_SERVICE_CHARS)?;
    let q = validate_optional_query(query.q.as_deref(), "q", MAX_LOG_QUERY_CHARS)?;
    let cache = state.cache.read().await;
    let docker_reachable = cache.health.docker_reachable;
    let snapshot = cache.snapshot.clone();
    drop(cache);

    if let Some(service) = service {
        if !snapshot
            .containers
            .iter()
            .any(|container| container.name == service)
        {
            return Err(ApiError {
                status: StatusCode::NOT_FOUND,
                message: format!("container `{service}` not found in current snapshot"),
            });
        }
    }

    let response = if docker_reachable {
        let Some(service) = service else {
            return Ok(Json(mock_logs(&snapshot, None, q)));
        };
        let collector = DockerCollector::connect().map_err(|message| ApiError {
            status: StatusCode::BAD_GATEWAY,
            message,
        })?;
        collector
            .collect_logs(service, q)
            .await
            .map_err(|message| ApiError {
                status: StatusCode::BAD_GATEWAY,
                message,
            })?
    } else {
        mock_logs(&snapshot, service, q)
    };

    Ok(Json(response))
}

async fn get_compose_scan(
    Query(query): Query<ComposeScanQuery>,
) -> Result<Json<ComposeScan>, ApiError> {
    Ok(Json(scan_compose_query(query).await?))
}

async fn get_compose_graph(
    Query(query): Query<ComposeScanQuery>,
) -> Result<Json<ComposeGraph>, ApiError> {
    let scan = scan_compose_query(query).await?;
    Ok(Json(derive_compose_graph(&scan)))
}

async fn get_compose_edit_plan(
    Query(query): Query<ComposeEditPlanQuery>,
) -> Result<Json<ComposeEditPlan>, ApiError> {
    let project_root = project_root().map_err(|message| ApiError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        message,
    })?;
    let file = resolve_scannable_file(&project_root, &query.file).map_err(|message| ApiError {
        status: StatusCode::BAD_REQUEST,
        message,
    })?;
    let service = validate_required_value(&query.service, "service", MAX_LOG_SERVICE_CHARS)?;
    let source =
        validate_optional_query(query.source.as_deref(), "source", MAX_COMPOSE_FILE_CHARS)?;
    let target =
        validate_optional_query(query.target.as_deref(), "target", MAX_COMPOSE_FILE_CHARS)?;
    let scan =
        scan_compose_files(&project_root, std::slice::from_ref(&file)).map_err(|message| {
            ApiError {
                status: StatusCode::BAD_REQUEST,
                message,
            }
        })?;
    let mount = scan
        .mounts
        .iter()
        .find(|mount| {
            mount.service == service
                && mount
                    .origin
                    .field
                    .ends_with(&format!(".volumes[{}]", query.mount))
        })
        .ok_or(ApiError {
            status: StatusCode::NOT_FOUND,
            message: format!("mount {} for service `{service}` not found", query.mount),
        })?;
    let content = fs::read_to_string(&file).map_err(|error| ApiError {
        status: StatusCode::BAD_REQUEST,
        message: format!("failed to read compose file `{}`: {error}", file.display()),
    })?;

    Ok(Json(plan_compose_mount_edit(
        &file, &content, mount, source, target,
    )))
}

async fn scan_compose_query(query: ComposeScanQuery) -> Result<ComposeScan, ApiError> {
    let project_root = project_root().map_err(|message| ApiError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        message,
    })?;

    let files = match query.file {
        Some(value) if !value.trim().is_empty() => {
            let requested = parse_compose_file_query(&value)?;
            requested
                .iter()
                .map(|value| resolve_scannable_file(&project_root, value))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|message| ApiError {
                    status: StatusCode::BAD_REQUEST,
                    message,
                })?
        }
        _ => discover_compose_files(&project_root)
            .iter()
            .map(|path| {
                let requested = path
                    .strip_prefix(&project_root)
                    .unwrap_or(path)
                    .to_string_lossy();
                resolve_scannable_file(&project_root, &requested)
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(|message| ApiError {
                status: StatusCode::BAD_REQUEST,
                message,
            })?,
    };

    let scan = scan_compose_files(&project_root, &files).map_err(|message| ApiError {
        status: StatusCode::BAD_REQUEST,
        message,
    })?;

    Ok(scan)
}

async fn not_found() -> ApiError {
    ApiError {
        status: StatusCode::NOT_FOUND,
        message: "Route not found".into(),
    }
}

fn project_root() -> Result<PathBuf, String> {
    let root = std::env::var("DOCKERMAP_PROJECT_ROOT").unwrap_or_else(|_| ".".into());
    fs::canonicalize(&root).map_err(|error| format!("invalid project root `{root}`: {error}"))
}

fn read_port_env(name: &str, fallback: u16) -> u16 {
    match std::env::var(name) {
        Ok(value) => value.parse::<u16>().unwrap_or_else(|_| {
            eprintln!("{name} must be an integer from 1 to 65535, got `{value}`");
            std::process::exit(2);
        }),
        Err(_) => fallback,
    }
}

fn read_bind_host_env(name: &str) -> IpAddr {
    let value = std::env::var(name).unwrap_or_else(|_| "127.0.0.1".into());
    let host = value.parse::<IpAddr>().unwrap_or_else(|_| {
        eprintln!("{name} must be an IP address, got `{value}`");
        std::process::exit(2);
    });

    if !host.is_loopback()
        && std::env::var("DOCKERMAP_ALLOW_REMOTE_DAEMON")
            .ok()
            .as_deref()
            != Some("true")
    {
        eprintln!("{name} must be loopback unless DOCKERMAP_ALLOW_REMOTE_DAEMON=true");
        std::process::exit(2);
    }

    host
}

fn run_cli(command: &str, args: &[String]) -> Result<i32, String> {
    let project_root = project_root()?;
    let files = cli_compose_files(&project_root, args)?;
    let scan = scan_compose_files(&project_root, &files)?;

    match command {
        "scan" => {
            print_json(&scan)?;
            Ok(0)
        }
        "validate" => {
            print_json(&scan.diagnostics)?;
            Ok(if has_blocking_diagnostics(&scan.diagnostics) {
                1
            } else {
                0
            })
        }
        "export" => {
            let format = cli_option_value(args, "--format").unwrap_or("json");
            if format != "json" {
                return Err("only `--format json` is supported".into());
            }
            print_json(&scan)?;
            Ok(0)
        }
        _ => Err(format!("unknown command `{command}`")),
    }
}

fn cli_compose_files(project_root: &StdPath, args: &[String]) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--file" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("`--file` requires a value".into());
                };
                files.push(resolve_scannable_file(project_root, value)?);
                index += 2;
            }
            "--format" => {
                index += 2;
            }
            value => {
                return Err(format!("unknown argument `{value}`"));
            }
        }
    }

    if files.is_empty() {
        discover_compose_files(project_root)
            .iter()
            .map(|path| {
                let requested = path
                    .strip_prefix(project_root)
                    .unwrap_or(path)
                    .to_string_lossy();
                resolve_scannable_file(project_root, &requested)
            })
            .collect()
    } else {
        Ok(files)
    }
}

fn cli_option_value<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.windows(2)
        .find(|window| window[0] == name)
        .map(|window| window[1].as_str())
}

fn has_blocking_diagnostics(diagnostics: &[ComposeDiagnostic]) -> bool {
    diagnostics.iter().any(|diagnostic| {
        matches!(
            diagnostic.severity,
            dockermap_core::DiagnosticSeverity::Error | dockermap_core::DiagnosticSeverity::Blocked
        )
    })
}

fn print_json<T: serde::Serialize>(value: &T) -> Result<(), String> {
    let output = serde_json::to_string_pretty(value)
        .map_err(|error| format!("failed to serialize JSON: {error}"))?;
    println!("{output}");
    Ok(())
}

fn resolve_scannable_file(project_root: &StdPath, requested: &str) -> Result<PathBuf, String> {
    if requested.trim().is_empty() || requested.contains('\0') {
        return Err("compose file path is empty or invalid".into());
    }

    let requested_path = StdPath::new(requested);
    if requested_path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(format!(
            "compose file `{requested}` must not contain parent traversal"
        ));
    }

    let candidate = if requested_path.is_absolute() {
        requested_path.to_path_buf()
    } else {
        project_root.join(requested_path)
    };

    reject_symlink_path(project_root, &candidate)?;

    let canonical = fs::canonicalize(&candidate).map_err(|error| {
        format!(
            "compose file `{}` is not readable: {error}",
            candidate.display()
        )
    })?;

    if !canonical.starts_with(project_root) {
        return Err(format!(
            "compose file `{}` is outside project root `{}`",
            canonical.display(),
            project_root.display()
        ));
    }

    if !canonical.is_file() {
        return Err(format!(
            "compose file `{}` is not a file",
            canonical.display()
        ));
    }

    Ok(canonical)
}

fn parse_compose_file_query(value: &str) -> Result<Vec<String>, ApiError> {
    let files = value
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            if value.len() > MAX_COMPOSE_FILE_CHARS || value.contains('\0') {
                return Err(ApiError {
                    status: StatusCode::BAD_REQUEST,
                    message: format!(
                        "compose file query values must be {MAX_COMPOSE_FILE_CHARS} characters or fewer"
                    ),
                });
            }
            Ok(value.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;

    if files.len() > MAX_COMPOSE_FILES {
        return Err(ApiError {
            status: StatusCode::BAD_REQUEST,
            message: format!("compose scan accepts at most {MAX_COMPOSE_FILES} files"),
        });
    }

    Ok(files)
}

fn validate_optional_query<'a>(
    value: Option<&'a str>,
    name: &str,
    max_chars: usize,
) -> Result<Option<&'a str>, ApiError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();

    if value.is_empty() {
        return Ok(None);
    }

    if value.chars().count() > max_chars || value.contains('\0') {
        return Err(ApiError {
            status: StatusCode::BAD_REQUEST,
            message: format!("query parameter `{name}` must be {max_chars} characters or fewer"),
        });
    }

    Ok(Some(value))
}

fn validate_required_value<'a>(
    value: &'a str,
    name: &str,
    max_chars: usize,
) -> Result<&'a str, ApiError> {
    validate_optional_query(Some(value), name, max_chars)?.ok_or(ApiError {
        status: StatusCode::BAD_REQUEST,
        message: format!("query parameter `{name}` is required"),
    })
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let mut output = value.chars().take(max_chars).collect::<String>();
    if value.chars().count() > max_chars {
        output.push_str("...");
    }
    output
}

fn reject_symlink_path(project_root: &StdPath, canonical: &StdPath) -> Result<(), String> {
    let relative = canonical.strip_prefix(project_root).map_err(|_| {
        format!(
            "compose file `{}` is outside project root `{}`",
            canonical.display(),
            project_root.display()
        )
    })?;
    let mut current = project_root.to_path_buf();

    for component in relative.components() {
        current.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&current)
            .map_err(|error| format!("cannot inspect `{}`: {error}", current.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "compose file path `{}` contains a symlink; refusing to follow it",
                current.display()
            ));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_too_many_compose_files() {
        let value = (0..=MAX_COMPOSE_FILES)
            .map(|index| format!("compose-{index}.yaml"))
            .collect::<Vec<_>>()
            .join(",");

        let error = parse_compose_file_query(&value).expect_err("too many files should fail");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn rejects_oversized_query_values() {
        let oversized = "a".repeat(MAX_LOG_QUERY_CHARS + 1);
        let error = validate_optional_query(Some(&oversized), "q", MAX_LOG_QUERY_CHARS)
            .expect_err("oversized query should fail");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn truncates_log_messages_on_character_boundaries() {
        assert_eq!(truncate_chars("abcdef", 3), "abc...");
        assert_eq!(truncate_chars("ok", 3), "ok");
    }

    #[test]
    fn cli_rejects_unknown_format() {
        let args = vec!["--format".to_string(), "yaml".to_string()];
        let error = run_cli("export", &args).expect_err("yaml export should fail");
        assert!(error.contains("only `--format json`"));
    }
}
