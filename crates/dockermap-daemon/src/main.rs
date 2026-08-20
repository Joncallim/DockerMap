use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{any, get},
    Json, Router,
};
use bollard::{
    container::LogOutput,
    models::{ContainerSummary, MountPoint, MountPointTypeEnum, VolumeListResponse},
    query_parameters::{
        ListContainersOptionsBuilder, ListNetworksOptionsBuilder, ListVolumesOptionsBuilder,
        LogsOptionsBuilder,
    },
    Docker,
};
use dockermap_core::{
    correlate_compose_runtime, derive_compose_graph, derive_graph, derive_images,
    derive_runtime_map, discover_compose_files, mock_logs, mock_snapshot,
    parse_rfc3339_nano_millis, plan_compose_mount_edit, scan_compose_files,
    service_entity_kind_name, unix_timestamp_millis, ComposeDiagnostic, ComposeEditPlan,
    ComposeGraph, ComposeMountKind, ComposeScan, ContainerMount, ContainerRecord,
    DiagnosticSeverity, DockerSnapshot, GraphResponse, HealthResponse, HealthState, LogEntry,
    LogsResponse, NetworkRecord, RuntimeLocation, RuntimeMap, RuntimeMapDiagnostic, RuntimeMapEdge,
    RuntimeMapNode, RuntimeMode, RuntimeNodeKind, RuntimeNodeLayer, RuntimeOwnership,
    RuntimePackageEntity, RuntimeProviderKind, RuntimeRelationshipKind, RuntimeServiceEntity,
    RuntimeServiceStatus, ServiceEntityKind, VolumeRecord, DEFAULT_LOG_PAGE_SIZE,
    MAX_LOG_PAGE_SIZE,
};
use futures_util::stream::StreamExt;
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    net::{IpAddr, SocketAddr},
    path::{Component, Path as StdPath, PathBuf},
    process::{Command, Output},
    sync::Arc,
    time::Duration,
};
use tokio::{net::TcpListener, sync::RwLock, time::sleep};

const MAX_LOG_QUERY_CHARS: usize = 256;
const MAX_LOG_SERVICE_CHARS: usize = 128;
const MAX_LOG_MESSAGE_CHARS: usize = 4_096;
const MAX_COMPOSE_FILES: usize = 8;
const MAX_COMPOSE_FILE_CHARS: usize = 512;
const MAX_SYSTEMD_UNITS: usize = 128;
const MAX_DISCOVERY_DIRS: usize = 4_096;
const MAX_NPM_PROJECTS: usize = 64;
const MAX_NPM_DEPENDENCIES_PER_PROJECT: usize = 64;
const MAX_PACKAGE_JSON_BYTES: u64 = 262_144;
const MAX_NPM_SCRIPTS: usize = 16;
const MAX_SCRIPT_CHARS: usize = 200;
const REDACTED_VALUE: &str = "[redacted]";
const MAX_DOCKER_LABEL_FILTER_CHARS: usize = 256;

#[derive(Clone)]
struct AppState {
    cache: Arc<RwLock<DaemonCache>>,
    /// Reused bollard Docker client (connection pooling), created on first
    /// use and recreated after a failed interaction so a restarted Docker
    /// daemon is picked up. `None` means "not connected yet / previous
    /// attempt failed".
    docker: Arc<RwLock<Option<DockerCollector>>>,
}

#[derive(Clone)]
struct DaemonCache {
    snapshot: DockerSnapshot,
    health: HealthResponse,
    runtime_map: RuntimeMap,
}

#[derive(Debug, Deserialize)]
struct LogsQuery {
    service: Option<String>,
    q: Option<String>,
    cursor: Option<String>,
    limit: Option<usize>,
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct SystemdUnitSummary {
    unit: String,
    active_state: String,
    sub_state: String,
    description: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct SystemdUnitDetails {
    id: String,
    active_state: Option<String>,
    sub_state: Option<String>,
    description: Option<String>,
    fragment_path: Option<String>,
    load_state: Option<String>,
    exec_start: Option<String>,
    restart: Option<String>,
    active_enter_timestamp: Option<String>,
    active_enter_monotonic_us: Option<u64>,
    requires: Vec<String>,
    wants: Vec<String>,
    part_of: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PackageDependencyRecord {
    name: String,
    version: String,
    scope: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NpmProjectSummary {
    directory: PathBuf,
    package_name: Option<String>,
    display_name: String,
    kind: RuntimeNodeKind,
    service_entity_kind: ServiceEntityKind,
    package_manager: Option<String>,
    lockfiles: Vec<String>,
    dependencies: Vec<PackageDependencyRecord>,
    scripts: BTreeMap<String, String>,
    framework_hints: Vec<String>,
    private: bool,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct PackageManifestDocument {
    name: Option<String>,
    private: bool,
    #[serde(rename = "packageManager")]
    package_manager: Option<String>,
    scripts: BTreeMap<String, String>,
    dependencies: BTreeMap<String, String>,
    #[serde(rename = "optionalDependencies")]
    optional_dependencies: BTreeMap<String, String>,
    #[serde(rename = "peerDependencies")]
    peer_dependencies: BTreeMap<String, String>,
    #[serde(rename = "devDependencies")]
    dev_dependencies: BTreeMap<String, String>,
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

const CLI_USAGE: &str = "\
DockerMap daemon — read-only Docker/host inspector

USAGE:
    dockermap-daemon [COMMAND] [OPTIONS]

COMMANDS:
    scan       Print a Compose project scan as JSON
    validate   Print Compose diagnostics (exits 1 when blocking findings exist)
    export     Export a Compose project scan (--format json)

OPTIONS:
    -h, --help       Print help
    --version        Print version

With no COMMAND, the daemon starts its loopback HTTP server (default port 4100).
";

#[tokio::main]
async fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();

    if let Some(command) = args.first() {
        match command.as_str() {
            "--help" | "-h" => {
                print!("{CLI_USAGE}");
                std::process::exit(0);
            }
            "--version" => {
                println!("dockermap-daemon {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            "scan" | "validate" | "export" => match run_cli(command, &args[1..]) {
                Ok(code) => std::process::exit(code),
                Err(error) => {
                    eprintln!("{error}");
                    std::process::exit(2);
                }
            },
            unknown => {
                eprintln!("unknown command `{unknown}`\n\n{CLI_USAGE}");
                std::process::exit(2);
            }
        }
    }

    let state = AppState {
        cache: Arc::new(RwLock::new(DaemonCache::mock())),
        docker: Arc::new(RwLock::new(None)),
    };

    refresh_cache(&state).await;
    tokio::spawn(refresh_loop(state.clone()));

    let app = Router::new()
        .route("/daemon/health", get(get_health))
        .route("/daemon/snapshot", get(get_snapshot))
        .route("/daemon/graph", get(get_graph))
        .route("/daemon/runtime/map", get(get_runtime_map))
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

        let last_updated = snapshot.last_updated;

        Self {
            snapshot,
            health,
            runtime_map: RuntimeMap {
                nodes: Vec::new(),
                edges: Vec::new(),
                diagnostics: Vec::new(),
                last_updated,
            },
        }
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
    let updated = collect_snapshot(state).await;
    let mut cache = state.cache.write().await;
    *cache = updated;
}

/// Returns the cached Docker collector, connecting on first use. The client
/// is reused across refresh ticks and log requests (bollard pools the Unix
/// socket connection) instead of being recreated on every call, which churned
/// connections and added per-request latency.
async fn docker_collector(state: &AppState) -> Result<DockerCollector, String> {
    {
        let guard = state.docker.read().await;
        if let Some(collector) = guard.as_ref() {
            return Ok(collector.clone());
        }
    }
    let collector = DockerCollector::connect()?;
    *state.docker.write().await = Some(collector.clone());
    Ok(collector)
}

/// Drop the cached collector after a failed interaction so the next refresh
/// reconnects — a pooled Unix-socket connection can go stale when the Docker
/// daemon restarts.
async fn invalidate_docker_collector(state: &AppState) {
    *state.docker.write().await = None;
}

async fn collect_snapshot(state: &AppState) -> DaemonCache {
    if std::env::var("DOCKERMAP_FORCE_MOCK").ok().as_deref() == Some("true") {
        let mut cache = DaemonCache::mock();
        cache.health.message = Some("Mock mode forced by DOCKERMAP_FORCE_MOCK".into());
        cache.runtime_map = collect_runtime_map_bounded(&cache.snapshot).await;
        return cache;
    }

    let mut cache = match docker_collector(state).await {
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
                DaemonCache {
                    snapshot,
                    health,
                    runtime_map: empty_runtime_map(0),
                }
            }
            Err(error) => {
                invalidate_docker_collector(state).await;
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
    };

    // The runtime map is expensive (provider subprocesses, filesystem walk)
    // and must never run on a Tokio worker thread, so it is computed once per
    // refresh cycle — same cadence as the snapshot — and served from the
    // cache by `get_runtime_map`.
    cache.runtime_map = collect_runtime_map_bounded(&cache.snapshot).await;
    cache
}

fn empty_runtime_map(last_updated: u64) -> RuntimeMap {
    RuntimeMap {
        nodes: Vec::new(),
        edges: Vec::new(),
        diagnostics: Vec::new(),
        last_updated,
    }
}

#[derive(Clone)]
struct DockerCollector {
    client: Docker,
    label_filter: Option<String>,
}

impl DockerCollector {
    fn connect() -> Result<Self, String> {
        let label_filter = docker_label_filter_from_env()?;
        let client = Docker::connect_with_unix_defaults()
            .map_err(|error| format!("failed to connect to docker socket: {error}"))?;
        Ok(Self {
            client,
            label_filter,
        })
    }

    async fn collect_snapshot(&self) -> Result<DockerSnapshot, String> {
        let filters = self.docker_filters();
        let mut container_options = ListContainersOptionsBuilder::new().all(true);
        if let Some(filters) = filters.as_ref() {
            container_options = container_options.filters(filters);
        }
        let containers = self
            .client
            .list_containers(Some(container_options.build()))
            .await
            .map_err(|error| format!("list_containers failed: {error}"))?;

        let mut network_options = ListNetworksOptionsBuilder::new();
        if let Some(filters) = filters.as_ref() {
            network_options = network_options.filters(filters);
        }
        let networks = self
            .client
            .list_networks(Some(network_options.build()))
            .await
            .map_err(|error| format!("list_networks failed: {error}"))?;

        let mut volume_options = ListVolumesOptionsBuilder::new();
        if let Some(filters) = filters.as_ref() {
            volume_options = volume_options.filters(filters);
        }
        let volumes = self
            .client
            .list_volumes(Some(volume_options.build()))
            .await
            .map_err(|error| format!("list_volumes failed: {error}"))?;

        Ok(build_snapshot(containers, networks, volumes))
    }

    fn docker_filters(&self) -> Option<HashMap<String, Vec<String>>> {
        self.label_filter
            .as_ref()
            .map(|label| HashMap::from([("label".to_string(), vec![label.clone()])]))
    }

    async fn collect_logs(
        &self,
        service: &str,
        query: Option<&str>,
        cursor_millis: Option<u64>,
        limit: usize,
    ) -> Result<LogsResponse, String> {
        let limit = limit.clamp(1, MAX_LOG_PAGE_SIZE);
        let mut options = LogsOptionsBuilder::new()
            .follow(false)
            .stdout(true)
            .stderr(true)
            .timestamps(true)
            .tail(&log_tail_count(limit, cursor_millis.is_some()).to_string());

        if let Some(cursor_millis) = cursor_millis {
            options = options.until(log_until_seconds(cursor_millis));
        }

        let mut stream = self.client.logs(service, Some(options.build()));

        // Docker streams the `tail(limit)` window OLDEST-first, so we cannot
        // decide page boundaries while streaming: collect the whole window
        // (bounded server-side by `tail`, plus a defensive cap in case Docker
        // returns more than requested), then page it in a pure function.
        let mut entries = Vec::new();
        let mut sequence = 0usize;

        while let Some(item) = stream.next().await {
            let output = item.map_err(|error| format!("docker logs failed: {error}"))?;
            let (timestamp, message) = match output {
                LogOutput::StdOut { message }
                | LogOutput::StdErr { message }
                | LogOutput::Console { message }
                | LogOutput::StdIn { message } => {
                    let Some((timestamp, message)) = parse_timestamped_log_line(&message) else {
                        continue;
                    };
                    (timestamp, message)
                }
            };

            entries.push(LogEntry {
                id: log_entry_id(service, timestamp, sequence),
                timestamp,
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
            sequence += 1;

            if entries.len() >= MAX_LOG_STREAM_CAP {
                break;
            }
        }

        let (entries, next_cursor) = page_log_entries(entries, query, cursor_millis, limit);

        Ok(LogsResponse {
            service: Some(service.to_string()),
            entries,
            next_cursor,
        })
    }
}

/// Parse one timestamped Docker log line (collected with `--timestamps`) into
/// a `(timestamp_millis, message)` pair, or `None` when the line carries no
/// message. A blank line arrives from Docker as `"<timestamp> "` (timestamp,
/// space, empty body); it must be SKIPPED rather than fabricated into a
/// now-timestamped entry whose message is the raw timestamp string.
fn parse_timestamped_log_line(line: &[u8]) -> Option<(u64, String)> {
    let text = String::from_utf8_lossy(line);
    // Always split on the first space. A blank line's empty `rest` trims to
    // "", which we skip below; a line with no space falls back to the whole
    // text as the message (no timestamp prefix).
    let (prefix, rest) = match text.split_once(' ') {
        Some((prefix, rest)) => (prefix, rest.trim()),
        None => ("", text.trim()),
    };
    let timestamp = parse_rfc3339_nano_millis(prefix).unwrap_or_else(unix_timestamp_millis);
    let message = truncate_chars(rest, MAX_LOG_MESSAGE_CHARS);
    if message.is_empty() {
        return None;
    }
    Some((timestamp, message))
}

/// Number of lines requested from Docker's `tail` for one log page.
///
/// First page (`cursor == false`): over-fetch by one so `page_log_entries`
/// can decide "a next page exists" (`entries.len() > limit`) from the live
/// stream: with a plain `tail(limit)` the collected window is exactly `limit`
/// lines, so `next_cursor` could never be emitted for real Docker logs and
/// "Load older" stayed permanently hidden in live mode. The extra line is
/// truncated by `page_log_entries`, which is the single source of truth for
/// page boundaries across every log source.
///
/// Cursor page (`cursor == true`): open a much larger fixed window
/// (`MAX_LOG_CURSOR_TAIL`). Docker's `--tail N` selects the last N lines of
/// the FULL log and `--until` only FILTERS that fixed window — it never moves
/// the window older — so a cursor page bounded by `tail(limit + 1)` could
/// surface at most one older line. The larger window lets `until(cursor)` and
/// `page_log_entries`' precise `< cursor` filter select the correct older
/// page. Trade-off: history older than `MAX_LOG_CURSOR_TAIL` is unreachable.
fn log_tail_count(limit: usize, cursor: bool) -> usize {
    if cursor {
        MAX_LOG_CURSOR_TAIL
    } else {
        limit.clamp(1, MAX_LOG_PAGE_SIZE) + 1
    }
}

/// Docker's `until` filter is second-resolution and EXCLUSIVE: a line at
/// exactly `until` seconds is omitted. Floor-truncating a millisecond cursor
/// (`cursor_millis / 1_000`) therefore silently drops every entry in the
/// boundary second that is still older than the cursor. Round UP instead so
/// Docker returns the whole boundary second and `page_log_entries`' precise
/// `< cursor` filter is the sole arbiter of what belongs to the next page.
fn log_until_seconds(cursor_millis: u64) -> i32 {
    cursor_millis.div_ceil(1_000).min(i32::MAX as u64) as i32
}

/// Fixed `tail` window opened for cursor ("Load older") pages. See
/// `log_tail_count` for why a cursor page needs a large window.
const MAX_LOG_CURSOR_TAIL: usize = 4_096;

/// Defensive cap on the raw log stream collected from Docker. The stream is
/// already bounded by `tail(...)`, so this only guards against a daemon
/// returning more than requested — but it must be at least as large as the
/// widest tail window (`MAX_LOG_CURSOR_TAIL`), or a cursor page's window would
/// be truncated before `page_log_entries` sees it.
const MAX_LOG_STREAM_CAP: usize = MAX_LOG_CURSOR_TAIL + 1;

/// Unique id for a live-Docker log entry. Same-timestamp lines (Docker's
/// millisecond timestamps can collide) stay unique thanks to the per-stream
/// monotonic sequence number, which keeps React keys stable.
fn log_entry_id(service: &str, timestamp: u64, sequence: usize) -> String {
    format!("{service}-{timestamp}-{sequence}")
}

/// Pure log pagination shared by every log source (no Docker socket needed).
///
/// Mirrors the mock semantics exactly: entries are filtered to those strictly
/// older than the cursor, sorted NEWEST-first, and `next_cursor` is the oldest
/// kept entry's timestamp — set only when more entries exist behind the page,
/// so "Load older" terminates with `None` on the last page (including pages
/// that end exactly on a multiple of `limit`) and never overlaps the previous
/// one.
fn page_log_entries(
    entries: Vec<LogEntry>,
    query: Option<&str>,
    cursor_millis: Option<u64>,
    limit: usize,
) -> (Vec<LogEntry>, Option<String>) {
    let limit = limit.clamp(1, MAX_LOG_PAGE_SIZE);
    let filter = query.map(|value| value.to_ascii_lowercase());

    let mut entries = entries
        .into_iter()
        .filter(|entry| cursor_millis.is_none_or(|cursor| entry.timestamp < cursor))
        .filter(|entry| {
            filter
                .as_ref()
                .is_none_or(|needle| entry.message.to_ascii_lowercase().contains(needle))
        })
        .collect::<Vec<_>>();

    entries.sort_by(|left, right| right.timestamp.cmp(&left.timestamp));

    // Decide whether older entries can exist BEHIND this page BEFORE
    // truncating: a cursor is emitted only when the filtered page holds more
    // than `limit` entries, mirroring mock_logs. On totals that are exact
    // multiples of limit, the last page is exactly full but nothing is older
    // behind it, so a full-page heuristic would emit a trailing cursor that
    // yields an empty next page. The cursor points at the oldest kept entry.
    let has_more = entries.len() > limit;
    entries.truncate(limit);

    let next_cursor = if has_more {
        entries.last().map(|entry| entry.timestamp.to_string())
    } else {
        None
    };

    (entries, next_cursor)
}

fn docker_label_filter_from_env() -> Result<Option<String>, String> {
    match std::env::var("DOCKERMAP_DOCKER_LABEL_FILTER") {
        Ok(value) => parse_docker_label_filter(&value)
            .map_err(|message| format!("invalid DOCKERMAP_DOCKER_LABEL_FILTER: {message}")),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => {
            Err("invalid DOCKERMAP_DOCKER_LABEL_FILTER: value must be valid UTF-8".into())
        }
    }
}

fn parse_docker_label_filter(value: &str) -> Result<Option<String>, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > MAX_DOCKER_LABEL_FILTER_CHARS {
        return Err(format!(
            "label filter must be {MAX_DOCKER_LABEL_FILTER_CHARS} characters or fewer"
        ));
    }
    if trimmed.contains('\0') {
        return Err("label filter must not contain NUL bytes".into());
    }
    if trimmed.starts_with('=') {
        return Err("label filter key must not be empty".into());
    }

    Ok(Some(trimmed.to_string()))
}

/// Parse the `com.docker.compose.depends_on` label into container refs.
///
/// Compose stores the label as `service:condition:required,service2:...`
/// (e.g. `redis:service_started:false,database:service_started:false`) where
/// each item is the compose SERVICE name plus a condition suffix. Only the
/// service name matters for graph derivation — the suffix must be stripped
/// before the ref can resolve (the refs match compose service names, which
/// the snapshot records as each container's `role`).
fn parse_depends_on_label(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(|item| item.split(':').next().unwrap_or("").trim())
        .filter(|name| !name.is_empty())
        .map(|name| format!("container_{name}"))
        .collect()
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
        let mounts = collect_container_mounts(&id, container.mounts.as_deref());

        let depends_on = container
            .labels
            .as_ref()
            .and_then(|labels| labels.get("com.docker.compose.depends_on"))
            .map(|value| parse_depends_on_label(value))
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
            mounts,
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
        // Images are derived once by the caller (`collect_snapshot`) after
        // the snapshot is built — deriving here would deep-clone the
        // container records and re-derive O(n) on every refresh for nothing.
        images: Vec::new(),
        containers: container_records,
        networks: network_records,
        volumes: volume_records,
        last_updated: unix_timestamp_millis(),
    }
}

fn collect_container_mounts(
    container_id: &str,
    mounts: Option<&[MountPoint]>,
) -> Vec<ContainerMount> {
    mounts
        .unwrap_or(&[])
        .iter()
        .filter_map(|mount| {
            let target = mount.destination.clone()?;
            let kind = match mount.typ {
                Some(MountPointTypeEnum::BIND) => ComposeMountKind::Bind,
                Some(MountPointTypeEnum::VOLUME) if mount.name.is_some() => {
                    ComposeMountKind::NamedVolume
                }
                Some(MountPointTypeEnum::VOLUME) => ComposeMountKind::AnonymousVolume,
                _ => ComposeMountKind::Unsupported,
            };
            let source = match kind {
                ComposeMountKind::Bind => mount.source.clone(),
                ComposeMountKind::NamedVolume => {
                    mount.name.clone().or_else(|| mount.source.clone())
                }
                ComposeMountKind::AnonymousVolume => None,
                ComposeMountKind::Unsupported => {
                    mount.source.clone().or_else(|| mount.name.clone())
                }
            };

            Some(ContainerMount {
                id: format!(
                    "{container_id}:{}:{}",
                    target,
                    source.as_deref().unwrap_or("anonymous")
                ),
                kind,
                source,
                target,
                read_only: mount.rw.map(|rw| !rw).unwrap_or(false),
            })
        })
        .collect()
}

fn collect_runtime_map(snapshot: &DockerSnapshot) -> RuntimeMap {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut diagnostics = Vec::new();
    let project_root = project_root().ok();

    collect_host_node(project_root.as_deref(), &mut nodes);
    collect_network_listeners(&mut nodes, &mut diagnostics);
    collect_network_infrastructure(snapshot, &mut nodes, &mut edges, &mut diagnostics);
    collect_systemd_services(&mut nodes, &mut edges, &mut diagnostics);
    collect_scheduled_jobs(&mut nodes, &mut diagnostics);
    collect_pm2_apps(&mut nodes, &mut diagnostics);
    collect_tmux_sessions(&mut nodes, &mut diagnostics);
    if let Some(root) = project_root.as_deref() {
        collect_npm_projects(root, &mut nodes, &mut edges, &mut diagnostics);
    } else {
        push_provider_diagnostic(
            &mut diagnostics,
            RuntimeProviderKind::Npm,
            DiagnosticSeverity::Info,
            "npm discovery skipped: project root unavailable".into(),
        );
    }

    let mut runtime_map = derive_runtime_map(snapshot, nodes, edges, diagnostics);
    redact_runtime_map(&mut runtime_map);
    runtime_map
}

/// Wall-clock budget for each provider subprocess. Provider binaries
/// (tailscale, headscale, systemctl, crontab, pm2, tmux) can hang on network
/// calls, stale locks, or waits; every command must be bounded so a stuck
/// provider cannot stall the runtime-map refresh or a request thread.
const PROVIDER_COMMAND_TIMEOUT: Duration = Duration::from_secs(3);

/// Overall budget for one full runtime-map collection (all provider
/// subprocesses, the npm filesystem walk, and /proc reads) when it runs off
/// the async runtime.
const RUNTIME_MAP_COLLECTION_TIMEOUT: Duration = Duration::from_secs(15);

/// Run a provider command with a hard wall-clock timeout. Returns the child's
/// output on success; `Err` on spawn failure or when the command outlives the
/// budget (the child is killed and reaped). Callers push a provider
/// diagnostic instead of failing the whole runtime map.
fn run_command_with_timeout(mut command: Command, timeout: Duration) -> Result<Output, String> {
    // `Command::spawn` does NOT pipe stdio like `Command::output` does, so
    // the pipes must be requested explicitly to collect provider output.
    let mut child = command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to spawn provider command: {error}"))?;
    let started = std::time::Instant::now();
    loop {
        match child
            .try_wait()
            .map_err(|error| format!("provider command wait failed: {error}"))?
        {
            Some(_status) => break,
            None if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "provider command timed out after {}s",
                    timeout.as_secs()
                ));
            }
            None => std::thread::sleep(Duration::from_millis(25)),
        }
    }
    child
        .wait_with_output()
        .map_err(|error| format!("failed to read provider command output: {error}"))
}

/// Collect the runtime map off the async runtime: the provider commands are
/// blocking `std::process` calls, so they must never run on a Tokio worker
/// thread, and the whole collection is bounded so a pathological provider (or
/// npm walk) degrades the map instead of stalling refresh.
async fn collect_runtime_map_bounded(snapshot: &DockerSnapshot) -> RuntimeMap {
    let snapshot = snapshot.clone();
    let work = {
        let snapshot = snapshot.clone();
        tokio::task::spawn_blocking(move || collect_runtime_map(&snapshot))
    };
    match tokio::time::timeout(RUNTIME_MAP_COLLECTION_TIMEOUT, work).await {
        Ok(Ok(runtime_map)) => runtime_map,
        Ok(Err(join_error)) => {
            eprintln!("runtime map collection task failed: {join_error}");
            fallback_runtime_map(&snapshot)
        }
        Err(_elapsed) => {
            eprintln!("runtime map collection timed out after {RUNTIME_MAP_COLLECTION_TIMEOUT:?}");
            fallback_runtime_map(&snapshot)
        }
    }
}

/// Minimal runtime map served when provider collection fails or times out:
/// the Docker-derived nodes are still useful, and a warning diagnostic
/// explains why host providers are missing.
fn fallback_runtime_map(snapshot: &DockerSnapshot) -> RuntimeMap {
    let mut runtime_map = derive_runtime_map(
        snapshot,
        Vec::new(),
        Vec::new(),
        vec![RuntimeMapDiagnostic {
            provider: RuntimeProviderKind::Other,
            severity: DiagnosticSeverity::Warning,
            message: "Runtime map collection failed or timed out; host provider nodes omitted"
                .into(),
        }],
    );
    redact_runtime_map(&mut runtime_map);
    runtime_map
}

fn collect_host_node(project_root: Option<&StdPath>, nodes: &mut Vec<RuntimeMapNode>) {
    let hostname = local_hostname();
    let mut metadata = BTreeMap::new();
    metadata.insert("hostname".into(), hostname.clone());
    metadata.insert(
        "serviceEntityKind".into(),
        service_entity_kind_name(&ServiceEntityKind::Host).into(),
    );
    if let Some(root) = project_root {
        metadata.insert("projectRoot".into(), root.display().to_string());
    }
    nodes.push(RuntimeMapNode {
        id: "host_local".into(),
        provider: RuntimeProviderKind::Host,
        kind: RuntimeNodeKind::Host,
        label: hostname,
        status: Some("online".into()),
        layer: Some(RuntimeNodeLayer::Host),
        metadata,
        service: None,
        package: None,
    });
}

fn collect_network_infrastructure(
    snapshot: &DockerSnapshot,
    nodes: &mut Vec<RuntimeMapNode>,
    edges: &mut Vec<RuntimeMapEdge>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    collect_tailscale(nodes, diagnostics);
    collect_headscale(nodes, diagnostics);
    collect_network_config_markers(nodes);
    collect_network_containers(snapshot, nodes, edges);
}

fn collect_tailscale(nodes: &mut Vec<RuntimeMapNode>, diagnostics: &mut Vec<RuntimeMapDiagnostic>) {
    let output = match run_command_with_timeout(
        {
            let mut command = Command::new("tailscale");
            command.args(["status", "--json"]);
            command
        },
        PROVIDER_COMMAND_TIMEOUT,
    ) {
        Ok(output) => output,
        Err(error) => {
            push_provider_diagnostic(
                diagnostics,
                RuntimeProviderKind::Tailscale,
                DiagnosticSeverity::Info,
                format!("Tailscale discovery skipped: {error}"),
            );
            return;
        }
    };

    if !output.status.success() {
        push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::Tailscale,
            DiagnosticSeverity::Warning,
            "Tailscale status command failed".into(),
        );
        return;
    }

    let Ok(status) = serde_json::from_slice::<serde_json::Value>(&output.stdout) else {
        push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::Tailscale,
            DiagnosticSeverity::Warning,
            "Tailscale status returned invalid JSON".into(),
        );
        return;
    };

    if let Some(self_node) = status.get("Self") {
        push_tailnet_node(nodes, RuntimeProviderKind::Tailscale, "self", self_node);
    }

    if let Some(peers) = status.get("Peer").and_then(serde_json::Value::as_object) {
        for (index, peer) in peers.values().enumerate() {
            push_tailnet_node(
                nodes,
                RuntimeProviderKind::Tailscale,
                &format!("peer_{index}"),
                peer,
            );
        }
    }
}

fn collect_headscale(nodes: &mut Vec<RuntimeMapNode>, diagnostics: &mut Vec<RuntimeMapDiagnostic>) {
    let output = match run_command_with_timeout(
        {
            let mut command = Command::new("headscale");
            command.args(["nodes", "list", "--output", "json"]);
            command
        },
        PROVIDER_COMMAND_TIMEOUT,
    ) {
        Ok(output) => output,
        Err(error) => {
            push_provider_diagnostic(
                diagnostics,
                RuntimeProviderKind::Headscale,
                DiagnosticSeverity::Info,
                format!("Headscale discovery skipped: {error}"),
            );
            return;
        }
    };

    if !output.status.success() {
        push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::Headscale,
            DiagnosticSeverity::Warning,
            "Headscale nodes command failed".into(),
        );
        return;
    }

    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&output.stdout) else {
        push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::Headscale,
            DiagnosticSeverity::Warning,
            "Headscale nodes command returned invalid JSON".into(),
        );
        return;
    };

    let nodes_json = value
        .as_array()
        .cloned()
        .or_else(|| {
            value
                .get("nodes")
                .and_then(serde_json::Value::as_array)
                .cloned()
        })
        .unwrap_or_default();

    for (index, node) in nodes_json.into_iter().enumerate() {
        push_tailnet_node(
            nodes,
            RuntimeProviderKind::Headscale,
            &format!("node_{index}"),
            &node,
        );
    }
}

fn push_tailnet_node(
    nodes: &mut Vec<RuntimeMapNode>,
    provider: RuntimeProviderKind,
    fallback_id: &str,
    value: &serde_json::Value,
) {
    let label = value
        .get("DNSName")
        .and_then(serde_json::Value::as_str)
        .or_else(|| value.get("HostName").and_then(serde_json::Value::as_str))
        .or_else(|| value.get("givenName").and_then(serde_json::Value::as_str))
        .or_else(|| value.get("name").and_then(serde_json::Value::as_str))
        .unwrap_or(fallback_id)
        .trim_end_matches('.')
        .to_string();
    let online = value
        .get("Online")
        .and_then(serde_json::Value::as_bool)
        .or_else(|| value.get("online").and_then(serde_json::Value::as_bool));
    let mut metadata = BTreeMap::new();
    if let Some(addresses) = value
        .get("TailscaleIPs")
        .and_then(serde_json::Value::as_array)
        .or_else(|| {
            value
                .get("ipAddresses")
                .and_then(serde_json::Value::as_array)
        })
    {
        let ips = addresses
            .iter()
            .filter_map(serde_json::Value::as_str)
            .collect::<Vec<_>>();
        if !ips.is_empty() {
            metadata.insert("ips".into(), ips.join(","));
        }
    }
    if let Some(user) = value
        .get("User")
        .and_then(serde_json::Value::as_str)
        .or_else(|| value.get("user").and_then(serde_json::Value::as_str))
    {
        metadata.insert("user".into(), user.into());
    }

    let provider_id = match provider {
        RuntimeProviderKind::Tailscale => "tailscale",
        RuntimeProviderKind::Headscale => "headscale",
        _ => "tailnet",
    };
    nodes.push(RuntimeMapNode {
        id: format!(
            "{provider_id}_node_{}",
            safe_runtime_id_component(&label, fallback_id)
        ),
        provider,
        kind: RuntimeNodeKind::TailnetNode,
        label,
        status: online.map(|value| if value { "online" } else { "offline" }.into()),
        layer: Some(RuntimeNodeLayer::Edge),
        metadata,
        service: None,
        package: None,
    });
}

fn collect_network_config_markers(nodes: &mut Vec<RuntimeMapNode>) {
    for marker in reverse_proxy_markers() {
        if path_exists(marker.path) {
            nodes.push(network_marker_node(
                marker,
                RuntimeProviderKind::ReverseProxy,
                RuntimeNodeKind::ReverseProxy,
                ServiceEntityKind::ReverseProxy,
                "reverse_proxy_config",
            ));
        }
    }

    for marker in local_dns_markers() {
        if path_exists(marker.path) {
            nodes.push(network_marker_node(
                marker,
                RuntimeProviderKind::LocalDns,
                RuntimeNodeKind::LocalDnsResolver,
                ServiceEntityKind::DnsProvider,
                "local_dns_config",
            ));
        }
    }
}

fn network_marker_node(
    marker: &NetworkMarker,
    provider: RuntimeProviderKind,
    kind: RuntimeNodeKind,
    service_entity_kind: ServiceEntityKind,
    id_prefix: &str,
) -> RuntimeMapNode {
    let mut metadata = BTreeMap::new();
    metadata.insert("source".into(), marker.path.into());
    metadata.insert("product".into(), marker.product.into());
    metadata.insert(
        "serviceEntityKind".into(),
        service_entity_kind_name(&service_entity_kind).into(),
    );
    RuntimeMapNode {
        id: format!(
            "{}_{}_{}",
            id_prefix,
            safe_runtime_id_component(marker.product, "product"),
            safe_runtime_id_component(marker.path, "path")
        ),
        provider,
        kind,
        label: marker.product.into(),
        status: Some("configured".into()),
        layer: Some(RuntimeNodeLayer::Network),
        metadata,
        service: None,
        package: None,
    }
}

fn collect_network_containers(
    snapshot: &DockerSnapshot,
    nodes: &mut Vec<RuntimeMapNode>,
    edges: &mut Vec<RuntimeMapEdge>,
) {
    for container in &snapshot.containers {
        let haystack = format!(
            "{} {} {}",
            container.name.to_ascii_lowercase(),
            container.image.to_ascii_lowercase(),
            container.role.to_ascii_lowercase()
        );
        if let Some(product) = classify_reverse_proxy(&haystack) {
            push_network_container_node(
                nodes,
                edges,
                container,
                RuntimeProviderKind::ReverseProxy,
                RuntimeNodeKind::ReverseProxy,
                product,
            );
        }
        if let Some(product) = classify_local_dns(&haystack) {
            push_network_container_node(
                nodes,
                edges,
                container,
                RuntimeProviderKind::LocalDns,
                RuntimeNodeKind::LocalDnsResolver,
                product,
            );
        }
        if haystack.contains("tailscale") || haystack.contains("tailscaled") {
            push_network_container_node(
                nodes,
                edges,
                container,
                RuntimeProviderKind::Tailscale,
                RuntimeNodeKind::TailnetNode,
                "Tailscale",
            );
        }
        if haystack.contains("headscale") {
            push_network_container_node(
                nodes,
                edges,
                container,
                RuntimeProviderKind::Headscale,
                RuntimeNodeKind::TailnetNode,
                "Headscale",
            );
        }
    }
}

fn push_network_container_node(
    nodes: &mut Vec<RuntimeMapNode>,
    edges: &mut Vec<RuntimeMapEdge>,
    container: &ContainerRecord,
    provider: RuntimeProviderKind,
    kind: RuntimeNodeKind,
    product: &str,
) {
    let id = format!(
        "{}_container_{}",
        sanitize_runtime_id(product),
        sanitize_runtime_id(&container.id)
    );
    let mut metadata = BTreeMap::new();
    metadata.insert("product".into(), product.into());
    metadata.insert("container".into(), container.name.clone());
    metadata.insert("image".into(), container.image.clone());
    let service_entity_kind = match kind {
        RuntimeNodeKind::ReverseProxy => ServiceEntityKind::ReverseProxy,
        RuntimeNodeKind::LocalDnsResolver | RuntimeNodeKind::DnsProvider => {
            ServiceEntityKind::DnsProvider
        }
        _ => ServiceEntityKind::Service,
    };
    metadata.insert(
        "serviceEntityKind".into(),
        service_entity_kind_name(&service_entity_kind).into(),
    );
    nodes.push(RuntimeMapNode {
        id: id.clone(),
        provider,
        kind,
        label: format!("{product}: {}", container.name),
        status: Some(container.status.clone()),
        layer: Some(RuntimeNodeLayer::Container),
        metadata,
        service: Some(RuntimeServiceEntity::minimal(
            container.name.clone(),
            RuntimeServiceStatus::from_status_text(&container.status),
        )),
        package: None,
    });
    edges.push(RuntimeMapEdge {
        source: id,
        target: format!("docker_container_{}", sanitize_runtime_id(&container.id)),
        relationship: RuntimeRelationshipKind::RelatedTo,
        metadata: BTreeMap::new(),
    });
}

struct NetworkMarker {
    product: &'static str,
    path: &'static str,
}

fn reverse_proxy_markers() -> &'static [NetworkMarker] {
    &[
        NetworkMarker {
            product: "nginx",
            path: "/etc/nginx/nginx.conf",
        },
        NetworkMarker {
            product: "Caddy",
            path: "/etc/caddy/Caddyfile",
        },
        NetworkMarker {
            product: "Traefik",
            path: "/etc/traefik/traefik.yml",
        },
        NetworkMarker {
            product: "HAProxy",
            path: "/etc/haproxy/haproxy.cfg",
        },
        NetworkMarker {
            product: "Envoy",
            path: "/etc/envoy/envoy.yaml",
        },
        NetworkMarker {
            product: "Apache httpd",
            path: "/etc/apache2/apache2.conf",
        },
    ]
}

fn local_dns_markers() -> &'static [NetworkMarker] {
    &[
        NetworkMarker {
            product: "Pi-hole",
            path: "/etc/pihole/setupVars.conf",
        },
        NetworkMarker {
            product: "dnsmasq",
            path: "/etc/dnsmasq.d",
        },
        NetworkMarker {
            product: "Unbound",
            path: "/etc/unbound",
        },
        NetworkMarker {
            product: "CoreDNS",
            path: "/etc/coredns/Corefile",
        },
        NetworkMarker {
            product: "AdGuard Home",
            path: "/opt/adguardhome/conf/AdGuardHome.yaml",
        },
    ]
}

fn classify_reverse_proxy(value: &str) -> Option<&'static str> {
    [
        ("nginx-proxy-manager", "Nginx Proxy Manager"),
        ("jc21/nginx-proxy-manager", "Nginx Proxy Manager"),
        ("traefik", "Traefik"),
        ("caddy", "Caddy"),
        ("haproxy", "HAProxy"),
        ("envoy", "Envoy"),
        ("nginx", "nginx"),
        ("apache", "Apache httpd"),
        ("httpd", "Apache httpd"),
        ("cloudflared", "Cloudflare Tunnel"),
        ("frps", "frp"),
        ("frpc", "frp"),
    ]
    .into_iter()
    .find_map(|(needle, product)| value.contains(needle).then_some(product))
}

fn classify_local_dns(value: &str) -> Option<&'static str> {
    [
        ("pihole", "Pi-hole"),
        ("pi-hole", "Pi-hole"),
        ("adguard", "AdGuard Home"),
        ("dnsmasq", "dnsmasq"),
        ("unbound", "Unbound"),
        ("coredns", "CoreDNS"),
        ("technitium", "Technitium DNS"),
    ]
    .into_iter()
    .find_map(|(needle, product)| value.contains(needle).then_some(product))
}

fn path_exists(path: &str) -> bool {
    StdPath::new(path).exists()
}

fn collect_systemd_services(
    nodes: &mut Vec<RuntimeMapNode>,
    edges: &mut Vec<RuntimeMapEdge>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    let system_uptime = system_uptime_seconds_from_proc();
    let output = match run_command_with_timeout(
        {
            let mut command = Command::new("systemctl");
            command.args([
                "list-units",
                "--type=service",
                "--all",
                "--no-legend",
                "--no-pager",
                "--plain",
            ]);
            command
        },
        PROVIDER_COMMAND_TIMEOUT,
    ) {
        Ok(output) => output,
        Err(error) => {
            push_provider_diagnostic(
                diagnostics,
                RuntimeProviderKind::Systemd,
                DiagnosticSeverity::Info,
                format!("systemd discovery skipped: {error}"),
            );
            return;
        }
    };

    if !output.status.success() {
        push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::Systemd,
            DiagnosticSeverity::Warning,
            "systemd discovery command failed".into(),
        );
        return;
    }

    let mut summaries = parse_systemd_list_units(&String::from_utf8_lossy(&output.stdout));
    if summaries.len() > MAX_SYSTEMD_UNITS {
        summaries.truncate(MAX_SYSTEMD_UNITS);
        push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::Systemd,
            DiagnosticSeverity::Info,
            format!("systemd discovery capped at {MAX_SYSTEMD_UNITS} services"),
        );
    }

    let mut details_by_unit = BTreeMap::new();
    if !summaries.is_empty() {
        let units = summaries
            .iter()
            .map(|summary| summary.unit.as_str())
            .collect::<Vec<_>>();
        match run_command_with_timeout(
            {
                let mut command = Command::new("systemctl");
                command.arg("show");
                command.arg("--no-pager");
                command.arg(
                    "--property=Id,ActiveState,SubState,Description,FragmentPath,LoadState,ExecStart,Restart,ActiveEnterTimestamp,ActiveEnterTimestampMonotonic,Requires,Wants,PartOf",
                );
                command.args(units);
                command
            },
            PROVIDER_COMMAND_TIMEOUT,
        ) {
            Ok(show_output) if show_output.status.success() => {
                for detail in
                    parse_systemd_show_records(&String::from_utf8_lossy(&show_output.stdout))
                {
                    if !detail.id.is_empty() {
                        details_by_unit.insert(detail.id.clone(), detail);
                    }
                }
            }
            Ok(_) => push_provider_diagnostic(
                diagnostics,
                RuntimeProviderKind::Systemd,
                DiagnosticSeverity::Warning,
                "systemd show command failed; dependency edges omitted".into(),
            ),
            Err(error) => push_provider_diagnostic(
                diagnostics,
                RuntimeProviderKind::Systemd,
                DiagnosticSeverity::Info,
                format!("systemd dependency discovery skipped: {error}"),
            ),
        }
    }

    let summary_by_unit = summaries
        .iter()
        .map(|summary| (summary.unit.clone(), summary.clone()))
        .collect::<BTreeMap<_, _>>();

    for summary in &summaries {
        let detail = details_by_unit.get(&summary.unit);
        nodes.push(systemd_runtime_node(
            &summary.unit,
            Some(summary),
            detail,
            system_uptime,
        ));
    }

    let mut dependency_reasons = BTreeMap::<(String, String), BTreeSet<String>>::new();
    for detail in details_by_unit.values() {
        for (property, dependency) in systemd_dependency_pairs(detail) {
            let source = systemd_node_id(&detail.id);
            let target = systemd_node_id(&dependency);
            if source == target {
                continue;
            }
            dependency_reasons
                .entry((source, target))
                .or_default()
                .insert(property);
            if !summary_by_unit.contains_key(&dependency) {
                nodes.push(systemd_runtime_node(&dependency, None, None, system_uptime));
            }
        }
    }

    for ((source, target), reasons) in dependency_reasons {
        let mut metadata = BTreeMap::new();
        metadata.insert(
            "systemdProperties".into(),
            reasons.into_iter().collect::<Vec<_>>().join(","),
        );
        edges.push(RuntimeMapEdge {
            source,
            target,
            relationship: RuntimeRelationshipKind::DependsOn,
            metadata,
        });
    }
}

fn parse_systemd_list_units(value: &str) -> Vec<SystemdUnitSummary> {
    value
        .lines()
        .filter_map(|line| {
            let parts = line.split_whitespace().collect::<Vec<_>>();
            if parts.len() < 4 || !parts[0].ends_with(".service") {
                return None;
            }
            Some(SystemdUnitSummary {
                unit: parts[0].to_string(),
                active_state: parts[2].to_string(),
                sub_state: parts[3].to_string(),
                description: parts
                    .get(4..)
                    .map(|items| items.join(" "))
                    .unwrap_or_default(),
            })
        })
        .collect()
}

fn parse_systemd_show_records(value: &str) -> Vec<SystemdUnitDetails> {
    let mut records = Vec::new();
    let mut current = SystemdUnitDetails::default();

    for line in value.lines() {
        if line.trim().is_empty() {
            if !current.id.is_empty() {
                records.push(current);
            }
            current = SystemdUnitDetails::default();
            continue;
        }

        let Some((key, raw_value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let parsed_value = raw_value.trim();
        match key {
            "Id" => current.id = parsed_value.to_string(),
            "ActiveState" => current.active_state = non_empty_string(parsed_value),
            "SubState" => current.sub_state = non_empty_string(parsed_value),
            "Description" => current.description = non_empty_string(parsed_value),
            "FragmentPath" => current.fragment_path = non_empty_string(parsed_value),
            "LoadState" => current.load_state = non_empty_string(parsed_value),
            "ExecStart" => current.exec_start = non_empty_string(parsed_value),
            "Restart" => current.restart = non_empty_string(parsed_value),
            "ActiveEnterTimestamp" => {
                current.active_enter_timestamp = non_empty_string(parsed_value);
            }
            "ActiveEnterTimestampMonotonic" => {
                current.active_enter_monotonic_us = parsed_value.parse::<u64>().ok();
            }
            "Requires" => current.requires = parse_systemd_unit_list(parsed_value),
            "Wants" => current.wants = parse_systemd_unit_list(parsed_value),
            "PartOf" => current.part_of = parse_systemd_unit_list(parsed_value),
            _ => {}
        }
    }

    if !current.id.is_empty() {
        records.push(current);
    }

    records
}

fn parse_systemd_unit_list(value: &str) -> Vec<String> {
    value
        .split_whitespace()
        .filter(|unit| unit.ends_with(".service"))
        .map(str::to_string)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn systemd_dependency_pairs(detail: &SystemdUnitDetails) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    for dependency in &detail.requires {
        pairs.push(("requires".into(), dependency.clone()));
    }
    for dependency in &detail.wants {
        pairs.push(("wants".into(), dependency.clone()));
    }
    for dependency in &detail.part_of {
        pairs.push(("part_of".into(), dependency.clone()));
    }
    pairs
}

fn systemd_runtime_node(
    unit: &str,
    summary: Option<&SystemdUnitSummary>,
    detail: Option<&SystemdUnitDetails>,
    system_uptime: Option<f64>,
) -> RuntimeMapNode {
    let active_state = detail
        .and_then(|value| value.active_state.as_deref())
        .or_else(|| summary.map(|value| value.active_state.as_str()))
        .map(str::to_string);
    let mut metadata = BTreeMap::new();
    metadata.insert("unit".into(), unit.to_string());
    metadata.insert(
        "serviceEntityKind".into(),
        service_entity_kind_name(&classify_systemd_service_entity(detail)).into(),
    );

    if let Some(sub_state) = detail
        .and_then(|value| value.sub_state.as_deref())
        .or_else(|| summary.map(|value| value.sub_state.as_str()))
    {
        metadata.insert("subState".into(), sub_state.to_string());
    }
    if let Some(description) = detail
        .and_then(|value| value.description.as_deref())
        .or_else(|| summary.map(|value| value.description.as_str()))
        .filter(|value| !value.is_empty())
    {
        metadata.insert("description".into(), description.to_string());
    }
    if let Some(fragment_path) = detail.and_then(|value| value.fragment_path.as_deref()) {
        metadata.insert("fragmentPath".into(), fragment_path.to_string());
    }
    if let Some(load_state) = detail.and_then(|value| value.load_state.as_deref()) {
        metadata.insert("loadState".into(), load_state.to_string());
    }
    if let Some(restart) = detail
        .and_then(|value| value.restart.as_deref())
        .filter(|value| !value.is_empty() && *value != "no")
    {
        metadata.insert("restartPolicy".into(), restart.to_string());
    }
    if let Some(active_enter) = detail.and_then(|value| value.active_enter_timestamp.as_deref()) {
        metadata.insert("activeEnter".into(), active_enter.to_string());
    }
    if let Some(uptime) = detail.and_then(|value| systemd_uptime_seconds(value, system_uptime)) {
        metadata.insert("uptimeSeconds".into(), uptime.to_string());
    }

    RuntimeMapNode {
        id: systemd_node_id(unit),
        provider: RuntimeProviderKind::Systemd,
        kind: RuntimeNodeKind::SystemdService,
        label: unit.trim_end_matches(".service").to_string(),
        status: active_state,
        layer: Some(RuntimeNodeLayer::Service),
        metadata,
        service: None,
        package: None,
    }
}

/// Uptime of an active unit in whole seconds, derived from the monotonic
/// active-enter clock and `/proc/uptime`. Returns `None` when the unit is not
/// currently active or the host does not expose `/proc/uptime`.
fn systemd_uptime_seconds(detail: &SystemdUnitDetails, system_uptime: Option<f64>) -> Option<u64> {
    if detail.active_state.as_deref() != Some("active") {
        return None;
    }
    let monotonic_us = detail.active_enter_monotonic_us?;
    let uptime = system_uptime?;
    let seconds = (uptime - monotonic_us as f64 / 1_000_000.0).max(0.0);
    Some(seconds.round() as u64)
}

fn system_uptime_seconds_from_proc() -> Option<f64> {
    let content = fs::read_to_string("/proc/uptime").ok()?;
    content.split_whitespace().next()?.parse::<f64>().ok()
}

fn classify_systemd_service_entity(detail: Option<&SystemdUnitDetails>) -> ServiceEntityKind {
    let Some(exec_start) = detail.and_then(|value| value.exec_start.as_deref()) else {
        return ServiceEntityKind::Service;
    };
    let haystack = exec_start.to_ascii_lowercase();
    if looks_like_ai_agent(&haystack) {
        ServiceEntityKind::AiAgent
    } else if haystack.contains("python")
        || haystack.contains(".py")
        || haystack.contains("uvicorn")
        || haystack.contains("gunicorn")
        || haystack.contains("celery")
    {
        ServiceEntityKind::PythonApplication
    } else if haystack.contains("node")
        || haystack.contains("npm")
        || haystack.contains("npx")
        || haystack.contains(".js")
        || haystack.contains(".mjs")
    {
        ServiceEntityKind::NodeApplication
    } else {
        ServiceEntityKind::Service
    }
}

fn systemd_node_id(unit: &str) -> String {
    format!(
        "systemd_service_{}",
        safe_runtime_id_component(unit, "redacted")
    )
}

fn collect_scheduled_jobs(
    nodes: &mut Vec<RuntimeMapNode>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    let mut job_sources = Vec::new();
    read_cron_file(StdPath::new("/etc/crontab"), &mut job_sources);

    if let Ok(entries) = fs::read_dir("/etc/cron.d") {
        for entry in entries.flatten() {
            read_cron_file(&entry.path(), &mut job_sources);
        }
    }

    match run_command_with_timeout(
        {
            let mut command = Command::new("crontab");
            command.arg("-l");
            command
        },
        PROVIDER_COMMAND_TIMEOUT,
    ) {
        Ok(output) if output.status.success() => {
            for (index, line) in String::from_utf8_lossy(&output.stdout).lines().enumerate() {
                if let Some(command) = cron_command(line, true) {
                    job_sources.push(("user crontab".into(), index + 1, command));
                }
            }
        }
        Ok(_) => {}
        Err(error) => push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::ScheduledJob,
            DiagnosticSeverity::Info,
            format!("user crontab discovery skipped: {error}"),
        ),
    }

    for (source, line, command) in job_sources {
        let safe_command = redact_sensitive_text(&command);
        let mut metadata = BTreeMap::new();
        metadata.insert("source".into(), source.clone());
        metadata.insert("line".into(), line.to_string());
        metadata.insert("command".into(), safe_command.clone());
        nodes.push(RuntimeMapNode {
            id: format!(
                "scheduled_job_{}_{}",
                safe_runtime_id_component(&source, "source"),
                safe_runtime_id_component(&format!("{line}_{safe_command}"), "command")
            ),
            provider: RuntimeProviderKind::ScheduledJob,
            kind: RuntimeNodeKind::ScheduledJob,
            label: safe_command,
            status: Some("scheduled".into()),
            layer: Some(RuntimeNodeLayer::Process),
            metadata,
            service: None,
            package: None,
        });
    }
}

fn read_cron_file(path: &StdPath, jobs: &mut Vec<(String, usize, String)>) {
    let Ok(content) = fs::read_to_string(path) else {
        return;
    };
    for (index, line) in content.lines().enumerate() {
        if let Some(command) = cron_command(line, false) {
            jobs.push((path.display().to_string(), index + 1, command));
        }
    }
}

fn cron_command(line: &str, user_crontab: bool) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    if trimmed.starts_with('@') {
        return trimmed
            .split_once(char::is_whitespace)
            .map(|(_, command)| command.trim().to_string())
            .filter(|command| !command.is_empty());
    }

    let fields = trimmed.split_whitespace().collect::<Vec<_>>();
    let command_start = if user_crontab { 5 } else { 6 };
    if fields.len() <= command_start {
        return None;
    }
    Some(fields[command_start..].join(" "))
}

fn collect_pm2_apps(nodes: &mut Vec<RuntimeMapNode>, diagnostics: &mut Vec<RuntimeMapDiagnostic>) {
    let output = match run_command_with_timeout(
        {
            let mut command = Command::new("pm2");
            command.arg("jlist");
            command
        },
        PROVIDER_COMMAND_TIMEOUT,
    ) {
        Ok(output) => output,
        Err(error) => {
            push_provider_diagnostic(
                diagnostics,
                RuntimeProviderKind::Pm2,
                DiagnosticSeverity::Info,
                format!("PM2 discovery skipped: {error}"),
            );
            return;
        }
    };

    if !output.status.success() {
        push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::Pm2,
            DiagnosticSeverity::Warning,
            "PM2 discovery command failed".into(),
        );
        return;
    }

    let Ok(apps) = serde_json::from_slice::<Vec<serde_json::Value>>(&output.stdout) else {
        push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::Pm2,
            DiagnosticSeverity::Warning,
            "PM2 discovery returned invalid JSON".into(),
        );
        return;
    };

    for app in apps {
        let id = value_to_string(app.get("pm_id")).unwrap_or_else(|| "unknown".into());
        let env = app.get("pm2_env").unwrap_or(&serde_json::Value::Null);
        let name = env
            .get("name")
            .and_then(serde_json::Value::as_str)
            .or_else(|| app.get("name").and_then(serde_json::Value::as_str))
            .unwrap_or("pm2-app");
        let status = env
            .get("status")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let mut metadata = BTreeMap::new();
        if let Some(cwd) = env.get("pm_cwd").and_then(serde_json::Value::as_str) {
            metadata.insert("cwd".into(), cwd.into());
        }
        if let Some(script) = env.get("pm_exec_path").and_then(serde_json::Value::as_str) {
            metadata.insert("script".into(), script.into());
        }
        if let Some(restarts) = env.get("restart_time").and_then(serde_json::Value::as_i64) {
            metadata.insert("restartCount".into(), restarts.to_string());
        }
        metadata.insert(
            "serviceEntityKind".into(),
            service_entity_kind_name(&ServiceEntityKind::NodeApplication).into(),
        );
        nodes.push(RuntimeMapNode {
            id: format!("pm2_app_{}", sanitize_runtime_id(&id)),
            provider: RuntimeProviderKind::Pm2,
            kind: RuntimeNodeKind::Pm2App,
            label: name.into(),
            status,
            layer: Some(RuntimeNodeLayer::Process),
            metadata,
            service: None,
            package: None,
        });
    }
}

fn collect_tmux_sessions(
    nodes: &mut Vec<RuntimeMapNode>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    let output = match run_command_with_timeout(
        {
            let mut command = Command::new("tmux");
            command.args([
                "list-sessions",
                "-F",
                "#{session_id}\t#{session_name}\t#{session_attached}\t#{session_windows}",
            ]);
            command
        },
        PROVIDER_COMMAND_TIMEOUT,
    ) {
        Ok(output) => output,
        Err(error) => {
            push_provider_diagnostic(
                diagnostics,
                RuntimeProviderKind::Tmux,
                DiagnosticSeverity::Info,
                format!("tmux discovery skipped: {error}"),
            );
            return;
        }
    };

    if !output.status.success() {
        return;
    }

    nodes.extend(tmux_session_nodes_from_output(&String::from_utf8_lossy(
        &output.stdout,
    )));
}

fn tmux_session_nodes_from_output(value: &str) -> Vec<RuntimeMapNode> {
    let mut nodes = Vec::new();
    for line in value.lines() {
        let parts = line.split('\t').collect::<Vec<_>>();
        if parts.len() < 4 {
            continue;
        }
        let mut metadata = BTreeMap::new();
        metadata.insert("sessionId".into(), parts[0].into());
        metadata.insert("windows".into(), parts[3].into());
        metadata.insert(
            "serviceEntityKind".into(),
            service_entity_kind_name(&ServiceEntityKind::Session).into(),
        );
        nodes.push(RuntimeMapNode {
            id: format!(
                "tmux_session_{}",
                safe_runtime_id_component(parts[0], "session")
            ),
            provider: RuntimeProviderKind::Tmux,
            kind: RuntimeNodeKind::TmuxSession,
            label: parts[1].into(),
            status: Some(
                if parts[2] == "0" {
                    "detached"
                } else {
                    "attached"
                }
                .into(),
            ),
            layer: Some(RuntimeNodeLayer::Session),
            metadata,
            service: None,
            package: None,
        });
    }
    nodes
}

fn collect_npm_projects(
    project_root: &StdPath,
    nodes: &mut Vec<RuntimeMapNode>,
    edges: &mut Vec<RuntimeMapEdge>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    let projects = discover_npm_projects(project_root, diagnostics);
    for (project_index, project) in projects.into_iter().enumerate() {
        let relative_path = project
            .directory
            .strip_prefix(project_root)
            .unwrap_or(project.directory.as_path())
            .display()
            .to_string();
        let node_id = format!(
            "npm_project_{}",
            safe_runtime_id_component(&relative_path, &format!("project_{project_index}"))
        );
        let mut metadata = BTreeMap::new();
        metadata.insert("path".into(), relative_path.clone());
        metadata.insert(
            "serviceEntityKind".into(),
            service_entity_kind_name(&project.service_entity_kind).into(),
        );
        metadata.insert("private".into(), project.private.to_string());
        if let Some(package_name) = &project.package_name {
            metadata.insert("packageName".into(), package_name.clone());
        }
        if let Some(package_manager) = &project.package_manager {
            metadata.insert("packageManager".into(), package_manager.clone());
        }
        if !project.lockfiles.is_empty() {
            metadata.insert("lockfiles".into(), project.lockfiles.join(","));
        }
        if !project.framework_hints.is_empty() {
            metadata.insert("frameworks".into(), project.framework_hints.join(","));
        }
        if !project.scripts.is_empty() {
            let scripts = project
                .scripts
                .iter()
                .map(|(name, script)| format!("{name}={script}"))
                .collect::<Vec<_>>()
                .join(" | ");
            metadata.insert("scripts".into(), truncate_chars(&scripts, 1_600));
        }
        nodes.push(RuntimeMapNode {
            id: node_id.clone(),
            provider: RuntimeProviderKind::Npm,
            kind: project.kind.clone(),
            label: project.display_name.clone(),
            status: Some("discovered".into()),
            layer: Some(RuntimeNodeLayer::Package),
            metadata,
            service: None,
            package: None,
        });
        edges.push(RuntimeMapEdge {
            source: node_id.clone(),
            target: "host_local".into(),
            relationship: RuntimeRelationshipKind::RunsOn,
            metadata: BTreeMap::new(),
        });

        for (index, dependency) in project.dependencies.into_iter().enumerate() {
            let safe_package_name = redact_sensitive_text(&dependency.name);
            let safe_version = redact_sensitive_text(&dependency.version);
            let safe_scope = redact_sensitive_text(&dependency.scope);
            let package_id = format!(
                "npm_package_{}_{}",
                safe_runtime_id_component(&safe_package_name, "package"),
                if safe_version == REDACTED_VALUE {
                    format!("redacted_{index}")
                } else {
                    safe_runtime_id_component(&safe_version, "version")
                }
            );
            let mut package_metadata = BTreeMap::new();
            package_metadata.insert("package".into(), safe_package_name.clone());
            package_metadata.insert("version".into(), safe_version.clone());
            package_metadata.insert("scope".into(), safe_scope.clone());
            package_metadata.insert(
                "serviceEntityKind".into(),
                service_entity_kind_name(&ServiceEntityKind::PackageDependency).into(),
            );
            nodes.push(RuntimeMapNode {
                id: package_id.clone(),
                provider: RuntimeProviderKind::Npm,
                kind: RuntimeNodeKind::PackageDependency,
                label: safe_package_name.clone(),
                status: None,
                layer: Some(RuntimeNodeLayer::Package),
                metadata: package_metadata,
                service: None,
                package: Some(RuntimePackageEntity::minimal(
                    safe_package_name.clone(),
                    safe_version.clone(),
                )),
            });

            let mut dependency_metadata = BTreeMap::new();
            dependency_metadata.insert("version".into(), safe_version);
            dependency_metadata.insert("scope".into(), safe_scope);
            edges.push(RuntimeMapEdge {
                source: node_id.clone(),
                target: package_id,
                relationship: RuntimeRelationshipKind::DependsOn,
                metadata: dependency_metadata,
            });
        }
    }
}

fn discover_npm_projects(
    project_root: &StdPath,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) -> Vec<NpmProjectSummary> {
    let mut projects = Vec::new();
    let mut pending = vec![project_root.to_path_buf()];
    let mut visited_dirs = 0usize;

    while let Some(directory) = pending.pop() {
        visited_dirs += 1;
        if visited_dirs > MAX_DISCOVERY_DIRS {
            push_provider_diagnostic(
                diagnostics,
                RuntimeProviderKind::Npm,
                DiagnosticSeverity::Info,
                format!("npm discovery capped at {MAX_DISCOVERY_DIRS} directories"),
            );
            break;
        }

        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) => {
                push_provider_diagnostic(
                    diagnostics,
                    RuntimeProviderKind::Npm,
                    DiagnosticSeverity::Info,
                    format!("npm discovery skipped `{}`: {error}", directory.display()),
                );
                continue;
            }
        };

        let mut child_dirs = Vec::new();
        let mut has_package_json = false;
        let mut lockfiles = Vec::new();

        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();
            if file_type.is_dir() {
                if !should_skip_discovery_dir(&name) {
                    child_dirs.push(path);
                }
            } else if file_type.is_file() {
                if name == "package.json" {
                    has_package_json = true;
                } else if is_node_lockfile(&name) {
                    lockfiles.push(name);
                }
            }
        }

        child_dirs.sort();
        pending.extend(child_dirs.into_iter().rev());

        if !has_package_json && lockfiles.is_empty() {
            continue;
        }
        if projects.len() >= MAX_NPM_PROJECTS {
            push_provider_diagnostic(
                diagnostics,
                RuntimeProviderKind::Npm,
                DiagnosticSeverity::Info,
                format!("npm discovery capped at {MAX_NPM_PROJECTS} projects"),
            );
            break;
        }

        match summarize_npm_project(project_root, &directory, &lockfiles) {
            Ok(Some(project)) => projects.push(project),
            Ok(None) => {}
            Err(error) => push_provider_diagnostic(
                diagnostics,
                RuntimeProviderKind::Npm,
                DiagnosticSeverity::Warning,
                format!("npm project `{}` skipped: {error}", directory.display()),
            ),
        }
    }

    projects.sort_by(|left, right| left.directory.cmp(&right.directory));
    projects
}

fn summarize_npm_project(
    project_root: &StdPath,
    directory: &StdPath,
    lockfiles: &[String],
) -> Result<Option<NpmProjectSummary>, String> {
    let package_json_path = directory.join("package.json");
    let manifest = if package_json_path.is_file() {
        Some(read_package_manifest(&package_json_path)?)
    } else {
        None
    };

    if manifest.is_none() && lockfiles.is_empty() {
        return Ok(None);
    }

    let relative_path = directory
        .strip_prefix(project_root)
        .unwrap_or(directory)
        .display()
        .to_string();
    let display_name = manifest
        .as_ref()
        .and_then(|value| value.name.clone())
        .or_else(|| {
            directory
                .file_name()
                .and_then(|value| value.to_str())
                .map(str::to_string)
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            if relative_path.is_empty() {
                "project-root".into()
            } else {
                relative_path.clone()
            }
        });

    let dependencies = manifest
        .as_ref()
        .map(package_manifest_dependencies)
        .unwrap_or_default();
    let (kind, service_entity_kind) = manifest.as_ref().map(classify_package_manifest).unwrap_or((
        RuntimeNodeKind::NodeApplication,
        ServiceEntityKind::NodeApplication,
    ));
    let scripts = manifest
        .as_ref()
        .map(|value| bounded_package_scripts(&value.scripts))
        .unwrap_or_default();
    let framework_hints = manifest
        .as_ref()
        .map(classify_package_frameworks)
        .unwrap_or_default();

    Ok(Some(NpmProjectSummary {
        directory: directory.to_path_buf(),
        package_name: manifest
            .as_ref()
            .and_then(|value| value.name.clone())
            .map(|value| redact_sensitive_text(&value)),
        display_name: redact_sensitive_text(&display_name),
        kind,
        service_entity_kind,
        package_manager: manifest
            .as_ref()
            .and_then(|value| value.package_manager.clone())
            .map(|value| redact_sensitive_text(&value)),
        lockfiles: lockfiles.to_vec(),
        dependencies,
        scripts,
        framework_hints,
        private: manifest
            .as_ref()
            .map(|value| value.private)
            .unwrap_or(false),
    }))
}

fn bounded_package_scripts(scripts: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    scripts
        .iter()
        .take(MAX_NPM_SCRIPTS)
        .map(|(name, script)| {
            (
                redact_sensitive_text(name),
                truncate_chars(&redact_sensitive_text(script), MAX_SCRIPT_CHARS),
            )
        })
        .collect()
}

/// Known framework markers mapped to friendly names. Matched against package
/// names (all dependency sections) and script names so common stacks surface
/// without registry lookups. Kept bounded and offline by design.
const FRAMEWORK_MARKERS: &[(&str, &str)] = &[
    ("@nestjs/core", "NestJS"),
    ("@remix-run/react", "Remix"),
    ("@sveltejs/kit", "SvelteKit"),
    ("@vitejs/plugin-react", "Vite"),
    ("angular/core", "Angular"),
    ("astro", "Astro"),
    ("docusaurus", "Docusaurus"),
    ("electron", "Electron"),
    ("expo", "Expo"),
    ("express", "Express"),
    ("fastify", "Fastify"),
    ("gatsby", "Gatsby"),
    ("hono", "Hono"),
    ("next", "Next.js"),
    ("nuxt", "Nuxt"),
    ("react", "React"),
    ("solid-js", "Solid"),
    ("svelte", "Svelte"),
    ("tauri", "Tauri"),
    ("vite", "Vite"),
    ("vue", "Vue"),
];

fn classify_package_frameworks(manifest: &PackageManifestDocument) -> Vec<String> {
    let mut haystacks = manifest.scripts.keys().cloned().collect::<Vec<_>>();
    for section in [
        &manifest.dependencies,
        &manifest.dev_dependencies,
        &manifest.optional_dependencies,
        &manifest.peer_dependencies,
    ] {
        haystacks.extend(section.keys().cloned());
    }

    let mut hints = Vec::new();
    for (marker, name) in FRAMEWORK_MARKERS {
        if hints.len() >= 4 {
            break;
        }
        if haystacks.iter().any(|value| value.contains(marker))
            && !hints.contains(&name.to_string())
        {
            hints.push(name.to_string());
        }
    }
    hints
}

fn read_package_manifest(path: &StdPath) -> Result<PackageManifestDocument, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("cannot inspect `{}`: {error}", path.display()))?;
    if metadata.len() > MAX_PACKAGE_JSON_BYTES {
        return Err(format!(
            "`{}` exceeds {} bytes",
            path.display(),
            MAX_PACKAGE_JSON_BYTES
        ));
    }
    let content = fs::read_to_string(path)
        .map_err(|error| format!("cannot read `{}`: {error}", path.display()))?;
    serde_json::from_str(&content)
        .map_err(|error| format!("invalid JSON in `{}`: {error}", path.display()))
}

fn package_manifest_dependencies(
    manifest: &PackageManifestDocument,
) -> Vec<PackageDependencyRecord> {
    let mut dependencies = Vec::new();
    collect_dependency_scope("dependencies", &manifest.dependencies, &mut dependencies);
    collect_dependency_scope(
        "optional_dependencies",
        &manifest.optional_dependencies,
        &mut dependencies,
    );
    collect_dependency_scope(
        "peer_dependencies",
        &manifest.peer_dependencies,
        &mut dependencies,
    );
    collect_dependency_scope(
        "dev_dependencies",
        &manifest.dev_dependencies,
        &mut dependencies,
    );
    dependencies.truncate(MAX_NPM_DEPENDENCIES_PER_PROJECT);
    dependencies
}

fn collect_dependency_scope(
    scope: &str,
    entries: &BTreeMap<String, String>,
    output: &mut Vec<PackageDependencyRecord>,
) {
    for (name, version) in entries {
        output.push(PackageDependencyRecord {
            name: redact_sensitive_text(name),
            version: redact_sensitive_text(version),
            scope: scope.to_string(),
        });
    }
}

fn classify_package_manifest(
    manifest: &PackageManifestDocument,
) -> (RuntimeNodeKind, ServiceEntityKind) {
    let mut haystack = Vec::new();
    if let Some(name) = &manifest.name {
        haystack.push(name.to_ascii_lowercase());
    }
    haystack.extend(
        manifest
            .scripts
            .keys()
            .map(|value| value.to_ascii_lowercase()),
    );
    haystack.extend(
        manifest
            .scripts
            .values()
            .map(|value| value.to_ascii_lowercase()),
    );
    haystack.extend(
        manifest
            .dependencies
            .keys()
            .chain(manifest.optional_dependencies.keys())
            .chain(manifest.peer_dependencies.keys())
            .chain(manifest.dev_dependencies.keys())
            .map(|value| value.to_ascii_lowercase()),
    );

    if haystack.iter().any(|value| looks_like_ai_agent(value)) {
        (RuntimeNodeKind::AiAgent, ServiceEntityKind::AiAgent)
    } else {
        (
            RuntimeNodeKind::NodeApplication,
            ServiceEntityKind::NodeApplication,
        )
    }
}

fn should_skip_discovery_dir(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | ".hg"
            | ".svn"
            | "node_modules"
            | "dist"
            | "build"
            | "target"
            | "coverage"
            | ".next"
            | ".turbo"
            | ".yarn"
            | ".pnpm-store"
            | ".venv"
            | "venv"
            | "__pycache__"
    )
}

fn is_node_lockfile(name: &str) -> bool {
    matches!(
        name,
        "package-lock.json" | "npm-shrinkwrap.json" | "pnpm-lock.yaml" | "yarn.lock"
    )
}

fn looks_like_ai_agent(value: &str) -> bool {
    [
        "openai",
        "anthropic",
        "langchain",
        "llamaindex",
        "autogen",
        "crewai",
        "agent",
        "@modelcontextprotocol/sdk",
    ]
    .into_iter()
    .any(|needle| value.contains(needle))
}

fn local_hostname() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            fs::read_to_string("/etc/hostname")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "localhost".into())
        })
}

fn non_empty_string(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn redact_runtime_map(runtime_map: &mut RuntimeMap) {
    redact_runtime_nodes(&mut runtime_map.nodes);
    redact_runtime_edges(&mut runtime_map.edges);
    redact_runtime_diagnostics(&mut runtime_map.diagnostics);
}

fn redact_runtime_nodes(nodes: &mut [RuntimeMapNode]) {
    for node in nodes {
        redact_runtime_node(node);
    }
}

fn redact_runtime_node(node: &mut RuntimeMapNode) {
    node.label = redact_sensitive_text(&node.label);
    if let Some(status) = &mut node.status {
        *status = redact_sensitive_text(status);
    }
    for value in node.metadata.values_mut() {
        *value = redact_sensitive_text(value);
    }
    redact_service_entity(node.service.as_mut());
    redact_package_entity(node.package.as_mut());
}

fn redact_service_entity(service: Option<&mut RuntimeServiceEntity>) {
    let Some(service) = service else {
        return;
    };
    service.name = redact_sensitive_text(&service.name);
    // service.status is the closed RuntimeServiceStatus enum: raw provider
    // text is normalized through from_status_text before it ever reaches the
    // struct, so it cannot carry secrets and needs no redaction.
    for value in &mut service.dependencies {
        *value = redact_sensitive_text(value);
    }
    for value in &mut service.dependents {
        *value = redact_sensitive_text(value);
    }
    if let Some(health) = &mut service.health {
        // health.state is the closed RuntimeHealthState enum (safe by construction).
        if let Some(source) = &mut health.source {
            *source = redact_sensitive_text(source);
        }
        if let Some(message) = &mut health.message {
            *message = redact_sensitive_text(message);
        }
    }
    for log in &mut service.logs {
        log.source = redact_sensitive_text(&log.source);
        // log.level is the closed RuntimeLogLevel enum (safe by construction).
    }
    for event in &mut service.events {
        event.kind = redact_sensitive_text(&event.kind);
        if let Some(message) = &mut event.message {
            *message = redact_sensitive_text(message);
        }
    }
    redact_ownership(service.owner.as_mut());
    redact_location(service.location.as_mut());
}

fn redact_package_entity(package: Option<&mut RuntimePackageEntity>) {
    let Some(package) = package else {
        return;
    };
    package.name = redact_sensitive_text(&package.name);
    package.version = redact_sensitive_text(&package.version);
    for value in &mut package.dependencies {
        *value = redact_sensitive_text(value);
    }
    for value in &mut package.dependents {
        *value = redact_sensitive_text(value);
    }
    if let Some(update) = &mut package.update {
        update.current_version = redact_sensitive_text(&update.current_version);
        if let Some(latest) = &mut update.latest_version {
            *latest = redact_sensitive_text(latest);
        }
        for advisory in &mut update.advisories {
            advisory.title = redact_sensitive_text(&advisory.title);
            advisory.source = redact_sensitive_text(&advisory.source);
            if let Some(fixed) = &mut advisory.fixed_version {
                *fixed = redact_sensitive_text(fixed);
            }
            if let Some(url) = &mut advisory.url {
                *url = redact_sensitive_text(url);
            }
        }
    }
    redact_ownership(package.owner.as_mut());
    redact_location(package.location.as_mut());
}

fn redact_ownership(owner: Option<&mut RuntimeOwnership>) {
    let Some(owner) = owner else {
        return;
    };
    owner.name = redact_sensitive_text(&owner.name);
    if let Some(id) = &mut owner.id {
        *id = redact_sensitive_text(id);
    }
}

fn redact_location(location: Option<&mut RuntimeLocation>) {
    let Some(location) = location else {
        return;
    };
    location.value = redact_sensitive_text(&location.value);
    if let Some(detail) = &mut location.detail {
        *detail = redact_sensitive_text(detail);
    }
}

fn redact_runtime_edges(edges: &mut [RuntimeMapEdge]) {
    for edge in edges {
        for value in edge.metadata.values_mut() {
            *value = redact_sensitive_text(value);
        }
    }
}

fn redact_runtime_diagnostics(diagnostics: &mut [RuntimeMapDiagnostic]) {
    for diagnostic in diagnostics {
        diagnostic.message = redact_sensitive_text(&diagnostic.message);
    }
}

/// Redact secret-bearing free-text fields from a compose scan before it is
/// returned by the API. Environment VALUES are redacted (keys stay so the
/// shape remains useful), and mount/correlation path fields are redacted for
/// consistency with provider metadata redaction.
fn redact_compose_scan(scan: &mut ComposeScan) {
    for service in &mut scan.services {
        for value in service.environment.values_mut() {
            *value = redact_sensitive_text(value);
        }
    }
    for mount in &mut scan.mounts {
        if let Some(source) = &mut mount.source {
            *source = redact_sensitive_text(source);
        }
        if let Some(source) = &mut mount.resolved_source {
            *source = redact_sensitive_text(source);
        }
    }
    for correlation in &mut scan.correlations {
        if let Some(source) = &mut correlation.declared_source {
            *source = redact_sensitive_text(source);
        }
        if let Some(source) = &mut correlation.runtime_source {
            *source = redact_sensitive_text(source);
        }
    }
    for diagnostic in &mut scan.diagnostics {
        diagnostic.message = redact_sensitive_text(&diagnostic.message);
    }
}

/// Redact secret-bearing lines from a unified diff body while keeping the
/// diff readable: each `+`/`-`/context line keeps its marker, but its content
/// is replaced with `[redacted]` when it looks sensitive.
fn redact_unified_diff(diff: &str) -> String {
    diff.lines()
        .map(|line| {
            let (marker, rest) = match line.chars().next() {
                Some('+') => ("+", &line[1..]),
                Some('-') => ("-", &line[1..]),
                Some(' ') => (" ", &line[1..]),
                _ => ("", line),
            };
            if is_sensitive_text(rest) {
                format!("{marker}{REDACTED_VALUE}")
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn redact_sensitive_text(value: &str) -> String {
    if is_sensitive_text(value) {
        REDACTED_VALUE.into()
    } else {
        value.to_string()
    }
}

fn is_sensitive_text(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("dockermap_test_fake_")
        || contains_url_userinfo(value)
        || contains_sensitive_assignment(&lower)
        || contains_sensitive_flag(&lower)
        || contains_auth_scheme(&lower)
}

fn contains_url_userinfo(value: &str) -> bool {
    let Some(scheme_index) = value.find("://") else {
        return false;
    };
    let authority_start = scheme_index + 3;
    let authority = &value[authority_start..];
    let authority_end = authority.find(['/', '?', '#']).unwrap_or(authority.len());
    authority[..authority_end].contains('@')
}

fn contains_sensitive_assignment(value: &str) -> bool {
    [
        "token=",
        "token:",
        "auth_token=",
        "auth_token:",
        "_authtoken=",
        "_authtoken:",
        "_auth=",
        "_auth:",
        "api_key=",
        "api_key:",
        "api-key=",
        "api-key:",
        "apikey=",
        "apikey:",
        "x-api-key=",
        "x-api-key:",
        "secret_key=",
        "secret_key:",
        "secret-key=",
        "secret-key:",
        "secret_access_key=",
        "secret_access_key:",
        "secret-access-key=",
        "secret-access-key:",
        "aws_secret_access_key=",
        "aws_secret_access_key:",
        "authorization=",
        "authorization:",
        "password=",
        "password:",
        "passwd=",
        "passwd:",
        "secret=",
        "secret:",
        "client_secret=",
        "client_secret:",
        "private_key=",
        "private_key:",
        "credential=",
        "credential:",
        "access_token=",
        "access_token:",
        "refresh_token=",
        "refresh_token:",
    ]
    .into_iter()
    .any(|needle| value.contains(needle))
}

fn contains_sensitive_flag(value: &str) -> bool {
    let flags = [
        "--token",
        "--auth",
        "--api-key",
        "--authorization",
        "--password",
        "--secret",
        "--client-secret",
        "--private-key",
    ];
    value.split_whitespace().any(|token| {
        flags
            .into_iter()
            .any(|flag| token == flag || token.starts_with(&format!("{flag}=")))
    })
}

fn contains_auth_scheme(value: &str) -> bool {
    let trimmed = value.trim_start();
    trimmed.starts_with("bearer ")
        || value.contains("authorization: bearer")
        || value.contains("authorization: basic")
        || value.contains("authorization=bearer")
        || value.contains("authorization=basic")
}

fn safe_runtime_id_component(value: &str, fallback: &str) -> String {
    let redacted = redact_sensitive_text(value);
    if redacted == REDACTED_VALUE {
        fallback.into()
    } else {
        let sanitized = sanitize_runtime_id(&redacted);
        if sanitized.is_empty() {
            fallback.into()
        } else {
            sanitized
        }
    }
}

fn collect_network_listeners(
    nodes: &mut Vec<RuntimeMapNode>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    for path in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let Ok(content) = fs::read_to_string(path) else {
            push_provider_diagnostic(
                diagnostics,
                RuntimeProviderKind::Network,
                DiagnosticSeverity::Info,
                format!("network listener discovery skipped for {path}"),
            );
            continue;
        };
        for line in content.lines().skip(1) {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            if fields.len() < 10 || fields[3] != "0A" {
                continue;
            }
            let Some((address, port)) = parse_proc_net_local_address(fields[1]) else {
                continue;
            };
            let mut metadata = BTreeMap::new();
            metadata.insert("address".into(), address.clone());
            metadata.insert("port".into(), port.to_string());
            metadata.insert("socketInode".into(), fields[9].into());
            nodes.push(RuntimeMapNode {
                id: format!(
                    "network_listener_{}_{}",
                    sanitize_runtime_id(&address),
                    port
                ),
                provider: RuntimeProviderKind::Network,
                kind: RuntimeNodeKind::NetworkListener,
                label: format!("{address}:{port}"),
                status: Some("listening".into()),
                layer: Some(RuntimeNodeLayer::Host),
                metadata,
                service: None,
                package: None,
            });
        }
    }
}

fn parse_proc_net_local_address(value: &str) -> Option<(String, u16)> {
    let (raw_address, raw_port) = value.split_once(':')?;
    let port = u16::from_str_radix(raw_port, 16).ok()?;
    let address = if raw_address.len() == 8 {
        let bytes = (0..4)
            .filter_map(|index| u8::from_str_radix(&raw_address[index * 2..index * 2 + 2], 16).ok())
            .collect::<Vec<_>>();
        if bytes.len() != 4 {
            return None;
        }
        format!("{}.{}.{}.{}", bytes[3], bytes[2], bytes[1], bytes[0])
    } else {
        raw_address.to_ascii_lowercase()
    };
    Some((address, port))
}

fn value_to_string(value: Option<&serde_json::Value>) -> Option<String> {
    match value {
        Some(serde_json::Value::String(value)) => Some(value.clone()),
        Some(serde_json::Value::Number(value)) => Some(value.to_string()),
        _ => None,
    }
}

fn push_provider_diagnostic(
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
    provider: RuntimeProviderKind,
    severity: DiagnosticSeverity,
    message: String,
) {
    // Provider failures (tailscale/systemd/pm2/tmux/crontab/... subprocesses)
    // must be visible in the daemon's stderr, not just in-band in the runtime
    // map. Messages here are static or spawn/timeout error strings — no
    // provider output is included, so nothing secret can leak.
    eprintln!("provider diagnostic ({provider:?}, {severity:?}): {message}");
    diagnostics.push(RuntimeMapDiagnostic {
        provider,
        severity,
        message,
    });
}

fn sanitize_runtime_id(value: &str) -> String {
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

async fn get_runtime_map(State(state): State<AppState>) -> Json<RuntimeMap> {
    // Served from the cache: the map is recomputed on the refresh cadence
    // (off the async runtime, with per-provider timeouts) instead of on every
    // request, which previously ran ~8 blocking provider subprocesses
    // synchronously on a Tokio worker per call.
    let cache = state.cache.read().await;
    Json(cache.runtime_map.clone())
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
    let cursor = parse_log_cursor(query.cursor.as_deref())?;
    let limit = parse_log_limit(query.limit)?;
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
            // Live mode has no service-scoped view of "all logs" — fabricating
            // mock entries would attribute invented lines to real containers.
            // Clients must name a service (or run in explicit mock mode).
            return Ok(Json(LogsResponse {
                service: None,
                entries: Vec::new(),
                next_cursor: None,
            }));
        };
        let collector = docker_collector(&state).await.map_err(|message| ApiError {
            status: StatusCode::BAD_GATEWAY,
            message,
        })?;
        collector
            .collect_logs(service, q, cursor, limit)
            .await
            .map_err(|message| ApiError {
                status: StatusCode::BAD_GATEWAY,
                message,
            })?
    } else {
        mock_logs(&snapshot, service, q, cursor, limit)
    };

    Ok(Json(response))
}

async fn get_compose_scan(
    State(state): State<AppState>,
    Query(query): Query<ComposeScanQuery>,
) -> Result<Json<ComposeScan>, ApiError> {
    let mut scan = scan_compose_query(query).await?;
    let cache = state.cache.read().await;
    scan.correlations = correlate_compose_runtime(&scan, &cache.snapshot);
    redact_compose_scan(&mut scan);
    Ok(Json(scan))
}

async fn get_compose_graph(
    Query(query): Query<ComposeScanQuery>,
) -> Result<Json<ComposeGraph>, ApiError> {
    let mut scan = scan_compose_query(query).await?;
    // Bind sources are embedded in graph node ids and labels, so the scan must
    // be redacted BEFORE deriving the graph — otherwise secrets in mount
    // sources (inline auth URLs, token= patterns) leak through this endpoint.
    redact_compose_scan(&mut scan);
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

    let mut plan = plan_compose_mount_edit(&file, &content, mount, source, target);
    plan.unified_diff = redact_unified_diff(&plan.unified_diff);
    Ok(Json(plan))
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

fn parse_log_cursor(value: Option<&str>) -> Result<Option<u64>, ApiError> {
    validate_optional_query(value, "cursor", 32)?
        .map(|value| {
            value.parse::<u64>().map_err(|_| ApiError {
                status: StatusCode::BAD_REQUEST,
                message: "query parameter `cursor` must be a non-negative integer".into(),
            })
        })
        .transpose()
}

fn parse_log_limit(value: Option<usize>) -> Result<usize, ApiError> {
    match value {
        Some(value) if (1..=MAX_LOG_PAGE_SIZE).contains(&value) => Ok(value),
        Some(_) => Err(ApiError {
            status: StatusCode::BAD_REQUEST,
            message: format!("query parameter `limit` must be between 1 and {MAX_LOG_PAGE_SIZE}"),
        }),
        None => Ok(DEFAULT_LOG_PAGE_SIZE),
    }
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
    fn parses_log_cursor_values() {
        assert_eq!(parse_log_cursor(None).expect("absent cursor is fine"), None);
        assert_eq!(
            parse_log_cursor(Some("1785175506123")).expect("numeric cursor should parse"),
            Some(1_785_175_506_123)
        );

        let non_numeric =
            parse_log_cursor(Some("abc")).expect_err("non-numeric cursor should fail");
        assert_eq!(non_numeric.status, StatusCode::BAD_REQUEST);

        let negative = parse_log_cursor(Some("-1")).expect_err("negative cursor should fail");
        assert_eq!(negative.status, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn parses_log_limit_values() {
        assert_eq!(
            parse_log_limit(None).expect("absent limit uses default"),
            DEFAULT_LOG_PAGE_SIZE
        );
        assert_eq!(
            parse_log_limit(Some(25)).expect("in-range limit should parse"),
            25
        );

        let zero = parse_log_limit(Some(0)).expect_err("zero limit should fail");
        assert_eq!(zero.status, StatusCode::BAD_REQUEST);

        let oversized =
            parse_log_limit(Some(MAX_LOG_PAGE_SIZE + 1)).expect_err("oversized limit should fail");
        assert_eq!(oversized.status, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn parses_docker_label_filter_values() {
        assert_eq!(
            parse_docker_label_filter(" com.dockermap.fixture ")
                .expect("key-only filter should parse"),
            Some("com.dockermap.fixture".into())
        );
        assert_eq!(
            parse_docker_label_filter("com.dockermap.fixture=run-123")
                .expect("key-value filter should parse"),
            Some("com.dockermap.fixture=run-123".into())
        );
        assert_eq!(
            parse_docker_label_filter("   ").expect("empty filter should be disabled"),
            None
        );
    }

    #[test]
    fn parses_depends_on_label_with_condition_suffixes() {
        assert_eq!(
            parse_depends_on_label("redis:service_started:false,database:service_started:false"),
            vec![
                "container_redis".to_string(),
                "container_database".to_string()
            ]
        );
        assert_eq!(
            parse_depends_on_label(" api ,  db:condition_started:true "),
            vec!["container_api".to_string(), "container_db".to_string()]
        );
        assert_eq!(
            parse_depends_on_label(""),
            Vec::<String>::new(),
            "empty labels produce no refs"
        );
        assert_eq!(
            parse_depends_on_label(",,"),
            Vec::<String>::new(),
            "bare separators produce no refs"
        );
    }

    #[test]
    fn rejects_invalid_docker_label_filter_values() {
        let oversized = "a".repeat(MAX_DOCKER_LABEL_FILTER_CHARS + 1);
        assert!(parse_docker_label_filter(&oversized).is_err());
        assert!(parse_docker_label_filter("com.dockermap.fixture\0bad").is_err());
        assert!(parse_docker_label_filter("=missing-key").is_err());
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

    #[test]
    fn parses_systemd_list_units_and_filters_non_services() {
        let units = parse_systemd_list_units(
            "ssh.service loaded active running OpenSSH server daemon\n\
             var-lib.mount loaded active mounted /var/lib\n\
             docker.service loaded inactive dead Docker Application Container Engine",
        );

        assert_eq!(units.len(), 2);
        assert_eq!(units[0].unit, "ssh.service");
        assert_eq!(units[0].description, "OpenSSH server daemon");
        assert_eq!(units[1].unit, "docker.service");
    }

    #[test]
    fn parses_systemd_show_dependency_records() {
        let records = parse_systemd_show_records(
            "Id=app.service\n\
             ActiveState=active\n\
             SubState=running\n\
             Description=App Service\n\
             ExecStart={ path=/usr/bin/python ; argv[]=python app.py ; }\n\
             Restart=always\n\
             ActiveEnterTimestamp=Wed 2026-08-19 04:05:06 UTC\n\
             ActiveEnterTimestampMonotonic=1200000000\n\
             Requires=network-online.target redis.service\n\
             Wants=postgres.service\n\
             PartOf=worker.service\n\
             \n\
             Id=redis.service\n\
             ActiveState=active\n",
        );

        assert_eq!(records.len(), 2);
        assert_eq!(records[0].id, "app.service");
        assert_eq!(
            systemd_dependency_pairs(&records[0]),
            vec![
                ("requires".to_string(), "redis.service".to_string()),
                ("wants".to_string(), "postgres.service".to_string()),
                ("part_of".to_string(), "worker.service".to_string())
            ]
        );
        assert_eq!(
            classify_systemd_service_entity(records.first()),
            ServiceEntityKind::PythonApplication
        );
        assert_eq!(records[0].restart.as_deref(), Some("always"));
        assert_eq!(
            records[0].active_enter_timestamp.as_deref(),
            Some("Wed 2026-08-19 04:05:06 UTC")
        );
        assert_eq!(records[0].active_enter_monotonic_us, Some(1_200_000_000));
    }

    #[test]
    fn computes_systemd_uptime_only_for_active_units() {
        let active = SystemdUnitDetails {
            id: "app.service".into(),
            active_state: Some("active".into()),
            active_enter_monotonic_us: Some(10_000_000),
            ..SystemdUnitDetails::default()
        };
        let inactive = SystemdUnitDetails {
            id: "idle.service".into(),
            active_state: Some("inactive".into()),
            active_enter_monotonic_us: Some(10_000_000),
            ..SystemdUnitDetails::default()
        };

        assert_eq!(
            systemd_uptime_seconds(&active, Some(1_010.0)),
            Some(1_000),
            "uptime is system uptime minus monotonic active-enter clock"
        );
        assert_eq!(systemd_uptime_seconds(&active, None), None);
        assert_eq!(systemd_uptime_seconds(&inactive, Some(1_010.0)), None);
    }

    #[test]
    fn redacts_systemd_secret_like_fixture_output() {
        let details = parse_systemd_show_records(include_str!(
            "../../../tests/fixtures/providers/redaction/systemd-show.txt"
        ));
        let summary = SystemdUnitSummary {
            unit: "redaction-worker.service".into(),
            active_state: "active".into(),
            sub_state: "running".into(),
            description: "Worker started with token=DOCKERMAP_TEST_FAKE_SYSTEMD_SUMMARY_TOKEN"
                .into(),
        };

        let mut node = systemd_runtime_node(
            "redaction-worker.service",
            Some(&summary),
            details.first(),
            None,
        );
        redact_runtime_node(&mut node);

        assert_eq!(
            node.metadata.get("serviceEntityKind").map(String::as_str),
            Some("python_application")
        );
        assert_eq!(
            node.metadata.get("description").map(String::as_str),
            Some(REDACTED_VALUE)
        );
        assert_no_raw_secrets(
            &node,
            &[
                "DOCKERMAP_TEST_FAKE_SYSTEMD_DESCRIPTION_TOKEN",
                "DOCKERMAP_TEST_FAKE_SYSTEMD_EXEC_TOKEN",
                "DOCKERMAP_TEST_FAKE_SYSTEMD_URL_TOKEN",
                "DOCKERMAP_TEST_FAKE_SYSTEMD_SUMMARY_TOKEN",
            ],
        );
    }

    #[test]
    fn redacts_tailnet_secret_like_ids_and_metadata() {
        let value = serde_json::json!({
            "DNSName": "worker.token=DOCKERMAP_TEST_FAKE_TAILNET_ID_TOKEN.example.",
            "User": "operator SECRET_KEY=DOCKERMAP_TEST_FAKE_TAILNET_USER_SECRET",
            "TailscaleIPs": ["100.64.0.2"],
            "Online": true
        });
        let mut nodes = Vec::new();
        push_tailnet_node(&mut nodes, RuntimeProviderKind::Tailscale, "peer_0", &value);
        redact_runtime_nodes(&mut nodes);

        assert_eq!(nodes[0].id, "tailscale_node_peer_0");
        assert_eq!(nodes[0].label, REDACTED_VALUE);
        assert_eq!(
            nodes[0].metadata.get("user").map(String::as_str),
            Some(REDACTED_VALUE)
        );
        assert_no_raw_secrets(
            &nodes,
            &[
                "DOCKERMAP_TEST_FAKE_TAILNET_ID_TOKEN",
                "DOCKERMAP_TEST_FAKE_TAILNET_USER_SECRET",
            ],
        );
    }

    #[test]
    fn redacts_tmux_secret_like_fixture_output() {
        let mut nodes = tmux_session_nodes_from_output(include_str!(
            "../../../tests/fixtures/providers/redaction/tmux-list-sessions.txt"
        ));
        redact_runtime_nodes(&mut nodes);

        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[0].label, REDACTED_VALUE);
        assert_eq!(nodes[1].label, "safe-worker");
        assert_no_raw_secrets(&nodes, &["DOCKERMAP_TEST_FAKE_TMUX_SESSION_SECRET"]);
    }

    #[test]
    fn redacts_npm_package_fixture_output() {
        let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/providers/redaction");
        let npmrc =
            fs::read_to_string(project_root.join("npm-app/.npmrc")).expect("fixture .npmrc");
        assert!(npmrc.contains("DOCKERMAP_TEST_FAKE_NPMRC_TOKEN"));

        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        let mut diagnostics = Vec::new();
        collect_npm_projects(&project_root, &mut nodes, &mut edges, &mut diagnostics);
        redact_runtime_nodes(&mut nodes);
        redact_runtime_edges(&mut edges);
        redact_runtime_diagnostics(&mut diagnostics);

        assert!(nodes.iter().any(|node| {
            node.metadata.get("version").map(String::as_str) == Some(REDACTED_VALUE)
        }));
        assert_no_raw_secrets(
            &(&nodes, &edges, &diagnostics),
            &[
                "DOCKERMAP_TEST_FAKE_NPM_SCRIPT_TOKEN",
                "DOCKERMAP_TEST_FAKE_NPM_URL_TOKEN",
                "DOCKERMAP_TEST_FAKE_NPM_QUERY_TOKEN",
                "DOCKERMAP_TEST_FAKE_NPMRC_TOKEN",
                "DOCKERMAP_TEST_FAKE_PATH_TOKEN",
            ],
        );
    }

    #[test]
    fn redacts_native_process_secret_like_fixture_output() {
        let command =
            include_str!("../../../tests/fixtures/providers/redaction/process-cmdline.txt").trim();
        let mut node = RuntimeMapNode {
            id: "process_2412".into(),
            provider: RuntimeProviderKind::Process,
            kind: RuntimeNodeKind::Process,
            label: command.into(),
            status: Some("running".into()),
            layer: None,
            metadata: BTreeMap::from([
                ("pid".into(), "2412".into()),
                ("command".into(), command.into()),
            ]),
            service: None,
            package: None,
        };
        let mut edges = vec![RuntimeMapEdge {
            source: "process_2412".into(),
            target: "host_local".into(),
            relationship: RuntimeRelationshipKind::RunsOn,
            metadata: BTreeMap::from([("argv".into(), command.into())]),
        }];
        let mut diagnostics = vec![RuntimeMapDiagnostic {
            provider: RuntimeProviderKind::Process,
            severity: DiagnosticSeverity::Info,
            message: format!("process fixture skipped: {command}"),
        }];

        redact_runtime_node(&mut node);
        redact_runtime_edges(&mut edges);
        redact_runtime_diagnostics(&mut diagnostics);

        assert_eq!(node.label, REDACTED_VALUE);
        assert_eq!(
            node.metadata.get("command").map(String::as_str),
            Some(REDACTED_VALUE)
        );
        assert_no_raw_secrets(
            &(&node, &edges, &diagnostics),
            &[
                "DOCKERMAP_TEST_FAKE_PROCESS_PASSWORD",
                "DOCKERMAP_TEST_FAKE_PROCESS_URL_TOKEN",
            ],
        );
    }

    #[test]
    fn reverse_proxy_and_dns_markers_do_not_expose_config_fixture_contents() {
        let proxy_config =
            include_str!("../../../tests/fixtures/providers/redaction/reverse-proxy-caddyfile");
        let dns_config =
            include_str!("../../../tests/fixtures/providers/redaction/dns-adguard.yaml");
        assert!(proxy_config.contains("DOCKERMAP_TEST_FAKE_PROXY_AUTH"));
        assert!(dns_config.contains("DOCKERMAP_TEST_FAKE_DNS_URL_TOKEN"));
        assert!(dns_config.contains("DOCKERMAP_TEST_FAKE_DNS_PASSWORD"));

        let proxy_marker = NetworkMarker {
            product: "Caddy",
            path: "/etc/caddy/Caddyfile",
        };
        let dns_marker = NetworkMarker {
            product: "AdGuard Home",
            path: "/opt/adguardhome/conf/AdGuardHome.yaml",
        };
        let mut nodes = vec![
            network_marker_node(
                &proxy_marker,
                RuntimeProviderKind::ReverseProxy,
                RuntimeNodeKind::ReverseProxy,
                ServiceEntityKind::ReverseProxy,
                "reverse_proxy_config",
            ),
            network_marker_node(
                &dns_marker,
                RuntimeProviderKind::LocalDns,
                RuntimeNodeKind::LocalDnsResolver,
                ServiceEntityKind::DnsProvider,
                "local_dns_config",
            ),
        ];
        redact_runtime_nodes(&mut nodes);

        assert_no_raw_secrets(
            &nodes,
            &[
                "DOCKERMAP_TEST_FAKE_PROXY_AUTH",
                "DOCKERMAP_TEST_FAKE_DNS_URL_TOKEN",
                "DOCKERMAP_TEST_FAKE_DNS_PASSWORD",
            ],
        );
    }

    #[test]
    fn redacts_sensitive_provider_diagnostics_and_edge_metadata() {
        let mut edges = vec![RuntimeMapEdge {
            source: "a".into(),
            target: "b".into(),
            relationship: RuntimeRelationshipKind::RelatedTo,
            metadata: BTreeMap::from([(
                "header".into(),
                "Authorization: Bearer DOCKERMAP_TEST_FAKE_EDGE_TOKEN".into(),
            )]),
        }];
        let mut diagnostics = vec![RuntimeMapDiagnostic {
            provider: RuntimeProviderKind::Other,
            severity: DiagnosticSeverity::Warning,
            message: "skipped path with password=DOCKERMAP_TEST_FAKE_DIAGNOSTIC_PASSWORD".into(),
        }];

        redact_runtime_edges(&mut edges);
        redact_runtime_diagnostics(&mut diagnostics);

        assert_no_raw_secrets(
            &(&edges, &diagnostics),
            &[
                "DOCKERMAP_TEST_FAKE_EDGE_TOKEN",
                "DOCKERMAP_TEST_FAKE_DIAGNOSTIC_PASSWORD",
            ],
        );
    }

    #[test]
    fn classifies_ai_package_manifests() {
        let manifest = PackageManifestDocument {
            name: Some("agent-control".into()),
            private: true,
            package_manager: Some("npm@10".into()),
            scripts: BTreeMap::from([("start".into(), "node agent.js".into())]),
            dependencies: BTreeMap::from([
                ("openai".into(), "^4.0.0".into()),
                ("langchain".into(), "^0.3.0".into()),
            ]),
            optional_dependencies: BTreeMap::new(),
            peer_dependencies: BTreeMap::new(),
            dev_dependencies: BTreeMap::new(),
        };

        assert_eq!(
            classify_package_manifest(&manifest),
            (RuntimeNodeKind::AiAgent, ServiceEntityKind::AiAgent)
        );

        let dependencies = package_manifest_dependencies(&manifest);
        assert_eq!(dependencies.len(), 2);
        assert_eq!(dependencies[0].scope, "dependencies");
    }

    #[test]
    fn skips_conservative_discovery_directories() {
        assert!(should_skip_discovery_dir("node_modules"));
        assert!(should_skip_discovery_dir(".next"));
        assert!(!should_skip_discovery_dir("services"));
        assert!(is_node_lockfile("package-lock.json"));
        assert!(!is_node_lockfile("Cargo.lock"));
    }

    #[test]
    fn classifies_package_framework_hints_and_bounds_scripts() {
        let manifest = PackageManifestDocument {
            name: Some("web-dashboard".into()),
            private: true,
            package_manager: Some("pnpm@9".into()),
            scripts: (0..32)
                .map(|index| (format!("script-{index}"), format!("echo step {index}")))
                .collect(),
            dependencies: BTreeMap::from([
                ("next".into(), "^15.0.0".into()),
                ("react".into(), "^19.0.0".into()),
                ("express".into(), "^4.19.0".into()),
                ("fastify".into(), "^5.0.0".into()),
            ]),
            optional_dependencies: BTreeMap::new(),
            peer_dependencies: BTreeMap::new(),
            dev_dependencies: BTreeMap::from([("vite".into(), "^6.0.0".into())]),
        };

        let hints = classify_package_frameworks(&manifest);
        assert!(
            hints.contains(&"Next.js".to_string()),
            "next should surface"
        );
        assert!(hints.contains(&"React".to_string()), "react should surface");
        assert!(
            hints.len() <= 4,
            "framework hints must stay bounded, got {hints:?}"
        );

        let bounded = bounded_package_scripts(&manifest.scripts);
        assert_eq!(bounded.len(), MAX_NPM_SCRIPTS);
        assert_eq!(bounded.get("script-0"), Some(&"echo step 0".to_string()));
    }

    #[test]
    fn pages_log_entries_to_strictly_older_pages() {
        let entries = (0..5)
            .map(|index| LogEntry {
                id: format!("svc-{index}"),
                timestamp: 1_000 - index,
                container: "svc".into(),
                level: dockermap_core::LogLevel::Info,
                message: format!("line {index}"),
            })
            .collect::<Vec<_>>();

        let (first, first_cursor) = page_log_entries(entries.clone(), None, None, 2);
        assert_eq!(first.len(), 2);
        assert_eq!(first[0].timestamp, 1_000, "page is sorted newest-first");
        assert_eq!(first[1].timestamp, 999);
        let first_cursor = first_cursor.expect("a full page carries a cursor");
        assert_eq!(first_cursor, "999", "cursor is the oldest kept entry");

        let (second, second_cursor) = page_log_entries(entries.clone(), None, Some(999), 2);
        assert_eq!(second.len(), 2);
        assert!(
            second.iter().all(|entry| entry.timestamp < 999),
            "next page must be strictly older than the cursor"
        );
        assert!(
            second
                .iter()
                .all(|entry| first.iter().all(|first_entry| first_entry.id != entry.id)),
            "pages must not overlap"
        );
        let second_cursor = second_cursor.expect("a full page carries a cursor");
        assert_eq!(second_cursor, "997");

        let (last, last_cursor) = page_log_entries(entries.clone(), None, Some(997), 2);
        assert_eq!(last.len(), 1, "last page holds the remaining entry");
        assert_eq!(last[0].timestamp, 996);
        assert_eq!(last_cursor, None, "the last page has no cursor");
    }

    #[test]
    fn log_entry_ids_are_unique_for_same_timestamp_lines() {
        let first = log_entry_id("api", 1_787_198_706_123, 0);
        let second = log_entry_id("api", 1_787_198_706_123, 1);
        assert_ne!(first, second, "same-ms lines must not collide");
        assert!(first.ends_with("-0"));
        assert!(second.ends_with("-1"));
    }

    #[test]
    fn pages_log_entries_with_query_filter_and_sparse_last_page() {
        let entries = vec![
            LogEntry {
                id: log_entry_id("svc", 100, 0),
                timestamp: 100,
                container: "svc".into(),
                level: dockermap_core::LogLevel::Info,
                message: "boot ok".into(),
            },
            LogEntry {
                id: log_entry_id("svc", 100, 1),
                timestamp: 100,
                container: "svc".into(),
                level: dockermap_core::LogLevel::Info,
                message: "token=DOCKERMAP_TEST_FAKE_LOG_LINE".into(),
            },
            LogEntry {
                id: log_entry_id("svc", 99, 2),
                timestamp: 99,
                container: "svc".into(),
                level: dockermap_core::LogLevel::Warn,
                message: "retry".into(),
            },
        ];

        let (kept, cursor) = page_log_entries(entries.clone(), Some("boot"), None, 10);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].message, "boot ok");
        assert_eq!(cursor, None, "an unfilled page has no cursor");

        let (kept, cursor) = page_log_entries(entries.clone(), None, Some(100), 2);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].timestamp, 99);
        assert_eq!(cursor, None, "an unfilled page has no cursor");
    }

    #[test]
    fn pages_log_entries_exact_multiple_of_limit_has_no_trailing_cursor() {
        let entries = (0..4)
            .map(|index| LogEntry {
                id: format!("svc-{index}"),
                timestamp: 1_000 - index,
                container: "svc".into(),
                level: dockermap_core::LogLevel::Info,
                message: format!("line {index}"),
            })
            .collect::<Vec<_>>();

        let (first, first_cursor) = page_log_entries(entries.clone(), None, None, 2);
        assert_eq!(first.len(), 2);
        let first_cursor = first_cursor.expect("a full page with more behind it carries a cursor");

        let (second, second_cursor) = page_log_entries(entries.clone(), None, Some(999), 2);
        assert_eq!(second.len(), 2, "exact-multiple last page is exactly full");
        assert!(
            second_cursor.is_none(),
            "an exactly-full final page must NOT carry a cursor that would yield an empty next page"
        );
        assert_eq!(
            second.last().map(|entry| entry.timestamp),
            Some(997),
            "the final entry is still delivered on the last page"
        );
        assert_ne!(
            first_cursor, "997",
            "first cursor keeps pointing at its own oldest entry"
        );
    }

    #[test]
    fn log_over_fetch_contract_emits_cursor_for_live_docker() {
        // The live-Docker path over-fetches `limit + 1` lines so a next page
        // can be detected (`entries.len() > limit`) — a plain `tail(limit)`
        // window could never produce a cursor.
        assert_eq!(log_tail_count(100, false), 101);
        assert_eq!(
            log_tail_count(0, false),
            2,
            "limit is clamped to the valid range"
        );
        assert_eq!(
            log_tail_count(MAX_LOG_PAGE_SIZE, false),
            MAX_LOG_PAGE_SIZE + 1
        );

        // Feeding the over-fetched window into page_log_entries must yield a
        // page of exactly `limit` entries plus a cursor.
        let entries = (0..=100)
            .map(|index| LogEntry {
                id: format!("svc-{index}"),
                timestamp: 10_000 - index,
                container: "svc".into(),
                level: dockermap_core::LogLevel::Info,
                message: format!("line {index}"),
            })
            .collect::<Vec<_>>();

        let (page, cursor) = page_log_entries(entries, None, None, 100);
        assert_eq!(page.len(), 100, "over-fetch is truncated to the page size");
        let cursor = cursor.expect("a full page with more behind it carries a cursor");
        assert_eq!(cursor, "9901", "cursor is the oldest kept entry");
    }

    #[test]
    fn log_tail_window_differs_for_first_and_cursor_pages() {
        // First page over-fetches by one; cursor pages open a large fixed
        // window because Docker's `--tail` never moves older under `--until`.
        assert_eq!(log_tail_count(100, false), 101);
        assert_eq!(log_tail_count(0, false), 2);
        assert_eq!(
            log_tail_count(MAX_LOG_PAGE_SIZE, false),
            MAX_LOG_PAGE_SIZE + 1
        );

        assert_eq!(log_tail_count(100, true), MAX_LOG_CURSOR_TAIL);
        assert_eq!(log_tail_count(MAX_LOG_PAGE_SIZE, true), MAX_LOG_CURSOR_TAIL);
        assert_eq!(log_tail_count(0, true), MAX_LOG_CURSOR_TAIL);
    }

    #[test]
    fn skips_blank_timestamped_log_lines_and_keeps_real_timestamps() {
        // Docker emits a blank line as "<timestamp> " (timestamp, space, empty
        // body). It must be skipped, not fabricated into a now-stamped entry
        // whose message is the raw timestamp string.
        assert_eq!(
            parse_timestamped_log_line(b"2026-08-20T03:03:02.538671807Z "),
            None,
            "blank lines must be skipped"
        );

        // A normal line keeps its real timestamp rather than falling back to
        // now().
        let (timestamp, message) =
            parse_timestamped_log_line(b"2026-08-20T03:03:02.538671807Z hello")
                .expect("a normal line should parse");
        assert_eq!(message, "hello");
        assert_eq!(
            timestamp, 1_787_194_982_538,
            "the real timestamp must be preserved, not replaced with now()"
        );
    }

    #[test]
    fn log_until_rounds_cursor_up_to_second_boundary() {
        // Docker's `until` is second-resolution and exclusive: floor
        // truncation would drop every entry in the boundary second older than
        // the cursor. Rounding up returns the whole boundary second and lets
        // the precise ms filter arbitrate.
        assert_eq!(log_until_seconds(1_785_175_506_123), 1_785_175_507);
        assert_eq!(
            log_until_seconds(1_785_175_506_000),
            1_785_175_506,
            "an exact second boundary rounds to itself"
        );
        assert_eq!(log_until_seconds(1_000), 1);
        assert_eq!(log_until_seconds(999), 1);
        assert_eq!(log_until_seconds(0), 0);
    }

    #[test]
    fn log_until_boundary_keeps_same_second_entries_before_cursor() {
        // Entries in the boundary second before the cursor survive the ms
        // filter, so a cursor at S.123 keeps [S.000, S.123) and drops the
        // rest — mirroring the div_ceil `until` contract.
        let entries = (0..6)
            .map(|index| LogEntry {
                id: format!("svc-{index}"),
                timestamp: 1_000_123 - index,
                container: "svc".into(),
                level: dockermap_core::LogLevel::Info,
                message: format!("line {index}"),
            })
            .collect::<Vec<_>>();

        let (page, _) = page_log_entries(entries, None, Some(1_000_123), 10);
        assert_eq!(
            page.len(),
            5,
            "all entries strictly older than the cursor are kept"
        );
        assert!(page.iter().all(|entry| entry.timestamp < 1_000_123));
        assert_eq!(page.last().map(|entry| entry.timestamp), Some(1_000_118));
    }

    #[test]
    fn provider_commands_time_out_and_report_diagnostics() {
        let started = std::time::Instant::now();
        let error = run_command_with_timeout(
            {
                let mut command = Command::new("sleep");
                command.arg("30");
                command
            },
            Duration::from_millis(200),
        )
        .expect_err("a hung provider command must time out");
        assert!(error.contains("timed out"), "{error}");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the timeout must bound the wait, took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn provider_commands_succeed_within_timeout() {
        let output = run_command_with_timeout(
            {
                let mut command = Command::new("sh");
                command.arg("-c").arg("echo ok");
                command
            },
            Duration::from_secs(5),
        )
        .expect("a fast provider command should succeed");
        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "ok");
    }

    #[test]
    fn docker_container_nodes_carry_layer_and_service_entity() {
        let snapshot = mock_snapshot();
        let map = derive_runtime_map(&snapshot, Vec::new(), Vec::new(), Vec::new());

        let container = map
            .nodes
            .iter()
            .find(|node| node.kind == RuntimeNodeKind::Container)
            .expect("derive_runtime_map should emit container nodes");
        assert_eq!(container.layer, Some(RuntimeNodeLayer::Container));
        let service = container
            .service
            .as_ref()
            .expect("container nodes carry a service entity");
        assert!(!service.name.is_empty());
        assert_eq!(
            service.status,
            RuntimeServiceStatus::from_status_text(container.status.as_deref().unwrap_or_default())
        );

        assert!(map.nodes.iter().any(|node| {
            node.kind == RuntimeNodeKind::DockerNetwork
                && node.layer == Some(RuntimeNodeLayer::Network)
        }));
        assert!(map.nodes.iter().any(|node| {
            node.kind == RuntimeNodeKind::DockerVolume
                && node.layer == Some(RuntimeNodeLayer::Storage)
        }));
    }

    #[test]
    fn npm_dependency_nodes_carry_package_entity_and_layer() {
        let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/providers/redaction");
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        let mut diagnostics = Vec::new();
        collect_npm_projects(&project_root, &mut nodes, &mut edges, &mut diagnostics);

        let dependency = nodes
            .iter()
            .find(|node| node.kind == RuntimeNodeKind::PackageDependency)
            .expect("npm fixture should yield dependency nodes");
        assert_eq!(dependency.layer, Some(RuntimeNodeLayer::Package));
        let package = dependency
            .package
            .as_ref()
            .expect("dependency nodes carry a package entity");
        assert_eq!(package.manager, dockermap_core::RuntimePackageManager::Npm);
        assert!(!package.name.is_empty());
        assert!(!package.version.is_empty());
        assert_eq!(
            dependency.metadata.get("version").map(String::as_str),
            Some(package.version.as_str()),
            "package entity version matches the node metadata"
        );
    }

    #[test]
    fn redacts_compose_environment_fixture_output() {
        let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/providers/redaction");
        let file = project_root.join("compose-environment.yaml");
        let content = fs::read_to_string(&file).expect("compose redaction fixture");
        assert!(content.contains("DOCKERMAP_TEST_FAKE_COMPOSE_TOKEN"));
        assert!(content.contains("DOCKERMAP_TEST_FAKE_COMPOSE_PASSWORD"));

        let mut scan =
            scan_compose_files(&project_root, std::slice::from_ref(&file)).expect("fixture scans");
        redact_compose_scan(&mut scan);

        let serialized = serde_json::to_string(&scan).expect("scan should serialize");
        assert!(
            !serialized.contains("DOCKERMAP_TEST_FAKE_COMPOSE_TOKEN"),
            "scan JSON leaked the token sentinel: {serialized}"
        );
        assert!(
            !serialized.contains("DOCKERMAP_TEST_FAKE_COMPOSE_PASSWORD"),
            "scan JSON leaked the password sentinel: {serialized}"
        );
        assert!(
            serialized.contains("POSTGRES_PASSWORD"),
            "environment keys stay visible so the shape remains useful"
        );
        assert_no_raw_secrets(
            &scan,
            &[
                "DOCKERMAP_TEST_FAKE_COMPOSE_TOKEN",
                "DOCKERMAP_TEST_FAKE_COMPOSE_PASSWORD",
            ],
        );
    }

    #[test]
    fn redacts_compose_graph_fixture_output() {
        let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/providers/redaction");
        let file = project_root.join("compose-environment.yaml");
        let content = fs::read_to_string(&file).expect("compose redaction fixture");
        assert!(content.contains("DOCKERMAP_TEST_FAKE_COMPOSE_TOKEN"));
        assert!(content.contains("DOCKERMAP_TEST_FAKE_COMPOSE_PASSWORD"));

        let mut scan =
            scan_compose_files(&project_root, std::slice::from_ref(&file)).expect("fixture scans");
        redact_compose_scan(&mut scan);
        let graph = derive_compose_graph(&scan);

        let serialized = serde_json::to_string(&graph).expect("graph should serialize");
        assert!(
            !serialized.contains("DOCKERMAP_TEST_FAKE_COMPOSE_TOKEN"),
            "graph JSON leaked the token sentinel: {serialized}"
        );
        assert!(
            !serialized.contains("DOCKERMAP_TEST_FAKE_COMPOSE_PASSWORD"),
            "graph JSON leaked the password sentinel: {serialized}"
        );
        assert!(
            serialized.contains("compose_host_path_"),
            "bind-source host-path nodes still appear with redacted ids/labels: {serialized}"
        );
    }

    #[test]
    fn redacts_sensitive_lines_in_unified_diffs() {
        let diff = "@@ -1,5 +1,5 @@\nservices:\n  app:\n    image: alpine\n-    - POSTGRES_PASSWORD=DOCKERMAP_TEST_FAKE_COMPOSE_PASSWORD\n+    - API_TOKEN=DOCKERMAP_TEST_FAKE_COMPOSE_TOKEN\n";
        // The literal above uses explicit `\n` escapes (no source line
        // continuations), so context-line leading spaces survive.
        let lines = diff.split('\n').count();
        assert_eq!(lines, 7, "diff should keep its line structure: {lines}");
        let redacted = redact_unified_diff(diff);
        assert!(!redacted.contains("DOCKERMAP_TEST_FAKE_COMPOSE_PASSWORD"));
        assert!(!redacted.contains("DOCKERMAP_TEST_FAKE_COMPOSE_TOKEN"));
        assert!(
            redacted.contains("-[redacted]"),
            "sensitive removal line keeps its marker: {redacted}"
        );
        assert!(
            redacted.contains("+[redacted]"),
            "sensitive addition line keeps its marker: {redacted}"
        );
        assert!(
            redacted.contains("  image: alpine"),
            "safe context lines stay intact: {redacted}"
        );
    }

    fn assert_no_raw_secrets<T: serde::Serialize>(value: &T, secrets: &[&str]) {
        let serialized = serde_json::to_string(value).expect("value should serialize");
        for secret in secrets {
            assert!(
                !serialized.contains(secret),
                "serialized provider output leaked `{secret}`: {serialized}"
            );
        }
    }
}
