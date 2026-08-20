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
    derive_runtime_map, discover_compose_files, mock_logs, mock_snapshot, page_log_entries,
    parse_rfc3339_nano_millis, plan_compose_mount_edit, scan_compose_files,
    service_entity_kind_name, unix_timestamp_millis, ComposeDiagnostic, ComposeEditPlan,
    ComposeGraph, ComposeMountKind, ComposeScan, ContainerMount, ContainerRecord,
    DiagnosticSeverity, DockerSnapshot, GraphResponse, HealthResponse, HealthState, LogCursor,
    LogEntry, LogsResponse, NetworkRecord, RuntimeLocation, RuntimeMap, RuntimeMapDiagnostic,
    RuntimeMapEdge, RuntimeMapNode, RuntimeMode, RuntimeNodeKind, RuntimeNodeLayer,
    RuntimeOwnership, RuntimePackageEntity, RuntimeProviderKind, RuntimeRelationshipKind,
    RuntimeServiceEntity, RuntimeServiceStatus, ServiceEntityKind, VolumeRecord,
    DEFAULT_LOG_PAGE_SIZE, MAX_LOG_PAGE_SIZE,
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
const MAX_PYTHON_PROCESSES: usize = 64;
const MAX_NATIVE_PROCESSES: usize = 256;
const MAX_PROVIDER_OUTPUT_BYTES: usize = 1 << 20;
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
    // systemd sends SIGTERM (KillSignal) and Docker's stop signal defaults to
    // SIGTERM; ctrl_c alone left `systemctl stop` hanging until SIGKILL.
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("SIGTERM handler should install");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term.recv() => {}
    }
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
        cursor: Option<LogCursor>,
        limit: usize,
    ) -> Result<LogsResponse, String> {
        let limit = limit.clamp(1, MAX_LOG_PAGE_SIZE);
        let mut options = LogsOptionsBuilder::new()
            .follow(false)
            .stdout(true)
            .stderr(true)
            .timestamps(true)
            .tail(&log_tail_count().to_string());

        if let Some(cursor) = cursor {
            options = options.until(log_until_seconds(cursor.millis));
        }

        let mut stream = self.client.logs(service, Some(options.build()));

        // Docker streams the `tail(limit)` window OLDEST-first, so we cannot
        // decide page boundaries while streaming: collect the whole window
        // (bounded server-side by `tail`, plus a defensive cap in case Docker
        // returns more than requested), then page it in a pure function.
        let mut entries = Vec::new();
        // Same-millisecond ordinal, assigned in stream order. Every request
        // opens the SAME fixed tail window (MAX_LOG_CURSOR_TAIL), so a
        // physical line's ordinal (how many same-ms lines PRECEDE it in the
        // stream) is stable across requests: new lines append chronologically
        // and never re-order existing same-ms lines, so the id is a property
        // of the physical line — unlike a per-request sequence counter,
        // which would change the id and defeat the client's dedupe-by-id.
        // The ordinal is what keeps two distinct physical lines that share a
        // service, an ms-truncated timestamp, and identical message text
        // from collapsing onto one id.
        let mut same_timestamp_seen = HashMap::<u64, usize>::new();

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

            let ordinal = same_timestamp_seen.entry(timestamp).or_insert(0);
            entries.push(LogEntry {
                id: log_entry_id(service, timestamp, *ordinal),
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
            *ordinal += 1;

            if entries.len() >= MAX_LOG_STREAM_CAP {
                break;
            }
        }

        let (entries, next_cursor) = page_log_entries(entries, query, cursor, limit);

        Ok(LogsResponse {
            service: Some(service.to_string()),
            entries,
            next_cursor,
        })
    }
}

/// Parse one timestamped Docker log line (collected with `--timestamps`) into
/// a `(timestamp_millis, message)` pair, or `None` when the line carries no
/// usable message.
///
/// Docker prefixes ONLY the first line of a multi-line message with a
/// timestamp; continuation lines are bare text. A prefix is therefore only
/// stripped when it actually parses as an RFC 3339 timestamp — continuation
/// lines and blank lines are SKIPPED (`None`) rather than fabricated into a
/// now()-timestamped entry, and their first token is never eaten. A blank
/// line arrives from Docker as `"<timestamp> "` (timestamp, space, empty
/// body); the empty body also yields `None`.
fn parse_timestamped_log_line(line: &[u8]) -> Option<(u64, String)> {
    let text = String::from_utf8_lossy(line);
    let (prefix, rest) = text.split_once(' ')?;
    let timestamp = parse_rfc3339_nano_millis(prefix)?;
    let message = truncate_chars(rest.trim(), MAX_LOG_MESSAGE_CHARS);
    if message.is_empty() {
        return None;
    }
    Some((timestamp, message))
}

/// Number of lines requested from Docker's `tail` for one log page.
///
/// EVERY page — first and cursor — opens the same fixed window
/// (`MAX_LOG_CURSOR_TAIL`). Docker's `--tail N` selects the last N lines of
/// the FULL log and `--until` only FILTERS that fixed window — it never moves
/// the window older — so a cursor page needs a large window for
/// `until(cursor)` and `page_log_entries`' precise `< cursor` filter to reach
/// older lines. The FIRST page must open the very same window: the
/// same-millisecond ordinal counts the same-ms lines PRECEDING a line in the
/// collected window, so a narrower first-page window (the old `limit + 1`)
/// assigned different ordinals to the same physical lines than a cursor
/// page's window did — the two id sets collided, and the client's
/// dedupe-by-id silently discarded whole cursor pages. With one fixed window,
/// a same-ms run of up to `MAX_LOG_CURSOR_TAIL` lines gets identical ids on
/// every fetch.
///
/// `page_log_entries` truncates the collected window to `limit` and emits a
/// cursor whenever the window holds more than `limit` entries; the fixed
/// window is wider than any page, so a next page is still detected for live
/// Docker logs and "Load older" stays visible. Trade-off: history older than
/// `MAX_LOG_CURSOR_TAIL` is unreachable.
fn log_tail_count() -> usize {
    MAX_LOG_CURSOR_TAIL
}

/// Docker's `until` filter is second-resolution and EXCLUSIVE: a line at
/// exactly `until` seconds is omitted. The cursor is compound (`millis:offset`,
/// see `LogCursor`), so the boundary millisecond's not-yet-emitted entries
/// must still be returned: `until` must cover the second that CONTAINS the
/// boundary millisecond, i.e. `floor(millis / 1000) + 1`. That also returns
/// the rest of the boundary second (entries newer than the boundary that were
/// already emitted) — `page_log_entries`' precise cursor filter is the sole
/// arbiter of what belongs to the next page.
fn log_until_seconds(cursor_millis: u64) -> i32 {
    (cursor_millis / 1_000 + 1).min(i32::MAX as u64) as i32
}

/// Fixed `tail` window opened for EVERY log page (first page and cursor
/// pages alike). See `log_tail_count` for why the window must be identical
/// across requests: a window-relative same-ms ordinal would make log entry
/// ids unstable, colliding id sets between pages and defeating the client's
/// dedupe-by-id.
const MAX_LOG_CURSOR_TAIL: usize = 4_096;

/// Defensive cap on the raw log stream collected from Docker. The stream is
/// already bounded by `tail(...)`, so this only guards against a daemon
/// returning more than requested — but it must be at least as large as the
/// tail window (`MAX_LOG_CURSOR_TAIL`), or a page's window would be truncated
/// before `page_log_entries` sees it.
const MAX_LOG_STREAM_CAP: usize = MAX_LOG_CURSOR_TAIL + 1;

/// Stable id for a live-Docker log entry, unique per PHYSICAL line.
///
/// The id is `service-timestamp-ordinal`, where `ordinal` is the line's
/// index among same-millisecond entries in stream order (how many same-ms
/// lines precede it). Docker streams a log's tail window in stable
/// chronological order and every request opens the same fixed window
/// (`MAX_LOG_CURSOR_TAIL`, see `log_tail_count`), so the ordinal — unlike a
/// per-request sequence counter — is deterministic across requests: the same
/// physical line always gets the same id, while two DISTINCT lines sharing a
/// service, an
/// ms-truncated timestamp, and identical message text still get distinct
/// ids. Content hashing alone (service + timestamp + message) collapsed
/// such lines onto one id, and the client's dedupe-by-id silently dropped
/// the second one — even though the compound cursor was built to preserve
/// same-ms entries at page boundaries.
fn log_entry_id(service: &str, timestamp: u64, ordinal: usize) -> String {
    format!("{service}-{timestamp}-{ordinal:04x}")
}

// Log page boundaries are decided by `dockermap_core::page_log_entries`
// (imported above) — the single source of truth shared with mock_logs so the
// live-Docker, daemon-mock, and Node-API-mock paths agree on cursor format.

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
    collect_python_processes(&mut nodes, &mut diagnostics);
    collect_native_processes(&mut nodes, &mut diagnostics);
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
/// Diagnostic instead of failing the whole runtime map.
///
/// NOTE: the pipes are drained by reader threads WHILE the child runs — a
/// provider whose output exceeds the pipe buffer (e.g. `ps -eo ...` on a busy
/// host) would otherwise deadlock the child until the timeout kills it.
fn run_command_with_timeout(mut command: Command, timeout: Duration) -> Result<Output, String> {
    // `Command::spawn` does NOT pipe stdio like `Command::output` does, so
    // the pipes must be requested explicitly to collect provider output.
    let mut child = command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to spawn provider command: {error}"))?;

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");
    let stdout_reader = std::thread::spawn(move || read_bounded(stdout, MAX_PROVIDER_OUTPUT_BYTES));
    let stderr_reader = std::thread::spawn(move || read_bounded(stderr, MAX_PROVIDER_OUTPUT_BYTES));

    let started = std::time::Instant::now();
    let status = loop {
        match child
            .try_wait()
            .map_err(|error| format!("provider command wait failed: {error}"))?
        {
            Some(status) => break Some(status),
            None if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            None => std::thread::sleep(Duration::from_millis(25)),
        }
    };

    let stdout = stdout_reader
        .join()
        .map_err(|_| "provider stdout reader panicked".to_string())?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "provider stderr reader panicked".to_string())?;

    match status {
        Some(status) => Ok(Output {
            status,
            stdout,
            stderr,
        }),
        None => Err(format!(
            "provider command timed out after {}s",
            timeout.as_secs()
        )),
    }
}

/// Read up to `cap` bytes from a pipe; used to drain provider output
/// concurrently with the child process so it can never block on a full pipe.
fn read_bounded(mut reader: impl std::io::Read, cap: usize) -> Vec<u8> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                let remaining = cap.saturating_sub(buffer.len());
                if read >= remaining {
                    buffer.extend_from_slice(&chunk[..remaining]);
                    break;
                }
                buffer.extend_from_slice(&chunk[..read]);
            }
            Err(_) => break,
        }
    }
    buffer
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
        // System crontabs (@reboot in /etc/crontab and cron.d) carry a user
        // column after the schedule; user crontabs do not. Skip the schedule
        // (and user) token(s) but preserve the command's original whitespace —
        // reconstructing with join(" ") would collapse repeated spaces inside
        // quoted arguments.
        let fields = trimmed.split_whitespace().collect::<Vec<_>>();
        let command_start = if user_crontab { 1 } else { 2 };
        if fields.len() <= command_start {
            return None;
        }
        // Walk the original line to find the command token's byte offset
        // (sequential find cannot match an earlier token again), then take
        // the remainder verbatim.
        let mut offset = 0usize;
        for token in &fields[..command_start] {
            offset = trimmed[offset..]
                .find(token)
                .map(|index| offset + index + token.len())?;
        }
        let command = trimmed[offset..].trim();
        if command.is_empty() {
            return None;
        }
        return Some(command.to_string());
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

    match pm2_app_nodes_from_jlist(&String::from_utf8_lossy(&output.stdout)) {
        Some(app_nodes) => nodes.extend(app_nodes),
        None => push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::Pm2,
            DiagnosticSeverity::Warning,
            "PM2 discovery returned invalid JSON".into(),
        ),
    }
}

fn pm2_app_nodes_from_jlist(value: &str) -> Option<Vec<RuntimeMapNode>> {
    let Ok(apps) = serde_json::from_str::<Vec<serde_json::Value>>(value) else {
        return None;
    };

    let mut nodes = Vec::with_capacity(apps.len());
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
    Some(nodes)
}

struct PythonProcessRecord {
    pid: u32,
    user: String,
    args: String,
}

fn parse_ps_table(value: &str) -> Vec<PythonProcessRecord> {
    let mut records = Vec::new();
    for line in value.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let fields = trimmed.split_whitespace().collect::<Vec<_>>();
        if fields.len() < 3 {
            continue;
        }
        let Ok(pid) = fields[0].parse::<u32>() else {
            continue;
        };
        // Walk to the args token's byte offset so the command keeps its
        // original spacing (sequential find cannot re-match earlier tokens).
        let mut offset = 0usize;
        for token in &fields[..2] {
            match trimmed[offset..].find(token) {
                Some(index) => offset += index + token.len(),
                None => {
                    offset = trimmed.len();
                    break;
                }
            }
        }
        if offset >= trimmed.len() {
            continue;
        }
        let args = trimmed[offset..].trim();
        if args.is_empty() {
            continue;
        }
        records.push(PythonProcessRecord {
            pid,
            user: fields[1].to_string(),
            args: args.to_string(),
        });
    }
    records
}

fn is_python_process(args: &str) -> bool {
    let fields = args.split_whitespace().collect::<Vec<_>>();
    if fields.is_empty() {
        return false;
    }
    // Detection is token-based so unrelated commands whose argv merely
    // contains a substring ("grep python", "vim python_notes",
    // "/opt/flowerpot") are never classified as Python applications.
    let executable = fields[0].rsplit('/').next().unwrap_or(fields[0]);
    if executable.contains("python") {
        return true;
    }
    if matches!(
        executable,
        "uvicorn" | "gunicorn" | "celery" | "flower" | "daphne"
    ) {
        return true;
    }
    fields.iter().any(|field| field.ends_with(".py"))
}

fn python_entry(args: &str) -> Option<String> {
    let fields = args.split_whitespace().collect::<Vec<_>>();
    if fields.is_empty() {
        return None;
    }
    // The interpreter is usually fields[0] (python* path); start after it.
    let start = if fields[0].contains("python") { 1 } else { 0 };
    let mut index = start;
    while index < fields.len() {
        let field = fields[index];
        if field == "-m" {
            return fields
                .get(index + 1)
                .map(|module| format!("module:{module}"));
        }
        if field == "-c" {
            return Some("inline:-c".into());
        }
        if field.ends_with(".py") {
            return Some(field.to_string());
        }
        let basename = field.rsplit('/').next().unwrap_or(field);
        if matches!(
            basename,
            "uvicorn" | "gunicorn" | "celery" | "flower" | "daphne"
        ) {
            return Some(basename.to_string());
        }
        if field.contains(':') && !field.starts_with("--") {
            // module:app spec passed to a framework binary.
            return Some(field.to_string());
        }
        index += 1;
    }
    None
}

fn python_nodes_from_ps_output(value: &str) -> Vec<RuntimeMapNode> {
    let mut nodes = Vec::new();
    for record in parse_ps_table(value)
        .into_iter()
        .filter(|record| is_python_process(&record.args))
        .take(MAX_PYTHON_PROCESSES)
    {
        let entry = python_entry(&record.args)
            .map(|entry| redact_sensitive_text(&entry))
            .unwrap_or_else(|| "python".into());
        let mut metadata = BTreeMap::new();
        metadata.insert("pid".into(), record.pid.to_string());
        metadata.insert("user".into(), record.user);
        metadata.insert("entry".into(), entry.clone());
        // Deliberately no raw `args` metadata: a credential the redaction
        // heuristic does not recognize (e.g. `--db-password hunter2`) would
        // otherwise be published verbatim through /daemon/runtime/map.
        metadata.insert(
            "serviceEntityKind".into(),
            service_entity_kind_name(&ServiceEntityKind::PythonApplication).into(),
        );
        nodes.push(RuntimeMapNode {
            id: format!("python_process_{}", record.pid),
            provider: RuntimeProviderKind::Python,
            kind: RuntimeNodeKind::PythonApplication,
            label: entry,
            status: Some("running".into()),
            layer: Some(RuntimeNodeLayer::Process),
            metadata,
            service: None,
            package: None,
        });
    }
    nodes
}

fn collect_python_processes(
    nodes: &mut Vec<RuntimeMapNode>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    let output = match run_command_with_timeout(
        {
            let mut command = Command::new("ps");
            command.args(["-eo", "pid=,user:32=,args="]);
            command
        },
        PROVIDER_COMMAND_TIMEOUT,
    ) {
        Ok(output) => output,
        Err(error) => {
            push_provider_diagnostic(
                diagnostics,
                RuntimeProviderKind::Python,
                DiagnosticSeverity::Info,
                format!("Python process discovery skipped: {error}"),
            );
            return;
        }
    };

    if !output.status.success() {
        return;
    }

    nodes.extend(python_nodes_from_ps_output(&String::from_utf8_lossy(
        &output.stdout,
    )));
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

fn collect_native_processes(
    nodes: &mut Vec<RuntimeMapNode>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    let output = match run_command_with_timeout(
        {
            let mut command = Command::new("ps");
            command.args(["-eo", "pid=,user:32=,args="]);
            command
        },
        PROVIDER_COMMAND_TIMEOUT,
    ) {
        Ok(output) => output,
        Err(error) => {
            push_provider_diagnostic(
                diagnostics,
                RuntimeProviderKind::Process,
                DiagnosticSeverity::Info,
                format!("Native process discovery skipped: {error}"),
            );
            return;
        }
    };

    if !output.status.success() {
        return;
    }

    let (native_nodes, capped) = native_process_nodes_from_ps_output(
        &String::from_utf8_lossy(&output.stdout),
        std::process::id(),
    );
    if capped {
        // ps emits pids in ascending order, so when the cap is hit the first
        // MAX_NATIVE_PROCESSES pids are surfaced and later-started services
        // (nginx, postgres, node, ...) are omitted — say so instead of
        // silently dropping them.
        push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::Process,
            DiagnosticSeverity::Info,
            format!("Native process discovery capped at {MAX_NATIVE_PROCESSES} processes"),
        );
    }
    nodes.extend(native_nodes);
}

/// Native-process node builder. `self_pid` is the daemon's own pid, which is
/// never published. Raw argv is deliberately NOT emitted (same posture as the
/// python provider — a credential the redaction heuristic does not recognize
/// must not leak through /daemon/runtime/map). Returns the nodes and whether
/// the filtered process count exceeded `MAX_NATIVE_PROCESSES` (the caller
/// turns that into the "Process count capped" diagnostic).
fn native_process_nodes_from_ps_output(value: &str, self_pid: u32) -> (Vec<RuntimeMapNode>, bool) {
    let filtered = parse_ps_table(value)
        .into_iter()
        .filter(|record| is_native_process(&record.args) && record.pid != self_pid)
        .collect::<Vec<_>>();
    let capped = filtered.len() > MAX_NATIVE_PROCESSES;
    let mut nodes = Vec::new();
    for record in filtered.into_iter().take(MAX_NATIVE_PROCESSES) {
        let fallback_comm = process_comm(&record.args).unwrap_or_else(|| "unknown".into());
        let comm = real_comm(record.pid, &fallback_comm);
        let mut metadata = BTreeMap::new();
        metadata.insert("pid".into(), record.pid.to_string());
        metadata.insert("user".into(), record.user);
        metadata.insert("comm".into(), comm.clone());
        nodes.push(RuntimeMapNode {
            id: format!("native_process_{}", record.pid),
            provider: RuntimeProviderKind::Process,
            kind: RuntimeNodeKind::Process,
            label: comm,
            status: Some("running".into()),
            layer: Some(RuntimeNodeLayer::Process),
            metadata,
            service: None,
            package: None,
        });
    }
    (nodes, capped)
}

/// Kernel command name for a pid, read from `/proc/<pid>/comm`. The proc
/// entry holds the real kernel comm even when the process rewrote argv[0]
/// (avahi-daemon renders as `avahi-daemon: running [host]` in ps args, nginx
/// as `nginx: master process`). Truncated to 16 characters like the kernel's
/// TASK_COMM_LEN. Falls back to `fallback` (derived from the ps args column)
/// when the proc entry is unreadable — which is also the path exercised by
/// fixture-based tests using fake pids.
fn real_comm(pid: u32, fallback: &str) -> String {
    if let Ok(comm) = std::fs::read_to_string(format!("/proc/{pid}/comm")) {
        let comm = comm.trim();
        if !comm.is_empty() {
            return comm.chars().take(16).collect();
        }
    }
    fallback.to_string()
}

/// First executable token of a ps args column, walking past common wrapper
/// executables (env, sudo, nice, nohup, timeout), option tokens, env
/// `NAME=VALUE` assignments, and numeric wrapper arguments (nice adjustment,
/// timeout duration) — so `env python3 script.py`, `nice -n 5 nginx ...`,
/// and `timeout 300 node ...` all resolve to the real command.
fn effective_executable(args: &str) -> Option<&str> {
    for token in args.split_whitespace() {
        if token.starts_with('[') {
            return Some(token); // kernel thread — brackets and slashes preserved
        }
        let basename = token.rsplit('/').next().unwrap_or(token);
        if matches!(basename, "env" | "sudo" | "nice" | "nohup" | "timeout") {
            continue; // wrapper executable — keep walking
        }
        if token.starts_with('-') {
            continue; // option token
        }
        if token.contains('=') {
            continue; // env NAME=VALUE assignment
        }
        if is_duration_like(token) {
            continue; // nice adjustment / timeout duration
        }
        return Some(basename);
    }
    None
}

/// Numeric token with an optional single unit suffix (`300`, `10s`, `5m`) —
/// i.e. a `nice` adjustment or `timeout` duration, never an executable.
/// Requires at least one leading digit so ordinary names like `sshd` (whose
/// letters all look like duration units) are never skipped.
fn is_duration_like(token: &str) -> bool {
    let digits = token
        .bytes()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    digits > 0
        && (digits == token.len()
            || (digits + 1 == token.len()
                && matches!(token.as_bytes()[digits], b's' | b'm' | b'h' | b'd')))
}

/// Extract the process command name (executable basename) from a ps args
/// column, resolving wrapper executables to the wrapped command. Kernel
/// threads render as `[kworker/0:0]` — brackets preserved so they are never
/// mistaken for an executable. A trailing `:` (daemons that rewrite argv[0],
/// e.g. `avahi-daemon: running [host]`) is stripped.
fn process_comm(args: &str) -> Option<String> {
    let executable = effective_executable(args)?;
    if executable.starts_with('[') {
        return Some(executable.to_string());
    }
    Some(executable.trim_end_matches(':').to_string())
}

/// Native-process detection: everything except kernel threads, python
/// interpreters (owned by the python provider), the daemon itself, container
/// runtime plumbing, and the transient `ps` process itself. Wrapper
/// executables (env, sudo, nice, nohup, timeout) resolve to the wrapped
/// command, so `env python3 ...` is excluded via the python check and
/// `nice ... nginx ...` is included as `nginx`.
fn is_native_process(args: &str) -> bool {
    let Some(comm) = effective_executable(args) else {
        return false;
    };
    if comm.starts_with('[') {
        return false; // kernel thread
    }
    if comm.contains("python") {
        return false; // python provider owns interpreter processes
    }
    if matches!(
        comm,
        "uvicorn" | "gunicorn" | "celery" | "flower" | "daphne"
    ) {
        return false; // python provider owns framework processes
    }
    if comm == "dockermap-daemon" || comm == "ps" {
        return false;
    }
    if comm.starts_with("containerd-shim") {
        return false; // container runtime plumbing
    }
    true
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
            let Some((address, port, socket_inode)) = parse_proc_net_listener_line(line) else {
                continue;
            };
            let mut metadata = BTreeMap::new();
            metadata.insert("address".into(), address.clone());
            metadata.insert("port".into(), port.to_string());
            metadata.insert("socketInode".into(), socket_inode);
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

/// Parse one `/proc/net/tcp` (or tcp6) line into `(address, port, inode)` for
/// a LISTEN-state socket; returns `None` for anything else.
fn parse_proc_net_listener_line(line: &str) -> Option<(String, u16, String)> {
    let fields = line.split_whitespace().collect::<Vec<_>>();
    if fields.len() < 10 || fields[3] != "0A" {
        return None;
    }
    let (address, port) = parse_proc_net_local_address(fields[1])?;
    Some((address, port, fields[9].to_string()))
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

fn parse_log_cursor(value: Option<&str>) -> Result<Option<LogCursor>, ApiError> {
    validate_optional_query(value, "cursor", 32)?
        .map(|value| {
            LogCursor::parse(value).ok_or_else(|| ApiError {
                status: StatusCode::BAD_REQUEST,
                message: "query parameter `cursor` must be `millis` or `millis:offset`".into(),
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
    use std::collections::HashSet;

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
            parse_log_cursor(Some("1785175506123")).expect("plain numeric cursor should parse"),
            Some(LogCursor {
                millis: 1_785_175_506_123,
                offset: 0
            })
        );
        assert_eq!(
            parse_log_cursor(Some("1785175506123:2")).expect("compound cursor should parse"),
            Some(LogCursor {
                millis: 1_785_175_506_123,
                offset: 2
            })
        );

        let non_numeric =
            parse_log_cursor(Some("abc")).expect_err("non-numeric cursor should fail");
        assert_eq!(non_numeric.status, StatusCode::BAD_REQUEST);

        let negative = parse_log_cursor(Some("-1")).expect_err("negative cursor should fail");
        assert_eq!(negative.status, StatusCode::BAD_REQUEST);

        let bad_offset =
            parse_log_cursor(Some("123:x")).expect_err("non-numeric offset should fail");
        assert_eq!(bad_offset.status, StatusCode::BAD_REQUEST);
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
    fn parses_systemd_list_units_from_fixture() {
        let summaries = parse_systemd_list_units(include_str!(
            "../../../tests/fixtures/providers/parser/systemd-list-units.txt"
        ));

        // Timer and any non-.service units are filtered out; failed/masked
        // services still surface with their real active states.
        let names = summaries
            .iter()
            .map(|summary| summary.unit.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            vec![
                "app-worker.service",
                "db.service",
                "masked-unit.service",
                "postgres.service"
            ]
        );
        assert_eq!(summaries[0].active_state, "active");
        assert_eq!(summaries[0].sub_state, "running");
        assert_eq!(summaries[0].description, "Application worker");
        assert_eq!(summaries[3].active_state, "failed");
        assert!(!names.iter().any(|name| name.contains("timer")));
    }

    #[test]
    fn parses_systemd_show_records_from_fixture() {
        let records = parse_systemd_show_records(include_str!(
            "../../../tests/fixtures/providers/parser/systemd-show.txt"
        ));

        assert_eq!(records.len(), 3);

        let worker = &records[0];
        assert_eq!(worker.id, "app-worker.service");
        assert_eq!(worker.restart.as_deref(), Some("on-failure"));
        assert_eq!(
            worker.active_enter_timestamp.as_deref(),
            Some("Tue 2026-08-18 04:05:06 UTC")
        );
        assert_eq!(
            worker.active_enter_monotonic_us,
            Some(1_723_942_196_123_456)
        );
        // Dependency lists track service units only (targets are filtered).
        assert_eq!(worker.requires, vec!["redis.service"]);
        assert_eq!(worker.wants, vec!["postgres.service"]);
        assert!(worker.part_of.is_empty());

        let db = &records[1];
        assert_eq!(db.id, "db.service");
        assert_eq!(db.active_state.as_deref(), Some("inactive"));
        assert_eq!(db.restart.as_deref(), Some("no"));
        assert_eq!(db.active_enter_monotonic_us, Some(0));

        assert_eq!(records[2].id, "masked-unit.service");
    }

    #[test]
    fn parses_cron_fixtures_for_system_user_and_cron_d() {
        let system = include_str!("../../../tests/fixtures/providers/parser/crontab-system.txt");
        let system_commands = system
            .lines()
            .filter_map(|line| cron_command(line, false))
            .collect::<Vec<_>>();
        assert_eq!(
            system_commands,
            vec![
                "cd / && run-parts --report /etc/cron.hourly",
                "test -x /usr/sbin/anacron || ( cd / && run-parts --report /etc/cron.daily )",
                "test -x /usr/sbin/anacron || ( cd / && run-parts --report /etc/cron.weekly )",
                "test -x /usr/sbin/anacron || ( cd / && run-parts --report /etc/cron.monthly )",
                "/srv/scripts/bootstrap.sh --env production",
                "/usr/bin/env APP_MODE=\"prod  sealed\" /srv/scripts/daemon.sh",
            ]
        );
        // Macro commands preserve the original command substring, including
        // repeated whitespace inside quoted arguments.
        assert_eq!(
            system_commands[5],
            "/usr/bin/env APP_MODE=\"prod  sealed\" /srv/scripts/daemon.sh"
        );
        assert!(system_commands[5].contains("prod  sealed"));

        let user = include_str!("../../../tests/fixtures/providers/parser/crontab-user.txt");
        let user_commands = user
            .lines()
            .filter_map(|line| cron_command(line, true))
            .collect::<Vec<_>>();
        assert_eq!(
            user_commands,
            vec![
                "/usr/local/bin/healthcheck --endpoint https://example.test/health",
                "/srv/backup/run.sh --bucket backups",
                "/usr/bin/curl -fsS https://example.test/ping >/dev/null 2>&1",
                "/srv/reports/generate.sh",
                "/srv/scripts/user-bootstrap.sh",
            ]
        );

        let cron_d = include_str!("../../../tests/fixtures/providers/parser/cron-d-file.txt");
        let cron_d_commands = cron_d
            .lines()
            .filter_map(|line| cron_command(line, false))
            .collect::<Vec<_>>();
        assert_eq!(
            cron_d_commands,
            vec![
                "/usr/sbin/logrotate /etc/logrotate.conf",
                "/usr/bin/php /srv/app/artisan schedule:run",
                "/usr/lib/postgresql/15/bin/pg_ctlcluster 15 main start",
            ]
        );
    }

    #[test]
    fn builds_pm2_nodes_from_fixture_jlist() {
        let nodes = pm2_app_nodes_from_jlist(include_str!(
            "../../../tests/fixtures/providers/parser/pm2-jlist.json"
        ))
        .expect("fixture jlist must parse");

        assert_eq!(nodes.len(), 3);
        assert_eq!(nodes[0].id, "pm2_app_0");
        assert_eq!(nodes[0].label, "web");
        assert_eq!(nodes[0].status.as_deref(), Some("online"));
        assert_eq!(nodes[0].layer, Some(RuntimeNodeLayer::Process));
        assert_eq!(
            nodes[0].metadata.get("cwd").map(String::as_str),
            Some("/srv/app")
        );
        assert_eq!(
            nodes[0].metadata.get("script").map(String::as_str),
            Some("/srv/app/dist/index.js")
        );
        assert_eq!(
            nodes[0].metadata.get("restartCount").map(String::as_str),
            Some("3")
        );

        assert_eq!(nodes[1].status.as_deref(), Some("stopped"));
        assert_eq!(nodes[2].id, "pm2_app_2");
        assert_eq!(nodes[2].status.as_deref(), Some("errored"));
        assert_eq!(
            nodes[2].metadata.get("restartCount").map(String::as_str),
            Some("12")
        );
    }

    #[test]
    fn parses_python_process_table_from_fixture() {
        let records = parse_ps_table(include_str!(
            "../../../tests/fixtures/providers/parser/python-ps-table.txt"
        ));

        assert_eq!(records.len(), 7);
        assert_eq!(records[0].pid, 1234);
        assert_eq!(records[0].user, "root");
        assert_eq!(
            records[0].args,
            "/usr/bin/python3 /srv/app/worker.py --queue default"
        );
        assert_eq!(records[5].args, "/usr/sbin/cron -f");
        assert_eq!(records[6].pid, 7890);
    }

    #[test]
    fn filters_and_classifies_python_processes_from_fixture() {
        let records = parse_ps_table(include_str!(
            "../../../tests/fixtures/providers/parser/python-ps-table.txt"
        ));

        let python = records
            .iter()
            .filter(|record| is_python_process(&record.args))
            .collect::<Vec<_>>();
        // cron and containerd-shim are not python processes.
        assert_eq!(python.len(), 5);
        assert_eq!(
            python.iter().map(|record| record.pid).collect::<Vec<_>>(),
            vec![1234, 2345, 3456, 4567, 5678]
        );

        assert_eq!(
            python_entry(&python[0].args).as_deref(),
            Some("/srv/app/worker.py")
        );
        assert_eq!(python_entry(&python[1].args).as_deref(), Some("uvicorn"));
        assert_eq!(
            python_entry(&python[2].args).as_deref(),
            Some("/srv/web/manage.py")
        );
        assert_eq!(
            python_entry(&python[3].args).as_deref(),
            Some("module:celery")
        );
        assert_eq!(
            python_entry(&python[4].args).as_deref(),
            Some("/srv/agent/agent.py")
        );
    }

    #[test]
    fn python_detection_ignores_substring_false_positives() {
        for args in [
            "grep python",
            "vim python_notes",
            "/opt/flowerpot --serve",
            "bash -c 'python'",
            "gunicornate --help",
        ] {
            assert!(
                !is_python_process(args),
                "{args} must not classify as a python process"
            );
        }
        assert!(is_python_process("/usr/bin/python3 /srv/app/worker.py"));
        assert!(is_python_process("/srv/app/.venv/bin/uvicorn app.main:app"));
        assert!(is_python_process("python3.12 -m celery -A tasks worker"));
    }

    #[test]
    fn builds_python_nodes_from_fixture() {
        let nodes = python_nodes_from_ps_output(include_str!(
            "../../../tests/fixtures/providers/parser/python-ps-table.txt"
        ));

        assert_eq!(nodes.len(), 5);

        let worker = &nodes[0];
        assert_eq!(worker.id, "python_process_1234");
        assert_eq!(worker.provider, RuntimeProviderKind::Python);
        assert_eq!(worker.kind, RuntimeNodeKind::PythonApplication);
        assert_eq!(worker.label, "/srv/app/worker.py");
        assert_eq!(worker.status.as_deref(), Some("running"));
        assert_eq!(worker.layer, Some(RuntimeNodeLayer::Process));
        assert_eq!(
            worker.metadata.get("entry").map(String::as_str),
            Some("/srv/app/worker.py")
        );
        assert_eq!(
            worker.metadata.get("user").map(String::as_str),
            Some("root")
        );
        assert_eq!(
            worker.metadata.get("serviceEntityKind").map(String::as_str),
            Some("python_application")
        );

        assert_eq!(nodes[1].label, "uvicorn");
        assert_eq!(nodes[3].id, "python_process_4567");
        assert_eq!(
            nodes[3].metadata.get("entry").map(String::as_str),
            Some("module:celery")
        );
    }

    #[test]
    fn redacts_python_process_args_with_tokens() {
        let mut nodes = python_nodes_from_ps_output(include_str!(
            "../../../tests/fixtures/providers/parser/python-ps-table.txt"
        ));
        redact_runtime_nodes(&mut nodes);

        // The agent process carries --token=... in its args; raw argv is never
        // published at all (no `args` metadata key), so the sentinel cannot
        // surface in labels, metadata, or ids.
        assert!(!nodes[4].metadata.contains_key("args"));
        assert_eq!(
            nodes[4].metadata.get("entry").map(String::as_str),
            Some("/srv/agent/agent.py")
        );
        assert_no_raw_secrets(&nodes, &["DOCKERMAP_TEST_FAKE_PYTHON_TOKEN"]);
    }

    #[test]
    fn parses_tmux_sessions_from_fixture() {
        let nodes = tmux_session_nodes_from_output(include_str!(
            "../../../tests/fixtures/providers/parser/tmux-sessions.txt"
        ));

        assert_eq!(nodes.len(), 3);
        assert_eq!(nodes[0].id, "tmux_session_0");
        assert_eq!(nodes[0].label, "work");
        assert_eq!(nodes[0].status.as_deref(), Some("attached"));
        assert_eq!(
            nodes[0].metadata.get("windows").map(String::as_str),
            Some("3")
        );
        assert_eq!(nodes[1].status.as_deref(), Some("detached"));
        assert_eq!(nodes[2].label, "monitoring");
        assert_eq!(nodes[2].status.as_deref(), Some("attached"));
        assert_eq!(nodes[0].layer, Some(RuntimeNodeLayer::Session));
    }

    #[test]
    fn builds_tailscale_nodes_from_fixture() {
        let status: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/providers/parser/tailscale-status.json"
        ))
        .expect("fixture must parse");
        let mut nodes = Vec::new();
        if let Some(self_node) = status.get("Self") {
            push_tailnet_node(
                &mut nodes,
                RuntimeProviderKind::Tailscale,
                "self",
                self_node,
            );
        }
        if let Some(peers) = status.get("Peer").and_then(serde_json::Value::as_object) {
            for (index, peer) in peers.values().enumerate() {
                push_tailnet_node(
                    &mut nodes,
                    RuntimeProviderKind::Tailscale,
                    &format!("peer_{index}"),
                    peer,
                );
            }
        }

        assert_eq!(nodes.len(), 3);
        assert_eq!(nodes[0].label, "hearth.example");
        assert_eq!(nodes[0].status.as_deref(), Some("online"));
        assert_eq!(
            nodes[0].metadata.get("ips").map(String::as_str),
            Some("100.64.0.1")
        );
        assert_eq!(
            nodes[0].metadata.get("user").map(String::as_str),
            Some("operator")
        );
        assert_eq!(nodes[1].label, "nas.example");
        assert_eq!(nodes[2].label, "laptop.example");
        assert_eq!(nodes[2].status.as_deref(), Some("offline"));
        assert_eq!(
            nodes[2].metadata.get("ips").map(String::as_str),
            Some("100.64.0.3,fd7a:115c:a1e0::3")
        );
        for node in &nodes {
            assert_eq!(node.layer, Some(RuntimeNodeLayer::Edge));
            assert!(node.id.starts_with("tailscale_node_"));
        }
    }

    #[test]
    fn builds_headscale_nodes_from_fixture() {
        let value: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/providers/parser/headscale-nodes.json"
        ))
        .expect("fixture must parse");
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
        let mut nodes = Vec::new();
        for (index, node) in nodes_json.into_iter().enumerate() {
            push_tailnet_node(
                &mut nodes,
                RuntimeProviderKind::Headscale,
                &format!("node_{index}"),
                &node,
            );
        }

        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[0].label, "nas");
        assert_eq!(nodes[0].status.as_deref(), Some("online"));
        assert_eq!(nodes[0].provider, RuntimeProviderKind::Headscale);
        assert_eq!(
            nodes[0].metadata.get("user").map(String::as_str),
            Some("ops")
        );
        assert!(nodes[0].id.starts_with("headscale_node_"));
        assert_eq!(nodes[1].label, "laptop");
        assert_eq!(nodes[1].status.as_deref(), Some("offline"));
    }

    #[test]
    fn redacts_nginx_server_blocks_fixture() {
        let fixture =
            include_str!("../../../tests/fixtures/providers/parser/nginx-server-blocks.conf");
        assert!(fixture.contains("DOCKERMAP_TEST_FAKE_NGINX_TOKEN"));

        // Whole-value redaction: a config carrying a token-like value is
        // collapsed entirely rather than partially exposed.
        assert_eq!(redact_sensitive_text(fixture), REDACTED_VALUE);

        // A clean config without secret markers passes through unchanged.
        let clean = fixture.replace(
            "proxy_set_header Authorization \"Bearer DOCKERMAP_TEST_FAKE_NGINX_TOKEN\";",
            "proxy_set_header X-Forwarded-Proto $scheme;",
        );
        assert!(!clean.contains("DOCKERMAP_TEST_FAKE"));
        assert_eq!(redact_sensitive_text(&clean), clean);
    }

    #[test]
    fn parses_proc_net_tcp_listener_fixture() {
        // The production listener collector's line parser, fed the fixture.
        let fixture =
            include_str!("../../../tests/fixtures/providers/parser/listeners-proc-net-tcp.txt");
        let listeners = fixture
            .lines()
            .skip(1)
            .filter_map(parse_proc_net_listener_line)
            .collect::<Vec<_>>();

        assert_eq!(listeners.len(), 3);
        assert_eq!(listeners[0].0, "127.0.0.1");
        assert_eq!(listeners[0].1, 8080);
        assert_eq!(listeners[0].2, "12345");
        assert_eq!(listeners[1].0, "0.0.0.0");
        assert_eq!(listeners[1].1, 3000);
        assert_eq!(listeners[2].0, "127.0.0.1");
        assert_eq!(listeners[2].1, 4096);
        assert_eq!(listeners[2].2, "34567");
    }

    #[test]
    fn parses_native_process_table_from_fixture() {
        let records = parse_ps_table(include_str!(
            "../../../tests/fixtures/providers/parser/native-ps-table.txt"
        ));

        assert_eq!(records.len(), 14);
        assert_eq!(records[0].pid, 9_000_001);
        assert_eq!(records[0].user, "root");
        assert_eq!(records[0].args, "/usr/sbin/nginx -g daemon off;");
        assert_eq!(
            process_comm(&records[6].args).as_deref(),
            Some("[kworker/0:1-events]")
        );
    }

    #[test]
    fn filters_native_processes_and_excludes_noise() {
        let fixture = include_str!("../../../tests/fixtures/providers/parser/native-ps-table.txt");
        let natives = parse_ps_table(fixture)
            .into_iter()
            .filter(|record| is_native_process(&record.args))
            .map(|record| record.pid)
            .collect::<Vec<_>>();

        // nginx, postgres, redis, sshd, dockerd, node, cron are native;
        // containerd-shim, kernel threads, python, the daemon itself, and the
        // transient ps process are excluded. Pids are beyond pid_max so the
        // fixture never collides with a live host process.
        assert_eq!(
            natives,
            vec![9_000_001, 9_000_002, 9_000_003, 9_000_004, 9_000_005, 9_000_013, 9_000_014]
        );
    }

    #[test]
    fn builds_native_process_nodes_from_fixture() {
        let (mut nodes, capped) = native_process_nodes_from_ps_output(
            include_str!("../../../tests/fixtures/providers/parser/native-ps-table.txt"),
            9_000_011, // the daemon's own pid (dockermap-daemon in the fixture)
        );
        assert!(!capped);
        redact_runtime_nodes(&mut nodes);

        assert_eq!(nodes.len(), 7);

        let nginx = &nodes[0];
        assert_eq!(nginx.id, "native_process_9000001");
        assert_eq!(nginx.provider, RuntimeProviderKind::Process);
        assert_eq!(nginx.kind, RuntimeNodeKind::Process);
        assert_eq!(nginx.label, "nginx");
        assert_eq!(nginx.status.as_deref(), Some("running"));
        assert_eq!(nginx.layer, Some(RuntimeNodeLayer::Process));
        assert_eq!(
            nginx.metadata.get("pid").map(String::as_str),
            Some("9000001")
        );
        assert_eq!(nginx.metadata.get("user").map(String::as_str), Some("root"));
        assert_eq!(
            nginx.metadata.get("comm").map(String::as_str),
            Some("nginx")
        );

        let node = &nodes[5];
        assert_eq!(node.id, "native_process_9000013");
        assert_eq!(node.label, "node");

        // No daemon self-node, and raw argv is never published.
        assert!(nodes.iter().all(|node| node.id != "native_process_9000011"));
        assert!(nodes.iter().all(|node| !node.metadata.contains_key("args")));
        assert_no_raw_secrets(&nodes, &["dockermap-daemon"]);
    }

    #[test]
    fn parses_long_usernames_from_ps_user_column() {
        // `ps -eo user=,` truncates usernames at 8 chars and appends '+'; the
        // providers use `user:32=` so full usernames must survive the parser.
        let records = parse_ps_table("  4242  systemd-resolve  /usr/lib/systemd/systemd-resolved");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].pid, 4242);
        assert_eq!(records[0].user, "systemd-resolve");
        assert_eq!(records[0].args, "/usr/lib/systemd/systemd-resolved");

        // A padded 32-char column (as `ps` actually emits) parses identically.
        let padded = format!(
            "  4242  {:<32}  /usr/lib/systemd/systemd-resolved",
            "systemd-resolve"
        );
        let records = parse_ps_table(&padded);
        assert_eq!(records[0].user, "systemd-resolve");
        assert_eq!(records[0].args, "/usr/lib/systemd/systemd-resolved");
    }

    #[test]
    fn process_comm_strips_argv_zero_rewrites_and_resolves_wrappers() {
        // Daemons that rewrite argv[0] (`avahi-daemon: running [host]`, nginx
        // master) must not leak a trailing colon into the comm.
        assert_eq!(
            process_comm("/usr/sbin/avahi-daemon: running [HEARTH.local]").as_deref(),
            Some("avahi-daemon")
        );
        assert_eq!(
            process_comm("/usr/sbin/nginx: master process").as_deref(),
            Some("nginx")
        );
        // Wrapper executables resolve to the wrapped command.
        assert_eq!(
            process_comm("/usr/bin/nice -n 5 /usr/sbin/nginx -g daemon off;").as_deref(),
            Some("nginx")
        );
        assert_eq!(
            process_comm("timeout 300 node /srv/server.js").as_deref(),
            Some("node")
        );
        assert_eq!(
            process_comm("env FOO=bar /usr/bin/python3 /srv/x.py").as_deref(),
            Some("python3")
        );
    }

    #[test]
    fn wrapper_executables_classify_as_the_wrapped_command() {
        // env-wrapped interpreters and frameworks belong to the python
        // provider, never to the native provider.
        assert!(!is_native_process("env python3 /srv/x.py"));
        assert!(!is_native_process(
            "env /srv/app/.venv/bin/uvicorn app.main:app"
        ));
        assert!(!is_native_process("env uvicorn app.main:app --port 8000"));
        // nice/timeout-wrapped daemons are native.
        assert!(is_native_process(
            "/usr/bin/nice -n 5 /usr/sbin/nginx -g daemon off;"
        ));
        assert!(is_native_process("timeout 300 node /srv/server.js"));
    }

    #[test]
    fn real_comm_falls_back_for_unreadable_proc_entry() {
        // 9_000_000-style pids are beyond pid_max (4_194_304) on any Linux
        // host, so /proc/<pid>/comm cannot exist — the argv-derived fallback
        // must win.
        assert_eq!(real_comm(9_000_000, "nginx"), "nginx");
        assert_eq!(real_comm(9_000_000, ""), "");
    }

    #[test]
    fn real_comm_prefers_proc_comm_over_rewritten_argv() {
        // The child rewrites argv[0] via `exec -a`, so the argv-derived
        // fallback ("fake-name") differs from the kernel comm ("sleep"); the
        // /proc/<pid>/comm entry must win.
        let Ok(mut child) = Command::new("bash")
            .arg("-c")
            .arg("exec -a /tmp/fake-name sleep 30")
            .spawn()
        else {
            return; // no bash/sleep in this environment — nothing to assert
        };
        // The child forks from this test thread, inheriting its comm
        // ("tests::real_com" — 15 chars) until bash execs; poll until the
        // exec'd comm is visible.
        let mut comm = String::new();
        for _ in 0..100 {
            comm = real_comm(child.id(), "fake-name");
            if comm == "sleep" {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = child.kill();
        let _ = child.wait();
        assert_eq!(comm, "sleep");
    }

    #[test]
    fn native_process_cap_is_reported_and_bounded() {
        let mut table = String::new();
        for pid in 1..=300 {
            table.push_str(&format!("{pid:>7}  root  /usr/bin/benchmark-{pid}\n"));
        }
        let (nodes, capped) = native_process_nodes_from_ps_output(&table, 9_000_000);
        assert!(
            capped,
            "300 filtered processes must exceed MAX_NATIVE_PROCESSES"
        );
        assert_eq!(nodes.len(), MAX_NATIVE_PROCESSES);
        // ps emits pids ascending, so the first MAX_NATIVE_PROCESSES surface.
        assert_eq!(
            nodes
                .first()
                .unwrap()
                .metadata
                .get("pid")
                .map(String::as_str),
            Some("1")
        );
        assert_eq!(
            nodes
                .last()
                .unwrap()
                .metadata
                .get("pid")
                .map(String::as_str),
            Some(MAX_NATIVE_PROCESSES.to_string().as_str())
        );
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
        assert_eq!(
            first_cursor, "999:1",
            "cursor is the oldest kept entry's ms plus its same-ms count emitted"
        );

        let (second, second_cursor) =
            page_log_entries(entries.clone(), None, LogCursor::parse(&first_cursor), 2);
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
        assert_eq!(second_cursor, "997:1");

        let (last, last_cursor) =
            page_log_entries(entries.clone(), None, LogCursor::parse(&second_cursor), 2);
        assert_eq!(last.len(), 1, "last page holds the remaining entry");
        assert_eq!(last[0].timestamp, 996);
        assert_eq!(last_cursor, None, "the last page has no cursor");
    }

    #[test]
    fn log_entry_ids_are_stable_and_unique_per_physical_line() {
        // Regression (round 8, F1): content hashing (service + timestamp +
        // message) gave two DISTINCT physical lines with the same service,
        // the same ms-truncated timestamp, and identical message text the
        // SAME id, so the UI's dedupe-by-id silently dropped the second line.
        // The within-ms ordinal — the line's index among same-ms entries in
        // stream order — must disambiguate identical-content same-ms lines
        // while staying stable for the same physical line across requests.
        let first = log_entry_id("api", 1_787_198_706_123, 0);
        let second = log_entry_id("api", 1_787_198_706_123, 1);
        assert_ne!(
            first, second,
            "identical-content same-ms lines must get distinct ids"
        );
        assert_eq!(
            log_entry_id("api", 1_787_198_706_123, 0),
            first,
            "the same physical line re-fetched must keep its id (stable ordinal)"
        );
        assert_ne!(
            log_entry_id("web", 1_787_198_706_123, 0),
            first,
            "different services must not collide"
        );
        assert_ne!(
            log_entry_id("api", 1_787_198_706_122, 0),
            first,
            "different timestamps must not collide"
        );
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
                id: log_entry_id("svc", 99, 0),
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

        let (kept, cursor) = page_log_entries(
            entries.clone(),
            None,
            Some(LogCursor {
                millis: 100,
                offset: 2,
            }),
            2,
        );
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

        let (second, second_cursor) =
            page_log_entries(entries.clone(), None, LogCursor::parse(&first_cursor), 2);
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
            first_cursor, "997:1",
            "first cursor keeps pointing at its own oldest entry"
        );
    }

    #[test]
    fn log_window_contract_emits_cursor_for_live_docker() {
        // Every page — first and cursor — opens the same fixed window, which
        // is far wider than any page size, so page_log_entries can always
        // detect "a next page exists" (`entries.len() > limit`) for the live
        // stream — a plain `tail(limit)` window could never produce a cursor.
        assert_eq!(log_tail_count(), MAX_LOG_CURSOR_TAIL);
        assert!(
            log_tail_count() > MAX_LOG_PAGE_SIZE,
            "the fixed window must exceed any page size so a next page is detectable"
        );

        // Feeding a window wider than `limit` into page_log_entries must
        // yield a page of exactly `limit` entries plus a cursor.
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
        assert_eq!(page.len(), 100, "the window is truncated to the page size");
        let cursor = cursor.expect("a full page with more behind it carries a cursor");
        assert_eq!(cursor, "9901:1", "cursor is the oldest kept entry");
    }

    #[test]
    fn same_ms_ordinals_are_stable_across_page_windows() {
        // Round-9 F1 regression: the same-millisecond ordinal used to be
        // window-relative — the first page tailed `limit + 1` lines while a
        // cursor page tailed MAX_LOG_CURSOR_TAIL. With a same-ms run longer
        // than the first page's window, the SAME physical lines got DIFFERENT
        // ordinals depending on which window collected them, so a cursor page
        // produced the SAME id set as the first page; the client's
        // dedupe-by-id then discarded the whole cursor page (silent data
        // loss) and live refreshes double-showed lines whose ordinal shifted.
        // With one fixed window the ordinal is a property of the physical
        // line: line i of a same-ms run is always `service-timestamp-i` on
        // every fetch.
        let service = "svc";
        let timestamp = 1_000_000u64;
        // 250 same-ms lines — longer than the OLD first-page window of
        // limit + 1 = 101, which is what made the id sets collide.
        let lines = (0..250)
            .map(|index| LogEntry {
                id: String::new(),
                timestamp,
                container: service.into(),
                level: dockermap_core::LogLevel::Info,
                message: format!("burst line {index}"),
            })
            .collect::<Vec<_>>();

        // Fetch through the same fixed window exactly like collect_logs:
        // assign stream-order ordinals and ids, then page the window.
        let fetch = |window: &[LogEntry], cursor: Option<LogCursor>, limit: usize| {
            let mut seen = HashMap::<u64, usize>::new();
            let entries = window
                .iter()
                .map(|entry| {
                    let ordinal = seen.entry(entry.timestamp).or_insert(0);
                    let id = log_entry_id(&entry.container, entry.timestamp, *ordinal);
                    *ordinal += 1;
                    LogEntry {
                        id,
                        ..entry.clone()
                    }
                })
                .collect::<Vec<_>>();
            page_log_entries(entries, None, cursor, limit)
        };

        let window = lines.clone();
        let (first_page, first_cursor) = fetch(&window, None, 100);
        let first_cursor = first_cursor.expect("a full first page carries a cursor");
        let (second_page, second_cursor) = fetch(&window, LogCursor::parse(&first_cursor), 100);
        let second_cursor = second_cursor.expect("a full second page carries a cursor");
        let (third_page, third_cursor) = fetch(&window, LogCursor::parse(&second_cursor), 100);
        assert!(
            third_cursor.is_none(),
            "the run ends with a cursor-less page"
        );

        // Walk the pages: no id overlap between pages, no duplicates, and
        // every physical line keeps its TRUE ordinal — line i is
        // `service-timestamp-i` no matter which fetch saw it.
        let mut ids = HashSet::new();
        let mut id_by_line = HashMap::<usize, String>::new();
        for page in [&first_page, &second_page, &third_page] {
            for entry in page {
                let id = &entry.id;
                assert!(
                    ids.insert(id.clone()),
                    "id {id} delivered twice across pages"
                );
                let index = entry
                    .message
                    .strip_prefix("burst line ")
                    .and_then(|value| value.parse::<usize>().ok())
                    .expect("every entry carries its physical line index");
                assert!(
                    id_by_line.insert(index, id.clone()).is_none(),
                    "physical line {index} delivered twice"
                );
            }
        }
        for (index, id) in id_by_line {
            assert_eq!(
                id,
                log_entry_id(service, timestamp, index),
                "line {index} must keep its true ordinal on every fetch"
            );
        }
    }

    #[test]
    fn skips_blank_and_unprefixed_log_lines_and_keeps_real_timestamps() {
        // Docker emits a blank line as "<timestamp> " (timestamp, space, empty
        // body). It must be skipped, not fabricated into a now-stamped entry
        // whose message is the raw timestamp string.
        assert_eq!(
            parse_timestamped_log_line(b"2026-08-20T03:03:02.538671807Z "),
            None,
            "blank lines must be skipped"
        );

        // Docker prefixes ONLY the first line of a multi-line message;
        // continuation lines are bare text with no timestamp. They must be
        // skipped — NOT stamped with now() — and their first token must not
        // be eaten as if it were a prefix.
        assert_eq!(
            parse_timestamped_log_line(b"hello world"),
            None,
            "a continuation line without a timestamp prefix must be skipped"
        );
        assert_eq!(
            parse_timestamped_log_line(b""),
            None,
            "a completely empty line must be skipped"
        );
        assert_eq!(
            parse_timestamped_log_line(b"   "),
            None,
            "a whitespace-only line must be skipped"
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
    fn log_until_covers_the_boundary_millisecond() {
        // Docker's `until` is second-resolution and exclusive. The compound
        // cursor's boundary millisecond must still be returned (its
        // not-yet-emitted same-ms entries resume via the offset), so `until`
        // is `floor(millis / 1000) + 1` — it covers the second CONTAINING
        // the boundary. Entries in that second that are newer than the
        // boundary are filtered out by page_log_entries afterwards.
        assert_eq!(log_until_seconds(1_785_175_506_123), 1_785_175_507);
        assert_eq!(
            log_until_seconds(1_785_175_506_000),
            1_785_175_507,
            "an exact second boundary must still include its own second"
        );
        assert_eq!(log_until_seconds(1_000), 2);
        assert_eq!(log_until_seconds(999), 1);
        assert_eq!(log_until_seconds(0), 1);
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

        let (page, _) = page_log_entries(
            entries,
            None,
            Some(LogCursor {
                millis: 1_000_123,
                offset: 1,
            }),
            10,
        );
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
