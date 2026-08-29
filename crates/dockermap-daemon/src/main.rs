use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    middleware,
    response::IntoResponse,
    routing::{any, get},
    Json, Router,
};
mod auth;
mod config;
mod docker_collector;
mod docker_config;
mod pid_namespace;
mod process_runner;
mod providers;
use auth::require_daemon_bearer_token;
#[cfg(test)]
use bollard::Docker;
use config::{
    project_root, read_bind_host_env, read_daemon_token_env, read_port_env, DaemonAuthToken,
};
#[cfg(test)]
use docker_collector::{
    log_entry_id, log_tail_count, log_until_seconds, parse_depends_on_label,
    parse_timestamped_log_line, MAX_LOG_CURSOR_TAIL,
};
use docker_collector::{publish_log_response, DockerCollector};
use dockermap_core::{
    collision_resistant_id_component, correlate_compose_runtime, derive_compose_graph,
    derive_graph, derive_images, derive_runtime_map, discover_compose_files, mock_log_entries,
    mock_snapshot, plan_compose_mount_edit, scan_compose_files, service_entity_kind_name,
    ComposeDiagnostic, ComposeEditPlan, ComposeFileOrigin, ComposeGraph, ComposeScan,
    ContainerRecord, DiagnosticSeverity, DockerSnapshot, GraphResponse, HealthResponse,
    HealthState, LogCursor, LogsResponse, RuntimeLocation, RuntimeMap, RuntimeMapDiagnostic,
    RuntimeMapEdge, RuntimeMapNode, RuntimeMode, RuntimeNodeKind, RuntimeNodeLayer,
    RuntimeOwnership, RuntimePackageEntity, RuntimeProviderKind, RuntimeRelationshipKind,
    RuntimeServiceEntity, RuntimeServiceStatus, ServiceEntityKind, DEFAULT_LOG_PAGE_SIZE,
    MAX_LOG_PAGE_SIZE,
};
#[cfg(test)]
use dockermap_core::{
    page_log_entries, ComposeMountKind, ContainerMount, LogEntry, NetworkRecord, VolumeRecord,
};
#[cfg(test)]
use pid_namespace::{
    cgroup_implies_container, pid_namespace_scope_from_evidence, restricted_pid_namespace_evidence,
    PidNamespaceMode,
};
use pid_namespace::{daemon_pid_namespace_scope, is_container_owned, PidNamespaceScope};
#[cfg(test)]
use process_runner::read_bounded;
use process_runner::{
    run_command_with_timeout, MAX_PROVIDER_OUTPUT_BYTES, PROVIDER_COMMAND_TIMEOUT,
};
use providers::{
    cron::collect_scheduled_jobs,
    overlay_network::{collect_headscale, collect_tailscale, provider_opt_in},
    systemd::collect_systemd_services,
};
use serde::Deserialize;
#[cfg(test)]
use std::collections::HashMap;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    net::SocketAddr,
    path::{Component, Path as StdPath, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{net::TcpListener, sync::RwLock, time::sleep};

const MAX_LOG_QUERY_CHARS: usize = 256;
const MAX_LOG_SERVICE_CHARS: usize = 128;
const MAX_COMPOSE_FILES: usize = 8;
const MAX_COMPOSE_FILE_CHARS: usize = 512;
const MAX_DISCOVERY_DIRS: usize = 4_096;
const MAX_NPM_PROJECTS: usize = 64;
const MAX_NPM_DEPENDENCIES_PER_PROJECT: usize = 64;
const MAX_PACKAGE_JSON_BYTES: u64 = 262_144;
const MAX_NPM_SCRIPTS: usize = 16;
const MAX_SCRIPT_CHARS: usize = 200;
const MAX_PYTHON_PROCESSES: usize = 64;
const MAX_NATIVE_PROCESSES: usize = 256;
pub(crate) const REDACTED_VALUE: &str = "[redacted]";

#[derive(Clone)]
struct AppState {
    cache: Arc<RwLock<DaemonCache>>,
    /// Reused bollard Docker client (connection pooling), created on first
    /// use and recreated after a failed interaction so a restarted Docker
    /// daemon is picked up. `None` means "not connected yet / previous
    /// attempt failed".
    docker: Arc<RwLock<Option<DockerCollector>>>,
    /// A timed-out blocking collection keeps running until its subprocesses
    /// unwind. Do not start a second expensive collection while that happens.
    runtime_collection_in_flight: Arc<AtomicBool>,
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
            "message": redact_runtime_display_text(&self.message),
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

    let daemon_token = read_daemon_token_env();
    let port = read_port_env("DOCKERMAP_DAEMON_PORT", 4100);
    let host = read_bind_host_env("DOCKERMAP_DAEMON_HOST", daemon_token.0.is_some());
    let address = SocketAddr::from((host, port));
    let state = AppState {
        cache: Arc::new(RwLock::new(DaemonCache::mock())),
        docker: Arc::new(RwLock::new(None)),
        runtime_collection_in_flight: Arc::new(AtomicBool::new(false)),
    };

    refresh_cache(&state).await;
    tokio::spawn(refresh_loop(state.clone()));

    let app = daemon_router(state, daemon_token);
    let listener = TcpListener::bind(address)
        .await
        .expect("daemon listener should bind");

    println!("dockermap-daemon listening on http://{address}");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("daemon server should run");
}

fn daemon_router(state: AppState, daemon_token: DaemonAuthToken) -> Router {
    Router::new()
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
        .layer(middleware::from_fn_with_state(
            daemon_token,
            require_daemon_bearer_token,
        ))
        .with_state(state)
}

impl DaemonCache {
    fn mock() -> Self {
        let mut snapshot = mock_snapshot();
        snapshot.images = derive_images(&snapshot);

        let mut health = HealthResponse {
            status: HealthState::Degraded,
            mode: RuntimeMode::Mock,
            docker_reachable: false,
            last_updated: snapshot.last_updated,
            snapshot_version: snapshot.last_updated.to_string(),
            message: Some("Docker unavailable, serving mock data".into()),
        };
        redact_health_response(&mut health);

        let last_updated = snapshot.last_updated;

        Self {
            snapshot,
            health,
            runtime_map: RuntimeMap {
                nodes: Vec::new(),
                edges: Vec::new(),
                diagnostics: Vec::new(),
                last_updated,
                ..Default::default()
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
        redact_health_response(&mut cache.health);
        cache.runtime_map = collect_runtime_map_bounded(state, &cache.snapshot).await;
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
    cache.runtime_map = collect_runtime_map_bounded(state, &cache.snapshot).await;
    // Docker failure details are provider-controlled text. Sanitize before the
    // cache becomes observable through health, API proxy, or SSE routes.
    redact_health_response(&mut cache.health);
    cache
}

fn empty_runtime_map(last_updated: u64) -> RuntimeMap {
    RuntimeMap {
        nodes: Vec::new(),
        edges: Vec::new(),
        diagnostics: Vec::new(),
        last_updated,
        ..Default::default()
    }
}

fn collect_runtime_map(snapshot: &DockerSnapshot) -> RuntimeMap {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut diagnostics = Vec::new();
    let project_root = project_root().ok();
    let pid_namespace = daemon_pid_namespace_scope();

    if let Some(message) = pid_namespace.diagnostic() {
        push_provider_diagnostic(
            &mut diagnostics,
            RuntimeProviderKind::Process,
            DiagnosticSeverity::Info,
            message.into(),
        );
    }

    if pid_namespace.is_restricted() {
        push_provider_diagnostic(
            &mut diagnostics,
            RuntimeProviderKind::Host,
            DiagnosticSeverity::Info,
            "Host node omitted because the daemon runs in a restricted PID namespace".into(),
        );
    } else {
        collect_host_node(project_root.as_deref(), &mut nodes);
    }
    collect_network_infrastructure(
        pid_namespace,
        snapshot,
        &mut nodes,
        &mut edges,
        &mut diagnostics,
    );
    collect_host_scoped_runtime_providers(pid_namespace, &mut nodes, &mut edges, &mut diagnostics);
    collect_python_processes(pid_namespace.is_restricted(), &mut nodes, &mut diagnostics);
    collect_native_processes_with_scope(
        pid_namespace.is_restricted(),
        &mut nodes,
        &mut diagnostics,
    );
    if let Some(root) = project_root.as_deref() {
        // This root is an explicit project mount/configuration target rather
        // than namespace-global discovery, so npm remains available even to a
        // containerized daemon (and is documented as mounted project data).
        collect_npm_projects(
            root,
            pid_namespace,
            &mut nodes,
            &mut edges,
            &mut diagnostics,
        );
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

/// Overall budget for one full runtime-map collection (all provider
/// subprocesses, the npm filesystem walk, and /proc reads) when it runs off
/// the async runtime.
const RUNTIME_MAP_COLLECTION_TIMEOUT: Duration = Duration::from_secs(15);

/// Collect the runtime map off the async runtime: the provider commands are
/// blocking `std::process` calls, so they must never run on a Tokio worker
/// thread, and the whole collection is bounded so a pathological provider (or
/// npm walk) degrades the map instead of stalling refresh.
struct RuntimeCollectionGuard(Arc<AtomicBool>);

impl RuntimeCollectionGuard {
    fn acquire(in_flight: Arc<AtomicBool>) -> Option<Self> {
        in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
            .then_some(Self(in_flight))
    }
}

impl Drop for RuntimeCollectionGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

async fn collect_runtime_map_bounded(state: &AppState, snapshot: &DockerSnapshot) -> RuntimeMap {
    let snapshot = snapshot.clone();
    let Some(collection_guard) =
        RuntimeCollectionGuard::acquire(state.runtime_collection_in_flight.clone())
    else {
        eprintln!("runtime map collection skipped: previous collection is still in flight");
        return fallback_runtime_map_with_message(
            &snapshot,
            "Runtime map collection is still in progress; host provider nodes omitted",
        );
    };
    let work = {
        let snapshot = snapshot.clone();
        tokio::task::spawn_blocking(move || {
            let _collection_guard = collection_guard;
            collect_runtime_map(&snapshot)
        })
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
    fallback_runtime_map_with_message(
        snapshot,
        "Runtime map collection failed or timed out; host provider nodes omitted",
    )
}

fn fallback_runtime_map_with_message(snapshot: &DockerSnapshot, message: &str) -> RuntimeMap {
    let mut runtime_map = derive_runtime_map(
        snapshot,
        Vec::new(),
        Vec::new(),
        vec![RuntimeMapDiagnostic {
            provider: RuntimeProviderKind::Other,
            severity: DiagnosticSeverity::Warning,
            message: message.into(),
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

/// `/proc/net`, init-service managers, schedulers, PM2, and tmux all expose
/// only the daemon container's view in a restricted PID namespace. Keep them
/// out of a host topology rather than relabeling container-local evidence.
fn collect_host_scoped_runtime_providers(
    pid_namespace: PidNamespaceScope,
    nodes: &mut Vec<RuntimeMapNode>,
    edges: &mut Vec<RuntimeMapEdge>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    if pid_namespace.is_restricted() {
        for (provider, message) in [
            (
                RuntimeProviderKind::Network,
                "Network listener discovery omitted because the daemon runs in a restricted PID namespace",
            ),
            (
                RuntimeProviderKind::Systemd,
                "systemd discovery omitted because the daemon runs in a restricted PID namespace",
            ),
            (
                RuntimeProviderKind::ScheduledJob,
                "Scheduled job discovery omitted because the daemon runs in a restricted PID namespace",
            ),
            (
                RuntimeProviderKind::Pm2,
                "PM2 discovery omitted because the daemon runs in a restricted PID namespace",
            ),
            (
                RuntimeProviderKind::Tmux,
                "tmux discovery omitted because the daemon runs in a restricted PID namespace",
            ),
        ] {
            push_provider_diagnostic(diagnostics, provider, DiagnosticSeverity::Info, message.into());
        }
        return;
    }

    collect_network_listeners(nodes, diagnostics);
    collect_systemd_services(nodes, edges, diagnostics);
    collect_scheduled_jobs(nodes, diagnostics);
    collect_pm2_apps(nodes, diagnostics);
    collect_tmux_sessions(nodes, diagnostics);
}

fn collect_network_infrastructure(
    pid_namespace: PidNamespaceScope,
    snapshot: &DockerSnapshot,
    nodes: &mut Vec<RuntimeMapNode>,
    edges: &mut Vec<RuntimeMapEdge>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    if pid_namespace.is_restricted() {
        for (provider, message) in [
            (
                RuntimeProviderKind::Tailscale,
                "Tailscale discovery skipped in restricted PID namespace",
            ),
            (
                RuntimeProviderKind::Headscale,
                "Headscale discovery skipped in restricted PID namespace",
            ),
            (
                RuntimeProviderKind::ReverseProxy,
                "Reverse-proxy configuration marker discovery skipped in restricted PID namespace",
            ),
            (
                RuntimeProviderKind::LocalDns,
                "Local DNS configuration marker discovery skipped in restricted PID namespace",
            ),
        ] {
            push_provider_diagnostic(
                diagnostics,
                provider,
                DiagnosticSeverity::Info,
                message.into(),
            );
        }
        // Docker snapshot records are affirmative host evidence even when the
        // daemon itself cannot safely inspect namespace-local files or tools.
        collect_network_containers(snapshot, nodes, edges);
        return;
    }

    if provider_opt_in("DOCKERMAP_ENABLE_TAILSCALE") {
        collect_tailscale(nodes, diagnostics);
    } else {
        push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::Tailscale,
            DiagnosticSeverity::Info,
            "Tailscale discovery disabled; set DOCKERMAP_ENABLE_TAILSCALE=true to opt in".into(),
        );
    }
    if provider_opt_in("DOCKERMAP_ENABLE_HEADSCALE") {
        collect_headscale(nodes, diagnostics);
    } else {
        push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::Headscale,
            DiagnosticSeverity::Info,
            "Headscale discovery disabled; set DOCKERMAP_ENABLE_HEADSCALE=true to opt in".into(),
        );
    }
    collect_network_config_markers(nodes);
    collect_network_containers(snapshot, nodes, edges);
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
        collision_resistant_id_component(product),
        collision_resistant_id_component(&container.id)
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
        target: format!(
            "docker_container_{}",
            collision_resistant_id_component(&container.id)
        ),
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
            id: format!("pm2_app_{}", collision_resistant_id_component(&id)),
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
    /// The ps `comm=` column — the kernel command name, never argv-derived.
    /// A process that rewrote argv[0] (`exec -a hunter2 sleep`) still reports
    /// its real comm here, so this is the only safe fallback for the native
    /// provider's label/comm metadata.
    comm: String,
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
        // pid, user, comm, args — the comm column is REQUIRED so a
        // 3-field table can never silently shift args into the comm slot.
        if fields.len() < 4 {
            continue;
        }
        let Ok(pid) = fields[0].parse::<u32>() else {
            continue;
        };
        // Walk to the args token's byte offset so the command keeps its
        // original spacing (sequential find cannot re-match earlier tokens).
        let mut offset = 0usize;
        for token in &fields[..3] {
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
            comm: fields[2].to_string(),
            args: args.to_string(),
        });
    }
    records
}

/// `ps` writes newline-delimited records. A bounded pipe read can end in the
/// middle of one, so discard an unterminated final fragment only when the
/// bounded reader reports that output was truncated.
fn complete_provider_lines(output: &[u8], output_truncated: bool) -> &[u8] {
    if !output_truncated || output.last() == Some(&b'\n') {
        return output;
    }
    output
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map(|last_newline| &output[..=last_newline])
        .unwrap_or_default()
}

fn push_provider_output_truncation(
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
    provider: RuntimeProviderKind,
) {
    push_provider_diagnostic(
        diagnostics,
        provider,
        DiagnosticSeverity::Info,
        format!("Provider output exceeded {MAX_PROVIDER_OUTPUT_BYTES} bytes; truncated"),
    );
}

fn contains_control_character(value: &str) -> bool {
    value.chars().any(char::is_control)
}

/// Python-ownership predicate shared by the python and native providers so
/// their coverage sets can never diverge (a `pypy3 /srv/x.py` process was
/// once emitted by BOTH providers as a duplicate node for the same pid).
/// Ownership is decided from the RESOLVED executable only — the
/// wrapper-walked first command token, so `sudo -s /usr/bin/python3 ...`
/// and `env -C /srv python3 ...` resolve to the interpreter — and never
/// from an arbitrary `.py` token elsewhere in argv (a wrapper's own script
/// argument, e.g. `dumb-init -- /usr/bin/node /app/tool.py`, stays
/// non-python). All python-ownership rules live here:
/// - python* interpreter names: any resolved executable containing "python";
/// - pypy-style interpreters: exactly `pypy` / `pypy2` / `pypy3` or a
///   `pypy3.`-prefixed version binary (`pypy3`, `pypy3.10`, ...). Deliberately
///   NOT a loose `starts_with("pypy")` prefix match: a binary named
///   `pypy3-tool` is a tool, not an interpreter. Because the tightened name
///   match is itself the ownership evidence, no `.py` script-token
///   requirement is needed — the old clause paired a loose prefix match with
///   a `.py` first-token check precisely to keep lookalike tools out — so
///   `-m module` invocations (`pypy3 -m celery -A tasks worker`) are
///   python-owned too;
/// - the five framework basenames: uvicorn, gunicorn, celery, flower, daphne.
///   The resolved executable is trimmed of a trailing `:` before matching —
///   gunicorn rewrites its process title to `gunicorn: master [app]` /
///   `gunicorn: worker [app]`, so the raw resolved basename is `gunicorn:`
///   and would otherwise match no framework (zero coverage).
///
/// `_args` is the full ps args column, passed alongside the resolved
/// executable by both callers; ownership currently rests on the executable
/// alone, but keeping args in the signature keeps every future
/// python-ownership refinement single-sourced here.
fn is_python_owned(executable: &str, _args: &str) -> bool {
    // Frameworks rewrite their process title (gunicorn: master [app] ...),
    // so the resolved executable may carry a trailing colon. Normalize it
    // before matching — the same trim `process_comm` applies.
    let executable = executable.trim_end_matches(':');
    if matches!(
        executable,
        "uvicorn" | "gunicorn" | "celery" | "flower" | "daphne"
    ) {
        return true; // framework processes are python-owned
    }
    if executable.contains("python") {
        return true; // python* interpreter
    }
    // pypy interpreter binaries are `pypy`, `pypy2`, `pypy3`, and
    // `pypy3.x` — never pypy-prefixed tools like `pypy3-tool`.
    executable == "pypy"
        || executable == "pypy2"
        || executable == "pypy3"
        || executable.starts_with("pypy3.")
}

fn is_python_process(args: &str) -> bool {
    // Detection resolves wrapper executables first (env, sudo, nice, nohup,
    // timeout, dumb-init, tini) and is token-based, so unrelated commands
    // whose argv merely contains a substring ("grep python", "vim
    // python_notes", "/opt/flowerpot") are never classified as Python
    // applications — while `env python3 ...` and
    // `dumb-init -- /usr/local/bin/python ...` are.
    let Some(executable) = effective_executable(args) else {
        return false;
    };
    is_python_owned(executable, args)
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
            let module = *fields.get(index + 1)?;
            return (!contains_control_character(module)).then(|| format!("module:{module}"));
        }
        if field == "-c" {
            return Some("inline:-c".into());
        }
        if field.ends_with(".py") {
            return (!contains_control_character(field)).then(|| field.to_string());
        }
        let basename = field.rsplit('/').next().unwrap_or(field);
        // Proctitle-rewritten frameworks (e.g. "gunicorn: master [app]")
        // carry a trailing colon; trim before matching so the entry point
        // and label are clean, mirroring is_python_owned/process_comm.
        let trimmed = basename.trim_end_matches(':');
        if matches!(
            trimmed,
            "uvicorn" | "gunicorn" | "celery" | "flower" | "daphne"
        ) {
            return Some(trimmed.to_string());
        }
        if field.contains(':') && !field.starts_with("--") {
            // module:app spec passed to a framework binary.
            return (!contains_control_character(field)).then(|| trimmed.to_string());
        }
        index += 1;
    }
    None
}

fn python_nodes_from_ps_output(value: &str) -> (Vec<RuntimeMapNode>, bool) {
    python_nodes_from_ps_output_with_container_filter(value, is_container_owned)
}

fn python_nodes_from_ps_output_with_container_filter(
    value: &str,
    is_container_owned: impl Fn(u32) -> bool,
) -> (Vec<RuntimeMapNode>, bool) {
    // Filter container-owned pids before the cap. Otherwise a noisy container
    // can consume all 64 slots and hide real host Python applications.
    let filtered = parse_ps_table(value)
        .into_iter()
        .filter(|record| is_python_process(&record.args) && !is_container_owned(record.pid))
        .collect::<Vec<_>>();
    let capped = filtered.len() > MAX_PYTHON_PROCESSES;
    let mut nodes = Vec::new();
    for record in filtered.into_iter().take(MAX_PYTHON_PROCESSES) {
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
    (nodes, capped)
}

fn collect_python_processes_from_output(
    stdout: &[u8],
    output_truncated: bool,
    nodes: &mut Vec<RuntimeMapNode>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    if output_truncated {
        push_provider_output_truncation(diagnostics, RuntimeProviderKind::Python);
    }
    let stdout = String::from_utf8_lossy(complete_provider_lines(stdout, output_truncated));
    let (python_nodes, capped) = python_nodes_from_ps_output(&stdout);
    if capped {
        push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::Python,
            DiagnosticSeverity::Info,
            format!("Python process discovery capped at {MAX_PYTHON_PROCESSES} processes"),
        );
    }
    nodes.extend(python_nodes);
}

fn collect_python_processes(
    restricted_pid_namespace: bool,
    nodes: &mut Vec<RuntimeMapNode>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    collect_python_processes_with_command_in_scope(
        process_discovery_command(),
        restricted_pid_namespace,
        nodes,
        diagnostics,
    );
}

#[cfg(test)]
fn collect_python_processes_with_command(
    command: Command,
    nodes: &mut Vec<RuntimeMapNode>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    collect_python_processes_with_command_in_scope(command, false, nodes, diagnostics);
}

fn collect_python_processes_with_command_in_scope(
    command: Command,
    restricted_pid_namespace: bool,
    nodes: &mut Vec<RuntimeMapNode>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    if restricted_pid_namespace {
        push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::Python,
            DiagnosticSeverity::Info,
            "Python process discovery omitted because the daemon runs in a restricted PID namespace; only the container's own processes would be visible".into(),
        );
        return;
    }
    let output = match run_command_with_timeout(command, PROVIDER_COMMAND_TIMEOUT) {
        Ok(output) => output,
        Err(error) => {
            let (severity, message) = if error.is_spawn() {
                (
                    DiagnosticSeverity::Warning,
                    "Python process discovery command unavailable".into(),
                )
            } else {
                (
                    DiagnosticSeverity::Warning,
                    format!("Python process discovery skipped: {error}"),
                )
            };
            push_provider_diagnostic(diagnostics, RuntimeProviderKind::Python, severity, message);
            return;
        }
    };

    if !output.status.success() {
        push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::Python,
            DiagnosticSeverity::Warning,
            "Python process discovery command failed".into(),
        );
        return;
    }

    collect_python_processes_from_output(
        &output.stdout,
        output.stdout_truncated,
        nodes,
        diagnostics,
    );
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

fn collect_native_processes_with_scope(
    restricted_pid_namespace: bool,
    nodes: &mut Vec<RuntimeMapNode>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    collect_native_processes_with_command(
        process_discovery_command(),
        restricted_pid_namespace,
        nodes,
        diagnostics,
    );
}

fn process_discovery_command() -> Command {
    let mut command = Command::new("ps");
    command.args(["-eo", "pid=,user:32=,comm=,args="]);
    command
}

fn collect_native_processes_with_command(
    command: Command,
    restricted_pid_namespace: bool,
    nodes: &mut Vec<RuntimeMapNode>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    if restricted_pid_namespace {
        push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::Process,
            DiagnosticSeverity::Info,
            "Native process discovery omitted because the daemon runs in a restricted PID namespace; only the container's own processes would be visible"
                .into(),
        );
        return;
    }
    let output = match run_command_with_timeout(command, PROVIDER_COMMAND_TIMEOUT) {
        Ok(output) => output,
        Err(error) => {
            let (severity, message) = if error.is_spawn() {
                (
                    DiagnosticSeverity::Warning,
                    "Native process discovery command unavailable".into(),
                )
            } else {
                (
                    DiagnosticSeverity::Warning,
                    format!("Native process discovery skipped: {error}"),
                )
            };
            push_provider_diagnostic(diagnostics, RuntimeProviderKind::Process, severity, message);
            return;
        }
    };

    if !output.status.success() {
        push_provider_diagnostic(
            diagnostics,
            RuntimeProviderKind::Process,
            DiagnosticSeverity::Warning,
            "Native process discovery command failed".into(),
        );
        return;
    }

    collect_native_processes_from_output(
        &output.stdout,
        output.stdout_truncated,
        std::process::id(),
        nodes,
        diagnostics,
    );
}

fn collect_native_processes_from_output(
    stdout: &[u8],
    output_truncated: bool,
    self_pid: u32,
    nodes: &mut Vec<RuntimeMapNode>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    if output_truncated {
        push_provider_output_truncation(diagnostics, RuntimeProviderKind::Process);
    }
    let stdout = String::from_utf8_lossy(complete_provider_lines(stdout, output_truncated));
    let (native_nodes, capped) = native_process_nodes_from_ps_output(&stdout, self_pid);
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
        .filter(|record| {
            is_native_process(&record.args)
                // Container internals are the docker provider's nodes, not
                // host native processes — drop any pid whose cgroup places
                // it inside a container.
                && !is_container_owned(record.pid)
                && record.pid != self_pid
        })
        .collect::<Vec<_>>();
    let capped = filtered.len() > MAX_NATIVE_PROCESSES;
    let mut nodes = Vec::new();
    for record in filtered.into_iter().take(MAX_NATIVE_PROCESSES) {
        // The ps comm column is the kernel command name, never argv-derived,
        // so the fallback can never publish an attacker-rewritten argv[0]
        // (`exec -a hunter2 sleep` still reports comm "sleep"). process_comm
        // applies the same trailing-colon trim to it.
        let ps_comm = process_comm(&record.comm)
            .and_then(|comm| safe_kernel_comm(&comm))
            .unwrap_or_else(|| "unknown".into());
        let comm = real_comm(record.pid, &ps_comm);
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
/// TASK_COMM_LEN. Falls back to `fallback` — the ps comm column, itself the
/// kernel comm, never argv — when the proc entry is unreadable (also the
/// path exercised by fixture-based tests using fake pids). When both are
/// empty or unavailable, "unknown" is returned: argv-derived names are never
/// published as metadata.
fn safe_kernel_comm(comm: &str) -> Option<String> {
    let comm = comm.trim();
    (!comm.is_empty() && !contains_control_character(comm)).then(|| comm.chars().take(16).collect())
}

fn real_comm(pid: u32, fallback: &str) -> String {
    // There is an intentional PID-reuse TOCTOU between the fixed `ps`
    // snapshot and this /proc read (measured about 79ms on Hearth: ps, parse,
    // 1,225 cgroup reads, then 1,225 comm reads). A reused pid can receive a
    // wrong comm, but that is cosmetic: comm is process-controlled either way,
    // raw args are never published, and the next 2-second refresh replaces it.
    if let Ok(comm) = std::fs::read_to_string(format!("/proc/{pid}/comm")) {
        if let Some(comm) = safe_kernel_comm(&comm) {
            return comm;
        }
    }
    safe_kernel_comm(fallback).unwrap_or_else(|| "unknown".into())
}

/// First executable token of a ps args column, walking past common wrapper
/// executables (env, sudo, nice, nohup, timeout, dumb-init, tini), option
/// tokens (including wrapper options that consume the FOLLOWING token as
/// their argument per the ACTIVE wrapper's table, e.g. `sudo -u USER cmd`),
/// env `NAME=VALUE` assignments, and numeric wrapper arguments (nice
/// adjustment, timeout duration) — so
/// `env python3 script.py`, `nice -n 5 nginx ...`, `timeout 300 node ...`,
/// `sudo -u www-data /usr/bin/python3 ...`, and
/// `dumb-init -- /usr/local/bin/python ...` all resolve to the real command.
fn effective_executable(args: &str) -> Option<&str> {
    // Tokens to skip as the argument of a preceding wrapper option.
    let mut skip = 0usize;
    // The wrapper whose option tokens are currently in play: only ITS
    // option-argument table applies, so `timeout -s/-k` consume the next
    // token while `sudo -s`/`sudo -k` (run shell / invalidate timestamp)
    // consume nothing and `env -C` consumes its argument (`env -S` does
    // NOT: the split-string is the remainder of the command line, not a
    // single following token).
    let mut wrapper: Option<&str> = None;
    for token in args.split_whitespace() {
        if skip > 0 {
            skip -= 1;
            continue;
        }
        if token.starts_with('[') {
            return Some(token); // kernel thread — brackets and slashes preserved
        }
        let basename = token.rsplit('/').next().unwrap_or(token);
        if matches!(
            basename,
            "env" | "sudo" | "nice" | "nohup" | "timeout" | "dumb-init" | "tini"
        ) {
            wrapper = Some(basename); // wrapper executable — keep walking
            continue;
        }
        if token.starts_with('-') {
            // Option token. If the ACTIVE wrapper's option takes the NEXT
            // token as its argument, skip it — otherwise the argument would
            // be mistaken for the executable (`sudo -u www-data python3 ...`
            // → "www-data").
            if let Some(active) = wrapper {
                if wrapper_option_arguments(active).contains(&token) {
                    skip = 1;
                }
            }
            continue;
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

/// Option tokens of a wrapper that consume the FOLLOWING token as their
/// argument, keyed per wrapper so a short option only skips its argument
/// when its own wrapper is active: `timeout -s SIGNAL` / `timeout -k
/// DURATION` take an argument, but `sudo -s` (run shell) and `sudo -k`
/// (invalidate timestamp) take none, while `env -C DIR` / `env --chdir DIR`
/// do. `env -S`/`--split-string` are deliberately ABSENT: the split-string
/// is the REMAINDER of the command line, not a single next token, so a
/// one-token skip would swallow the wrapped command — `env -S python3 ...`
/// resolved to None (dropped from BOTH providers) and `env -S python3 -m
/// http.server` resolved to `http.server` (misclassified native).
fn wrapper_option_arguments(wrapper: &str) -> &'static [&'static str] {
    match wrapper {
        "sudo" => &["-u", "--user"],
        "timeout" => &["-s", "--signal", "-k", "--kill-after"],
        "env" => &["-u", "--unset", "-C", "--chdir"],
        _ => &[],
    }
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

/// Native-process detection: everything except kernel threads, python-owned
/// processes (interpreters and frameworks — decided by the SAME
/// `is_python_owned` predicate as the python provider, so a pypy3 process
/// can never be claimed by both providers), the daemon itself, container
/// runtime plumbing, and the transient `ps` process itself. Wrapper
/// executables (env, sudo, nice, nohup, timeout, dumb-init, tini) resolve to
/// the wrapped command, so `env python3 ...` is excluded via the python
/// check and `nice ... nginx ...` is included as `nginx`.
fn is_native_process(args: &str) -> bool {
    let Some(comm) = effective_executable(args) else {
        return false;
    };
    if comm.starts_with('[') {
        return false; // kernel thread
    }
    if is_python_owned(comm, args) {
        return false; // python provider owns interpreters and frameworks
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
    pid_namespace: PidNamespaceScope,
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
        if !pid_namespace.is_restricted() {
            edges.push(RuntimeMapEdge {
                source: node_id.clone(),
                target: "host_local".into(),
                relationship: RuntimeRelationshipKind::RunsOn,
                metadata: BTreeMap::new(),
            });
        }

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

pub(crate) fn looks_like_ai_agent(value: &str) -> bool {
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

pub(crate) fn non_empty_string(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn redact_runtime_map(runtime_map: &mut RuntimeMap) {
    redact_runtime_nodes(&mut runtime_map.nodes);
    redact_runtime_edges(&mut runtime_map.edges);
    redact_runtime_diagnostics(&mut runtime_map.diagnostics);
    normalize_runtime_map_topology(runtime_map);
}

/// Identifier normalization can collapse distinct hostile strings to the same
/// replacement form. Preserve every observed node and make collision ownership
/// explicit: the web model removes collided IDs from its selection index, so
/// no client can route an ambiguous ID to an arbitrary record.
fn normalize_runtime_map_topology(runtime_map: &mut RuntimeMap) {
    let duplicate_node_ids = duplicate_runtime_node_ids(&runtime_map.nodes);
    runtime_map.nodes.sort_by_key(runtime_node_sort_key);
    for _ in duplicate_node_ids {
        runtime_map.diagnostics.push(RuntimeMapDiagnostic {
            provider: RuntimeProviderKind::Other,
            severity: DiagnosticSeverity::Warning,
            message: "Duplicate runtime topology ID after publication normalization; records remain visible and non-routable".into(),
        });
    }

    let node_ids = runtime_map
        .nodes
        .iter()
        .map(|node| node.id.as_str())
        .collect::<BTreeSet<_>>();
    runtime_map.edges.retain(|edge| {
        node_ids.contains(edge.source.as_str()) && node_ids.contains(edge.target.as_str())
    });
    runtime_map.edges.sort_by_key(runtime_edge_sort_key);
    runtime_map.edges.dedup();
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

fn redact_runtime_nodes(nodes: &mut [RuntimeMapNode]) {
    for node in nodes {
        redact_runtime_node(node);
    }
}

pub(crate) fn redact_runtime_node(node: &mut RuntimeMapNode) {
    node.id = redact_runtime_display_text(&node.id);
    node.label = redact_runtime_display_text(&node.label);
    if let Some(status) = &mut node.status {
        *status = redact_runtime_display_text(status);
    }
    for value in node.metadata.values_mut() {
        *value = redact_runtime_display_text(value);
    }
    redact_service_entity(node.service.as_mut());
    redact_package_entity(node.package.as_mut());
}

fn redact_service_entity(service: Option<&mut RuntimeServiceEntity>) {
    let Some(service) = service else {
        return;
    };
    service.name = redact_runtime_display_text(&service.name);
    // service.status is a closed enum and cannot carry provider free text.
    for value in &mut service.dependencies {
        *value = redact_runtime_display_text(value);
    }
    for value in &mut service.dependents {
        *value = redact_runtime_display_text(value);
    }
    if let Some(health) = &mut service.health {
        // health.state is a closed enum and cannot carry provider free text.
        if let Some(source) = &mut health.source {
            *source = redact_runtime_display_text(source);
        }
        if let Some(message) = &mut health.message {
            *message = redact_runtime_display_text(message);
        }
    }
    for log in &mut service.logs {
        log.id = redact_runtime_display_text(&log.id);
        log.source = redact_runtime_display_text(&log.source);
        // log.level is a closed enum and cannot carry provider free text.
    }
    for event in &mut service.events {
        event.id = redact_runtime_display_text(&event.id);
        event.kind = redact_runtime_display_text(&event.kind);
        if let Some(message) = &mut event.message {
            *message = redact_runtime_display_text(message);
        }
    }
    redact_ownership(service.owner.as_mut());
    redact_location(service.location.as_mut());
}

fn redact_package_entity(package: Option<&mut RuntimePackageEntity>) {
    let Some(package) = package else {
        return;
    };
    package.name = redact_runtime_display_text(&package.name);
    package.version = redact_runtime_display_text(&package.version);
    for value in &mut package.dependencies {
        *value = redact_runtime_display_text(value);
    }
    for value in &mut package.dependents {
        *value = redact_runtime_display_text(value);
    }
    if let Some(update) = &mut package.update {
        update.current_version = redact_runtime_display_text(&update.current_version);
        if let Some(latest) = &mut update.latest_version {
            *latest = redact_runtime_display_text(latest);
        }
        for advisory in &mut update.advisories {
            advisory.id = redact_runtime_display_text(&advisory.id);
            advisory.title = redact_runtime_display_text(&advisory.title);
            advisory.source = redact_runtime_display_text(&advisory.source);
            if let Some(fixed) = &mut advisory.fixed_version {
                *fixed = redact_runtime_display_text(fixed);
            }
            if let Some(url) = &mut advisory.url {
                *url = redact_runtime_display_text(url);
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
    owner.name = redact_runtime_display_text(&owner.name);
    if let Some(id) = &mut owner.id {
        *id = redact_runtime_display_text(id);
    }
}

fn redact_location(location: Option<&mut RuntimeLocation>) {
    let Some(location) = location else {
        return;
    };
    location.value = redact_runtime_display_text(&location.value);
    if let Some(detail) = &mut location.detail {
        *detail = redact_runtime_display_text(detail);
    }
}

fn redact_runtime_edges(edges: &mut [RuntimeMapEdge]) {
    for edge in edges {
        edge.source = redact_runtime_display_text(&edge.source);
        edge.target = redact_runtime_display_text(&edge.target);
        for value in edge.metadata.values_mut() {
            *value = redact_runtime_display_text(value);
        }
    }
}

fn redact_runtime_diagnostics(diagnostics: &mut [RuntimeMapDiagnostic]) {
    for diagnostic in diagnostics {
        diagnostic.message = redact_runtime_display_text(&diagnostic.message);
    }
}

/// Apply the same redact-and-normalize publication boundary to compose data
/// before it is returned directly or used to derive a graph. Compose paths and
/// diagnostic origins are provider-controlled display text just like runtime
/// provider output.
fn redact_compose_scan(scan: &mut ComposeScan) {
    for file in &mut scan.files {
        *file = redact_runtime_display_text(file);
    }
    scan.project_root = redact_runtime_display_text(&scan.project_root);
    let diagnostic_file = scan.files.first().cloned().unwrap_or_default();
    let mut environment_key_collisions = Vec::new();
    for service in &mut scan.services {
        service.name = redact_runtime_display_text(&service.name);
        if let Some(image) = &mut service.image {
            *image = redact_runtime_display_text(image);
        }
        let mut environment = BTreeMap::new();
        for (key, value) in std::mem::take(&mut service.environment) {
            let published_key = redact_runtime_display_text(&key);
            let published_value = redact_runtime_display_text(&value);
            if environment.contains_key(&published_key) {
                environment_key_collisions.push(ComposeDiagnostic {
                    id: "compose_environment_key_collision".into(),
                    severity: DiagnosticSeverity::Warning,
                    message: "An environment key was dropped after publication normalization"
                        .into(),
                    origin: ComposeFileOrigin {
                        file: diagnostic_file.clone(),
                        service: Some(service.name.clone()),
                        field: "environment".into(),
                    },
                });
                continue;
            }
            environment.insert(published_key, published_value);
        }
        service.environment = environment;
        for dependency in &mut service.depends_on {
            *dependency = redact_runtime_display_text(dependency);
        }
    }
    scan.diagnostics.extend(environment_key_collisions);
    for mount in &mut scan.mounts {
        mount.id = redact_runtime_display_text(&mount.id);
        mount.service = redact_runtime_display_text(&mount.service);
        if let Some(source) = &mut mount.source {
            *source = redact_runtime_display_text(source);
        }
        if let Some(source) = &mut mount.resolved_source {
            *source = redact_runtime_display_text(source);
        }
        mount.target = redact_runtime_display_text(&mount.target);
        redact_compose_origin(&mut mount.origin);
    }
    for correlation in &mut scan.correlations {
        correlation.id = redact_runtime_display_text(&correlation.id);
        correlation.service = redact_runtime_display_text(&correlation.service);
        if let Some(container) = &mut correlation.container {
            *container = redact_runtime_display_text(container);
        }
        if let Some(mount_id) = &mut correlation.compose_mount_id {
            *mount_id = redact_runtime_display_text(mount_id);
        }
        correlation.target = redact_runtime_display_text(&correlation.target);
        if let Some(source) = &mut correlation.declared_source {
            *source = redact_runtime_display_text(source);
        }
        if let Some(source) = &mut correlation.runtime_source {
            *source = redact_runtime_display_text(source);
        }
    }
    for diagnostic in &mut scan.diagnostics {
        diagnostic.id = redact_runtime_display_text(&diagnostic.id);
        diagnostic.message = redact_runtime_display_text(&diagnostic.message);
        redact_compose_origin(&mut diagnostic.origin);
    }
}

fn redact_compose_origin(origin: &mut ComposeFileOrigin) {
    origin.file = redact_runtime_display_text(&origin.file);
    if let Some(service) = &mut origin.service {
        *service = redact_runtime_display_text(service);
    }
    origin.field = redact_runtime_display_text(&origin.field);
}

/// Apply the complete compose edit-plan publication boundary. Planning needs
/// raw fields to locate and diff the requested mount, but no provider-derived
/// value may cross the HTTP boundary unredacted.
fn redact_compose_edit_plan(plan: &mut ComposeEditPlan) {
    plan.file = redact_runtime_display_text(&plan.file);
    plan.service = redact_runtime_display_text(&plan.service);
    plan.mount_id = redact_runtime_display_text(&plan.mount_id);
    if let Some(source) = &mut plan.original_source {
        *source = redact_runtime_display_text(source);
    }
    plan.original_target = redact_runtime_display_text(&plan.original_target);
    if let Some(source) = &mut plan.new_source {
        *source = redact_runtime_display_text(source);
    }
    if let Some(target) = &mut plan.new_target {
        *target = redact_runtime_display_text(target);
    }
    // Redact individual diff lines first so markers and safe context remain
    // readable, then normalize unsafe scalars without re-redacting the whole
    // diff as one sensitive string.
    plan.unified_diff = normalize_runtime_display_string(&redact_unified_diff(&plan.unified_diff));
    for diagnostic in &mut plan.diagnostics {
        diagnostic.id = redact_runtime_display_text(&diagnostic.id);
        diagnostic.message = redact_runtime_display_text(&diagnostic.message);
        redact_compose_origin(&mut diagnostic.origin);
    }
}

fn redact_health_response(health: &mut HealthResponse) {
    if let Some(message) = &mut health.message {
        *message = redact_runtime_display_text(message);
    }
}

/// Clone cached Docker inventory at the HTTP publication boundary. Raw cache
/// entries remain available for internal correlation and exact-name lookup.
fn publish_docker_snapshot(snapshot: &DockerSnapshot) -> DockerSnapshot {
    let mut published = snapshot.clone();
    redact_docker_snapshot(&mut published);
    published
}

fn redact_docker_snapshot(snapshot: &mut DockerSnapshot) {
    for container in &mut snapshot.containers {
        redact_container_record(container);
    }
    for image in &mut snapshot.images {
        image.image = redact_runtime_display_text(&image.image);
        redact_display_strings(&mut image.containers);
        image.status = redact_runtime_display_text(&image.status);
    }
    for network in &mut snapshot.networks {
        network.id = redact_runtime_display_text(&network.id);
        network.name = redact_runtime_display_text(&network.name);
        network.driver = redact_runtime_display_text(&network.driver);
        redact_display_strings(&mut network.members);
    }
    for volume in &mut snapshot.volumes {
        volume.id = redact_runtime_display_text(&volume.id);
        volume.name = redact_runtime_display_text(&volume.name);
        redact_display_strings(&mut volume.attached_to);
    }
}

fn redact_container_record(container: &mut ContainerRecord) {
    container.id = redact_runtime_display_text(&container.id);
    container.name = redact_runtime_display_text(&container.name);
    container.image = redact_runtime_display_text(&container.image);
    container.status = redact_runtime_display_text(&container.status);
    container.role = redact_runtime_display_text(&container.role);
    redact_display_strings(&mut container.networks);
    redact_display_strings(&mut container.ports);
    redact_display_strings(&mut container.depends_on);
    for mount in &mut container.mounts {
        mount.id = redact_runtime_display_text(&mount.id);
        if let Some(source) = &mut mount.source {
            *source = redact_runtime_display_text(source);
        }
        mount.target = redact_runtime_display_text(&mount.target);
    }
}

fn redact_display_strings(values: &mut [String]) {
    for value in values {
        *value = redact_runtime_display_text(value);
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

pub(crate) fn redact_sensitive_text(value: &str) -> String {
    if is_sensitive_text(value) {
        REDACTED_VALUE.into()
    } else {
        value.to_string()
    }
}

/// Single post-redaction gate for every runtime-map display string. Provider
/// data is hostile: controls, bidi isolates, invisible formatting characters,
/// Unicode line separators, and noncharacters can spoof names in the UI or
/// daemon logs. Replace each unsafe scalar rather than relying on individual
/// parsers to notice field-specific cases.
pub(crate) fn redact_runtime_display_text(value: &str) -> String {
    normalize_runtime_display_string(&redact_sensitive_text(value))
}

fn normalize_runtime_display_string(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if unsafe_runtime_display_character(character) {
                '\u{FFFD}'
            } else {
                character
            }
        })
        .collect()
}

fn unsafe_runtime_display_character(character: char) -> bool {
    let code = character as u32;
    character.is_control()
        || (0x200B..=0x200F).contains(&code)
        || (0x2028..=0x202E).contains(&code)
        || (0x2060..=0x2069).contains(&code)
        || code == 0xFEFF
        || (0xFDD0..=0xFDEF).contains(&code)
        || matches!(code & 0xFFFF, 0xFFFE | 0xFFFF)
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

pub(crate) fn safe_runtime_id_component(value: &str, fallback: &str) -> String {
    if redact_sensitive_text(value) == REDACTED_VALUE {
        let generated = collision_resistant_id_component(value);
        let hash = generated
            .rsplit_once("--")
            .map_or("identity", |(_, hash)| hash);
        format!("{fallback}--{hash}")
    } else {
        collision_resistant_id_component(value)
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
                    collision_resistant_id_component(&address),
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

pub(crate) fn push_provider_diagnostic(
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
    provider: RuntimeProviderKind,
    severity: DiagnosticSeverity,
    message: String,
) {
    // One sanitized value drives both stderr and the API diagnostic. This is
    // deliberately before logging: provider paths/errors can contain secrets.
    let safe = redact_sensitive_text(&message);
    let safe = normalize_runtime_display_string(&safe);
    let mut stderr = std::io::stderr();
    let _ = write_provider_diagnostic(&mut stderr, &provider, &severity, &safe);
    diagnostics.push(RuntimeMapDiagnostic {
        provider,
        severity,
        message: safe,
    });
}

fn write_provider_diagnostic(
    writer: &mut impl std::io::Write,
    provider: &RuntimeProviderKind,
    severity: &DiagnosticSeverity,
    message: &str,
) -> std::io::Result<()> {
    writeln!(
        writer,
        "provider diagnostic ({provider:?}, {severity:?}): {message}"
    )
}

async fn get_health(State(state): State<AppState>) -> Json<HealthResponse> {
    let cache = state.cache.read().await;
    let mut health = cache.health.clone();
    redact_health_response(&mut health);
    Json(health)
}

async fn get_snapshot(State(state): State<AppState>) -> Json<DockerSnapshot> {
    let cache = state.cache.read().await;
    let mut published = publish_docker_snapshot(&cache.snapshot);
    // Actual source stamp: these bytes came from live Docker collection or
    // the daemon's mock fallback — attested by the cache's runtime mode so
    // the browser can never mistake fabricated sample bytes for host data
    // (#85 A3).
    published.source = Some(cache.health.mode.clone());
    Json(published)
}

async fn get_graph(State(state): State<AppState>) -> Json<GraphResponse> {
    let cache = state.cache.read().await;
    let snapshot = publish_docker_snapshot(&cache.snapshot);
    Json(derive_graph(&snapshot))
}

async fn get_runtime_map(State(state): State<AppState>) -> Json<RuntimeMap> {
    // Served from the cache: the map is recomputed on the refresh cadence
    // (off the async runtime, with per-provider timeouts) instead of on every
    // request, which previously ran ~8 blocking provider subprocesses
    // synchronously on a Tokio worker per call.
    let cache = state.cache.read().await;
    let mut runtime_map = cache.runtime_map.clone();
    // Actual source stamp, matching /daemon/snapshot (#85 A3): the runtime
    // map bytes are live-host or daemon-mock, attested by the cache mode.
    runtime_map.source = Some(cache.health.mode.clone());
    Json(runtime_map)
}

async fn get_containers(State(state): State<AppState>) -> Json<serde_json::Value> {
    let cache = state.cache.read().await;
    let snapshot = publish_docker_snapshot(&cache.snapshot);
    Json(serde_json::json!({ "containers": snapshot.containers }))
}

async fn get_container(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<ContainerRecord>, ApiError> {
    let cache = state.cache.read().await;
    let mut container = cache
        .snapshot
        .containers
        .iter()
        .find(|item| item.name == name)
        .cloned()
        .ok_or(ApiError {
            status: StatusCode::NOT_FOUND,
            message: format!("container `{name}` not found"),
        })?;
    redact_container_record(&mut container);

    Ok(Json(container))
}

async fn get_images(State(state): State<AppState>) -> Json<serde_json::Value> {
    let cache = state.cache.read().await;
    let snapshot = publish_docker_snapshot(&cache.snapshot);
    Json(serde_json::json!({ "images": snapshot.images }))
}

async fn get_networks(State(state): State<AppState>) -> Json<serde_json::Value> {
    let cache = state.cache.read().await;
    let snapshot = publish_docker_snapshot(&cache.snapshot);
    Json(serde_json::json!({ "networks": snapshot.networks }))
}

async fn get_volumes(State(state): State<AppState>) -> Json<serde_json::Value> {
    let cache = state.cache.read().await;
    let snapshot = publish_docker_snapshot(&cache.snapshot);
    Json(serde_json::json!({ "volumes": snapshot.volumes }))
}

fn docker_log_collection_failed(error: &str) -> ApiError {
    eprintln!(
        "Docker log collection failed: {}",
        redact_runtime_display_text(error)
    );
    ApiError {
        status: StatusCode::BAD_GATEWAY,
        message: "Docker log collection failed".into(),
    }
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
    // Capture the mode ONCE at the initial cache read, alongside
    // docker_reachable, so the response stamp describes the same source that
    // SELECTED the live-vs-mock branch. A second cache read after the
    // collection awaits could observe a mode flip mid-request and stamp
    // fabricated entries as docker (or live entries as mock) (#89 P1).
    let mode = cache.health.mode.clone();
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
                source: Some(mode.clone()),
            }));
        };
        let collector = docker_collector(&state)
            .await
            .map_err(|error| docker_log_collection_failed(&error))?;
        collector
            .collect_logs(service, q, cursor, limit)
            .await
            .map_err(|error| docker_log_collection_failed(&error))?
    } else {
        publish_log_response(
            service,
            mock_log_entries(&snapshot, service),
            q,
            cursor,
            limit,
        )
    };

    let mut stamped = response;
    // Actual source stamp: fabricated mock log lines must never be shown as
    // live host activity, and live log lines must never be relabelled sample
    // (#87 E1). The stamp uses the mode captured at the INITIAL cache read —
    // the same value that selected the live-vs-mock branch — so a mode flip
    // mid-request cannot mislabel the bytes (#89 P1).
    stamped.source = Some(mode);
    Ok(Json(stamped))
}

fn compose_file_unavailable(diagnostic: String) -> ApiError {
    eprintln!(
        "Compose request unavailable: {}",
        redact_runtime_display_text(&diagnostic)
    );
    ApiError {
        status: StatusCode::BAD_REQUEST,
        message: "requested Compose file is unavailable".into(),
    }
}

fn compose_inspection_unavailable(diagnostic: String) -> ApiError {
    eprintln!(
        "Compose inspection unavailable: {}",
        redact_runtime_display_text(&diagnostic)
    );
    ApiError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        message: "Compose inspection is unavailable".into(),
    }
}

fn compose_scan_unavailable(diagnostic: String) -> ApiError {
    eprintln!(
        "Compose scan unavailable: {}",
        redact_runtime_display_text(&diagnostic)
    );
    ApiError {
        status: StatusCode::BAD_REQUEST,
        message: "Compose scan is unavailable".into(),
    }
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
    let project_root = project_root().map_err(compose_inspection_unavailable)?;
    let file =
        resolve_scannable_file(&project_root, &query.file).map_err(compose_file_unavailable)?;
    let service = validate_required_value(&query.service, "service", MAX_LOG_SERVICE_CHARS)?;
    let source =
        validate_optional_query(query.source.as_deref(), "source", MAX_COMPOSE_FILE_CHARS)?;
    let target =
        validate_optional_query(query.target.as_deref(), "target", MAX_COMPOSE_FILE_CHARS)?;
    let scan = scan_compose_files(&project_root, std::slice::from_ref(&file))
        .map_err(compose_scan_unavailable)?;
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
    let content = fs::read_to_string(&file).map_err(|error| {
        compose_file_unavailable(format!(
            "failed to read compose file `{}`: {error}",
            file.display()
        ))
    })?;

    let mut plan = plan_compose_mount_edit(&file, &content, mount, source, target);
    redact_compose_edit_plan(&mut plan);
    Ok(Json(plan))
}

async fn scan_compose_query(query: ComposeScanQuery) -> Result<ComposeScan, ApiError> {
    let project_root = project_root().map_err(compose_inspection_unavailable)?;

    let files = match query.file {
        Some(value) if !value.trim().is_empty() => {
            let requested = parse_compose_file_query(&value)?;
            requested
                .iter()
                .map(|value| resolve_scannable_file(&project_root, value))
                .collect::<Result<Vec<_>, _>>()
                .map_err(compose_file_unavailable)?
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
            .map_err(compose_file_unavailable)?,
    };

    let scan = scan_compose_files(&project_root, &files).map_err(compose_scan_unavailable)?;

    Ok(scan)
}

async fn not_found() -> ApiError {
    ApiError {
        status: StatusCode::NOT_FOUND,
        message: "Route not found".into(),
    }
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

pub(crate) fn truncate_chars(value: &str, max_chars: usize) -> String {
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
    use axum::extract::Request;
    use dockermap_core::{
        ComposeMount, RuntimeAdvisorySeverity, RuntimeEventRef, RuntimeLogLevel, RuntimeLogRef,
        RuntimeOwnershipKind, RuntimePackageAdvisory, RuntimePackageUpdate,
    };
    use std::collections::HashSet;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::UnixListener,
    };
    use tower::util::ServiceExt;

    fn test_daemon_state() -> AppState {
        AppState {
            cache: Arc::new(RwLock::new(DaemonCache::mock())),
            docker: Arc::new(RwLock::new(None)),
            runtime_collection_in_flight: Arc::new(AtomicBool::new(false)),
        }
    }

    #[tokio::test]
    async fn daemon_bearer_boundary_allows_only_the_exact_configured_token() {
        let allowed = daemon_router(test_daemon_state(), DaemonAuthToken(None))
            .oneshot(
                Request::builder()
                    .uri("/daemon/health")
                    .body(axum::body::Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("daemon router should respond");
        assert_eq!(allowed.status(), StatusCode::OK);

        for header in [
            None,
            Some("Bearer wrong-token"),
            Some("bearer expected-token"),
            Some("Bearer expected-token extra"),
            Some("Basic expected-token"),
        ] {
            let mut request = Request::builder().uri("/daemon/health");
            if let Some(header) = header {
                request = request.header("Authorization", header);
            }
            let response = daemon_router(
                test_daemon_state(),
                DaemonAuthToken(Some(Arc::<str>::from("expected-token"))),
            )
            .oneshot(
                request
                    .body(axum::body::Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("daemon router should respond");
            assert_eq!(
                response.status(),
                StatusCode::UNAUTHORIZED,
                "header={header:?}"
            );
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("unauthorized body should be readable");
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&body)
                    .expect("unauthorized body should be JSON"),
                serde_json::json!({
                    "code": "unauthorized",
                    "message": "A valid Bearer token is required for this DockerMap daemon route"
                })
            );
        }

        let accepted = daemon_router(
            test_daemon_state(),
            DaemonAuthToken(Some(Arc::<str>::from("expected-token"))),
        )
        .oneshot(
            Request::builder()
                .uri("/daemon/health")
                .header("Authorization", "Bearer expected-token")
                .body(axum::body::Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("daemon router should respond");
        assert_eq!(accepted.status(), StatusCode::OK);
    }

    #[test]
    fn docker_stub_log_errors_have_a_fixed_location_neutral_client_message() {
        // Mirrors the body returned by a Unix-socket Docker stub during logs
        // collection: provider text is diagnostic-only and never a response.
        let provider_error = "Docker stub 500: /srv/private/docker.log via 10.1.2.3:2375 token=DOCKERMAP_TEST_FAKE_SOL6_DOCKER_ERROR_SECRET";
        let error = docker_log_collection_failed(provider_error);
        assert_eq!(error.status, StatusCode::BAD_GATEWAY);
        assert_eq!(error.message, "Docker log collection failed");
        for forbidden in [
            "/srv/private/docker.log",
            "10.1.2.3:2375",
            "DOCKERMAP_TEST_FAKE_SOL6_DOCKER_ERROR_SECRET",
        ] {
            assert!(
                !error.message.contains(forbidden),
                "Docker-provider detail leaked into client error: {}",
                error.message
            );
        }
    }

    #[tokio::test]
    async fn daemon_logs_route_redacts_hostile_bollard_error_from_into_response() {
        let tempdir = tempfile::tempdir().expect("temporary Docker socket directory");
        let socket_path = tempdir.path().join("docker.sock");
        let listener = UnixListener::bind(&socket_path).expect("Docker stub should bind");
        let hostile = "Docker stub 500: /srv/private/docker.log via 10.1.2.3:2375 token=DOCKERMAP_TEST_FAKE_SOL6_DOCKER_ERROR_SECRET\u{202e}\u{001b}\u{200b}";
        let response_body = serde_json::json!({ "message": hostile }).to_string();

        let stub = tokio::spawn(async move {
            let (mut stream, _) = listener
                .accept()
                .await
                .expect("Docker request should arrive");
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = stream
                    .read(&mut chunk)
                    .await
                    .expect("Docker request should be readable");
                assert!(read > 0, "Docker client should send request headers");
                request.extend_from_slice(&chunk[..read]);
            }
            let response = format!(
                "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            stream
                .write_all(response.as_bytes())
                .await
                .expect("Docker stub response should be written");
        });

        let mut cache = DaemonCache::mock();
        cache.health.docker_reachable = true;
        let state = AppState {
            cache: Arc::new(RwLock::new(cache)),
            docker: Arc::new(RwLock::new(Some(DockerCollector::with_client(
                Docker::connect_with_unix(
                    socket_path.to_str().expect("socket path should be UTF-8"),
                    2,
                    bollard::API_DEFAULT_VERSION,
                )
                .expect("Bollard should connect to the Unix stub"),
                None,
            )))),
            runtime_collection_in_flight: Arc::new(AtomicBool::new(false)),
        };

        let response = daemon_router(state, DaemonAuthToken(None))
            .oneshot(
                Request::builder()
                    .uri("/daemon/logs?service=api")
                    .body(axum::body::Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("daemon router should respond");
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("ApiError response body should be readable");
        let published = String::from_utf8(body.to_vec()).expect("response should be UTF-8 JSON");
        assert!(published.contains("Docker log collection failed"));
        assert!(!published.contains("/srv/private/docker.log"));
        assert!(!published.contains("10.1.2.3:2375"));
        assert!(!published.contains("DOCKERMAP_TEST_FAKE_SOL6_DOCKER_ERROR_SECRET"));
        assert!(!published.chars().any(|character| {
            let code = character as u32;
            code <= 0x1f || (0x7f..=0x9f).contains(&code) || (0x200b..=0x202e).contains(&code)
        }));

        stub.await.expect("Docker stub should finish");
    }

    /// This is the measured Bollard wire contract for the Docker Read Gateway
    /// planned in #62. It intentionally records the real requests emitted by
    /// the collector rather than deriving an allowlist from Bollard method
    /// names. Any client/library upgrade that changes a target, query, method,
    /// or adds negotiation traffic must make this test fail for review.
    #[tokio::test]
    async fn bollard_wire_contract_for_current_docker_reads() {
        let tempdir = tempfile::tempdir().expect("temporary Docker socket directory");
        let socket_path = tempdir.path().join("docker.sock");
        let listener = UnixListener::bind(&socket_path).expect("Docker stub should bind");

        let trace = tokio::spawn(async move {
            let mut requests = Vec::new();
            for _ in 0..5 {
                let (mut stream, _) = listener
                    .accept()
                    .await
                    .expect("Bollard request should arrive");
                let mut request = Vec::new();
                let mut chunk = [0_u8; 1024];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let read = stream
                        .read(&mut chunk)
                        .await
                        .expect("Bollard request should be readable");
                    assert!(read > 0, "Bollard request must include HTTP headers");
                    request.extend_from_slice(&chunk[..read]);
                }
                let request =
                    String::from_utf8(request).expect("Bollard request must be UTF-8 HTTP");
                let target = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .expect("Bollard request line must include a target")
                    .to_string();
                let body = if target.contains("/containers/json") || target.contains("/networks") {
                    "[]"
                } else if target.contains("/volumes") {
                    r#"{"Volumes":[],"Warnings":null}"#
                } else if target.contains("/containers/api/logs") {
                    ""
                } else {
                    panic!("unexpected Bollard target: {target}");
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(), body
                );
                stream
                    .write_all(response.as_bytes())
                    .await
                    .expect("Docker stub response should be written");
                requests.push(
                    request
                        .lines()
                        .next()
                        .expect("request line recorded")
                        .to_string(),
                );
            }
            requests
        });

        let collector = DockerCollector::with_client(
            Docker::connect_with_unix(
                socket_path.to_str().expect("socket path should be UTF-8"),
                2,
                bollard::API_DEFAULT_VERSION,
            )
            .expect("Bollard should connect to the Unix stub"),
            None,
        );
        collector
            .collect_snapshot()
            .await
            .expect("list reads should succeed");
        collector
            .collect_logs("api", None, None, 100)
            .await
            .expect("bounded log read should succeed");
        collector
            .collect_logs(
                "api",
                None,
                Some(LogCursor {
                    millis: 1_706_000_123_456,
                    offset: 7,
                }),
                100,
            )
            .await
            .expect("bounded historical log read should succeed");

        let requests = trace.await.expect("wire trace should finish");
        assert_eq!(requests, vec![
            "GET /containers/json?all=true&size=false HTTP/1.1",
            "GET /networks? HTTP/1.1",
            "GET /volumes? HTTP/1.1",
            "GET /containers/api/logs?follow=false&stdout=true&stderr=true&since=0&until=0&timestamps=true&tail=4096 HTTP/1.1",
            "GET /containers/api/logs?follow=false&stdout=true&stderr=true&since=0&until=1706000124&timestamps=true&tail=4096 HTTP/1.1",
        ], "Bollard wire contract changed; update the gateway ADR and policy review before permitting a new request shape");
    }

    /// Docker label filtering is part of the gateway contract, not a collector
    /// convenience: the proxy must fail closed if the engine-side scope changes.
    #[tokio::test]
    async fn bollard_wire_contract_for_label_filtered_inventory() {
        let tempdir = tempfile::tempdir().expect("temporary Docker socket directory");
        let socket_path = tempdir.path().join("docker.sock");
        let listener = UnixListener::bind(&socket_path).expect("Docker stub should bind");
        let trace = tokio::spawn(async move {
            let mut requests = Vec::new();
            for _ in 0..3 {
                let (mut stream, _) = listener
                    .accept()
                    .await
                    .expect("Bollard request should arrive");
                let mut request = Vec::new();
                let mut chunk = [0_u8; 1024];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let read = stream
                        .read(&mut chunk)
                        .await
                        .expect("Bollard request should be readable");
                    assert!(read > 0, "Bollard request must include HTTP headers");
                    request.extend_from_slice(&chunk[..read]);
                }
                let request =
                    String::from_utf8(request).expect("Bollard request must be UTF-8 HTTP");
                let target = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .expect("Bollard request line must include a target")
                    .to_string();
                let body = if target.contains("/containers/json") || target.contains("/networks") {
                    "[]"
                } else if target.contains("/volumes") {
                    r#"{"Volumes":[],"Warnings":null}"#
                } else {
                    panic!("unexpected Bollard target: {target}");
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(), body
                );
                stream
                    .write_all(response.as_bytes())
                    .await
                    .expect("Docker stub response should be written");
                requests.push(
                    request
                        .lines()
                        .next()
                        .expect("request line recorded")
                        .to_string(),
                );
            }
            requests
        });
        let collector = DockerCollector::with_client(
            Docker::connect_with_unix(
                socket_path.to_str().expect("socket path should be UTF-8"),
                2,
                bollard::API_DEFAULT_VERSION,
            )
            .expect("Bollard should connect to the Unix stub"),
            Some("com.dockermap.fixture=trace-123".into()),
        );
        collector
            .collect_snapshot()
            .await
            .expect("filtered list reads should succeed");
        let requests = trace.await.expect("wire trace should finish");
        assert_eq!(requests, vec![
            "GET /containers/json?all=true&size=false&filters=%7B%22label%22%3A%5B%22com.dockermap.fixture%3Dtrace-123%22%5D%7D HTTP/1.1",
            "GET /networks?filters=%7B%22label%22%3A%5B%22com.dockermap.fixture%3Dtrace-123%22%5D%7D HTTP/1.1",
            "GET /volumes?filters=%7B%22label%22%3A%5B%22com.dockermap.fixture%3Dtrace-123%22%5D%7D HTTP/1.1",
        ], "Bollard filtered wire contract changed; update the gateway ADR and policy review before permitting a new request shape");
    }

    #[tokio::test]
    async fn api_error_response_sanitizes_every_message_before_serialization() {
        let hostile = "failure at /srv/private/docker.log from 10.1.2.3:2375 token=DOCKERMAP_TEST_FAKE_SOL6_DOCKER_ERROR_SECRET";
        let response = ApiError {
            status: StatusCode::BAD_GATEWAY,
            message: hostile.into(),
        }
        .into_response();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("ApiError response body should be readable");
        let published = String::from_utf8(bytes.to_vec()).expect("ApiError response is UTF-8 JSON");
        for forbidden in [
            "/srv/private/docker.log",
            "10.1.2.3:2375",
            "DOCKERMAP_TEST_FAKE_SOL6_DOCKER_ERROR_SECRET",
        ] {
            assert!(
                !published.contains(forbidden),
                "ApiError publication leaked {forbidden}"
            );
        }
    }

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
    fn builds_pm2_nodes_from_fixture_jlist() {
        let nodes = pm2_app_nodes_from_jlist(include_str!(
            "../../../tests/fixtures/providers/parser/pm2-jlist.json"
        ))
        .expect("fixture jlist must parse");

        assert_eq!(nodes.len(), 3);
        assert!(nodes[0].id.starts_with("pm2_app_0--"));
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
        assert!(nodes[2].id.starts_with("pm2_app_2--"));
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
        assert_eq!(records[0].comm, "python3");
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
    fn python_detection_resolves_wrappers_and_tightens_py_match() {
        // Wrapper-walked interpreters belong to the python provider: the
        // resolved executable is the interpreter, never the wrapper or an
        // option argument (`sudo -u www-data ...` must not resolve to
        // "www-data").
        assert!(is_python_process(
            "dumb-init -- /usr/local/bin/python -u /app/flaresolverr.py"
        ));
        assert!(is_python_process("env python3 -m uvicorn app.main:app"));
        assert!(is_python_process(
            "sudo -u www-data /usr/bin/python3 /srv/x.py"
        ));
        assert!(is_python_process(
            "env -u SECRET /usr/bin/python3 /srv/x.py"
        ));
        // The .py match is no longer any-field: a wrapper's own script
        // argument must not mis-attribute a non-python process.
        assert!(!is_python_process(
            "dumb-init -- /usr/bin/node /app/tool.py"
        ));
        assert!(!is_python_process("tini -- /usr/sbin/nginx -g daemon off;"));
    }

    #[test]
    fn pypy_interpreters_are_python_owned_and_excluded_from_native() {
        // pypy-style interpreters belong to the python provider — including
        // `-m module` invocations and versioned binaries — and the native
        // provider must exclude them: a `pypy3 /srv/x.py` process used to be
        // emitted by BOTH providers as a duplicate node for the same pid
        // because the native filter only excluded `python*` names. Both
        // sides now share `is_python_owned`, so they cannot diverge.
        for args in [
            "pypy3 /srv/x.py",
            "pypy3 -m celery -A tasks worker",
            "/usr/bin/pypy3.10 /srv/x.py",
            "pypy /srv/x.py",
            "pypy2 /srv/x.py",
        ] {
            assert!(is_python_process(args), "{args} must be python-owned");
            assert!(
                !is_native_process(args),
                "{args} must be excluded from the native provider"
            );
        }
        // A pypy-prefixed TOOL is not an interpreter: the interpreter match
        // is exactly `pypy` / `pypy2` / `pypy3` / a `pypy3.`-versioned
        // binary — never a loose `starts_with("pypy")` prefix.
        assert!(!is_python_process("/opt/pypy3-tool --serve"));
        assert!(is_native_process("/opt/pypy3-tool --serve"));
    }

    #[test]
    fn gunicorn_proctitle_rewrites_are_python_owned() {
        // gunicorn rewrites its process title to `gunicorn: master [app]` /
        // `gunicorn: worker [app]`, so the resolved executable is `gunicorn:`
        // (trailing colon). `is_python_owned` trims the colon before the
        // framework match — without it these processes matched no framework,
        // fell to the native provider, and got zero coverage (live: the
        // authentik gunicorn master/worker were absent from
        // /daemon/runtime/map).
        for args in [
            "gunicorn: master [authentik.root.asgi:application]",
            "gunicorn: worker [authentik.root.asgi:application]",
        ] {
            assert!(is_python_process(args), "{args} must be python-owned");
            assert!(
                !is_native_process(args),
                "{args} must be excluded from the native provider"
            );
        }
        // The normalization is generic, so any trailing-colon proctitle
        // still matches its framework basename.
        assert!(is_python_process("uvicorn: app.main:app"));
        assert!(!is_native_process("uvicorn: app.main:app"));

        // The entry point (and thus the label) is clean too — no trailing
        // colon, mirroring the native provider's process_comm.
        assert_eq!(
            python_entry("gunicorn: master [authentik.root.asgi:application]").as_deref(),
            Some("gunicorn")
        );
        assert_eq!(
            python_entry("uvicorn: app.main:app").as_deref(),
            Some("uvicorn")
        );
    }

    #[test]
    fn python_entry_rejects_unicode_control_characters_before_label_publication() {
        for control in ['\u{1b}', '\u{7f}', '\u{80}'] {
            for args in [
                format!("/usr/bin/python3 /tmp/unsafe{control}.py"),
                format!("/usr/bin/python3 -m unsafe{control}module"),
                format!("/usr/bin/python3 unsafe{control}:app"),
            ] {
                assert_eq!(python_entry(&args), None, "{args:?} must be rejected");
            }
        }

        let table = "  9000200  root  python3  /usr/bin/python3 /tmp/unsafe\u{7f}.py\n";
        let (nodes, capped) = python_nodes_from_ps_output(table);
        assert!(!capped);
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].label, "python");
        assert!(nodes[0]
            .metadata
            .values()
            .all(|value| !value.chars().any(char::is_control)));
    }

    #[test]
    fn builds_python_nodes_from_fixture() {
        let (nodes, capped) = python_nodes_from_ps_output(include_str!(
            "../../../tests/fixtures/providers/parser/python-ps-table.txt"
        ));

        assert!(!capped);
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
        let (mut nodes, capped) = python_nodes_from_ps_output(include_str!(
            "../../../tests/fixtures/providers/parser/python-ps-table.txt"
        ));
        assert!(!capped);
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
        assert!(nodes[0].id.starts_with("tmux_session_0--"));
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

        assert_eq!(records.len(), 15);
        assert_eq!(records[0].pid, 9_000_001);
        assert_eq!(records[0].user, "root");
        assert_eq!(records[0].comm, "nginx");
        assert_eq!(records[0].args, "/usr/sbin/nginx -g daemon off;");
        assert_eq!(
            process_comm(&records[6].args).as_deref(),
            Some("[kworker/0:1-events]")
        );
        // A rewritten argv[0] ("hunter2") never leaks into the comm column.
        assert_eq!(records[14].comm, "sleep");
        assert_eq!(records[14].args, "hunter2 --sleep-forever");
    }

    #[test]
    fn filters_native_processes_and_excludes_noise() {
        let fixture = include_str!("../../../tests/fixtures/providers/parser/native-ps-table.txt");
        let natives = parse_ps_table(fixture)
            .into_iter()
            .filter(|record| is_native_process(&record.args))
            .map(|record| record.pid)
            .collect::<Vec<_>>();

        // nginx, postgres, redis, sshd, dockerd, node, cron, and the
        // argv-rewritten `sleep` are native; containerd-shim, kernel threads,
        // python, the daemon itself, and the transient ps process are
        // excluded. Pids are beyond pid_max so the fixture never collides
        // with a live host process.
        assert_eq!(
            natives,
            vec![
                9_000_001, 9_000_002, 9_000_003, 9_000_004, 9_000_005, 9_000_013, 9_000_014,
                9_000_015
            ]
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

        assert_eq!(nodes.len(), 8);

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

        // The argv-rewritten row (argv[0] "hunter2", kernel comm "sleep")
        // publishes the kernel comm — never the fake argv name.
        let hunter2 = &nodes[7];
        assert_eq!(hunter2.id, "native_process_9000015");
        assert_eq!(hunter2.label, "sleep");
        assert_eq!(
            hunter2.metadata.get("comm").map(String::as_str),
            Some("sleep")
        );
        assert!(hunter2.label != "hunter2");

        // No daemon self-node, and raw argv is never published.
        assert!(nodes.iter().all(|node| node.id != "native_process_9000011"));
        assert!(nodes.iter().all(|node| !node.metadata.contains_key("args")));
        assert_no_raw_secrets(&nodes, &["dockermap-daemon"]);
    }

    #[test]
    fn parses_long_usernames_from_ps_user_column() {
        // `ps -eo user=,` truncates usernames at 8 chars and appends '+'; the
        // providers use `user:32=` so full usernames must survive the parser.
        let records = parse_ps_table(
            "  4242  systemd-resolve  systemd-resolve  /usr/lib/systemd/systemd-resolved",
        );
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].pid, 4242);
        assert_eq!(records[0].user, "systemd-resolve");
        assert_eq!(records[0].comm, "systemd-resolve");
        assert_eq!(records[0].args, "/usr/lib/systemd/systemd-resolved");

        // A padded 32-char column (as `ps` actually emits) parses identically.
        let padded = format!(
            "  4242  {:<32}  systemd-resolve  /usr/lib/systemd/systemd-resolved",
            "systemd-resolve"
        );
        let records = parse_ps_table(&padded);
        assert_eq!(records[0].user, "systemd-resolve");
        assert_eq!(records[0].comm, "systemd-resolve");
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
        // Wrapper options that consume the next token must not surface their
        // argument as the executable (`sudo -u www-data ...` → "www-data").
        assert_eq!(
            process_comm("sudo -u www-data /usr/bin/python3 /srv/x.py").as_deref(),
            Some("python3")
        );
        assert_eq!(
            process_comm("env -u SECRET /usr/bin/python3 /srv/x.py").as_deref(),
            Some("python3")
        );
        assert_eq!(
            process_comm("timeout -s TERM 300 /usr/sbin/nginx").as_deref(),
            Some("nginx")
        );
        // Container init wrappers resolve to the wrapped command too.
        assert_eq!(
            process_comm("dumb-init -- /usr/local/bin/python -u /app/flaresolverr.py").as_deref(),
            Some("python")
        );
        assert_eq!(
            process_comm("tini -- /usr/sbin/nginx -g daemon off;").as_deref(),
            Some("nginx")
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
        // Wrapper options that consume the next token never surface their
        // argument as the executable, so python stays python-owned.
        assert!(!is_native_process(
            "sudo -u www-data /usr/bin/python3 /srv/x.py"
        ));
        assert!(!is_native_process(
            "env -u SECRET /usr/bin/python3 /srv/x.py"
        ));
        assert!(is_native_process("timeout -s TERM 300 /usr/sbin/nginx"));
        // Container init wrappers resolve like any other wrapper: python is
        // python-owned, nginx is native.
        assert!(!is_native_process(
            "dumb-init -- /usr/local/bin/python -u /app/flaresolverr.py"
        ));
        assert!(is_native_process("tini -- /usr/sbin/nginx -g daemon off;"));
        assert!(!is_python_process("tini -- /usr/sbin/nginx -g daemon off;"));
    }

    #[test]
    fn wrapper_option_arguments_are_wrapper_aware() {
        // `sudo -s` (run shell) and `sudo -k` (invalidate timestamp) consume
        // NO argument, so the next token is the wrapped command — previously
        // the wrapper-blind -s/-k skip list consumed it, the process
        // resolved to None, and it was silently dropped from BOTH providers.
        assert_eq!(process_comm("sudo -s nginx").as_deref(), Some("nginx"));
        assert_eq!(process_comm("sudo -k nginx").as_deref(), Some("nginx"));
        assert!(is_native_process("sudo -s nginx"));
        assert!(is_native_process("sudo -k nginx"));
        // `sudo -s` wrapping an interpreter still resolves to the
        // interpreter: python-owned, never native.
        assert!(is_python_process("sudo -s /usr/bin/python3 /srv/x.py"));
        assert!(!is_native_process("sudo -s /usr/bin/python3 /srv/x.py"));
        // `env -C`/`--chdir` consume their argument — without that the
        // directory was resolved as the executable and the wrapped python
        // process was misclassified native.
        assert_eq!(
            process_comm("env -C /srv python3 /srv/x.py").as_deref(),
            Some("python3")
        );
        assert_eq!(
            process_comm("env --chdir /srv python3 /srv/x.py").as_deref(),
            Some("python3")
        );
        // `env -S`/`--split-string` are NOT option-argument tokens: the
        // split-string is the REMAINDER of the command line, not a single
        // next token, so a one-token skip would swallow the wrapped command
        // (`env -S python3 ...` resolved to None and vanished from BOTH
        // providers; `env -S python3 -m http.server` resolved to
        // `http.server` and was misclassified native). The wrapped command
        // is reached directly — the common `-S FOO=bar` form still resolves
        // via the NAME=VALUE skip.
        assert_eq!(
            process_comm("env -S python3 /srv/x.py").as_deref(),
            Some("python3")
        );
        assert!(is_python_process("env -S python3"));
        assert!(!is_native_process("env -S python3"));
        assert!(is_python_process("env --split-string python3 -O /srv/x.py"));
        assert!(!is_native_process(
            "env --split-string python3 -O /srv/x.py"
        ));
        assert_eq!(
            process_comm("env -S FOO=bar python3 /srv/x.py").as_deref(),
            Some("python3")
        );
        assert!(is_python_process("env -C /srv python3 /srv/x.py"));
        assert!(!is_native_process("env -C /srv python3 /srv/x.py"));
        // timeout -s/-k still consume their argument (unchanged behavior).
        assert_eq!(
            process_comm("timeout -k 5s -s TERM 300 /usr/sbin/nginx").as_deref(),
            Some("nginx")
        );
        assert!(is_native_process("timeout -s TERM 300 /usr/sbin/nginx"));
    }

    #[test]
    fn real_comm_falls_back_for_unreadable_proc_entry() {
        // 9_000_000-style pids are beyond pid_max (4_194_304) on any Linux
        // host, so /proc/<pid>/comm cannot exist — the ps comm fallback must
        // win, and an empty fallback resolves to "unknown" (never argv).
        assert_eq!(real_comm(9_000_000, "nginx"), "nginx");
        assert_eq!(real_comm(9_000_000, "sleep"), "sleep");
        assert_eq!(real_comm(9_000_000, ""), "unknown");
    }

    #[test]
    fn native_comm_control_characters_never_reach_the_label() {
        // Kernel comm strings are process-controlled. C0, DEL, and C1 controls
        // must never become label or comm metadata. The fake pid forces the
        // ps-comm fallback path used by native node construction.
        for comm in ["x\n1  root  evil", "evil\u{7f}del", "evil\u{80}ctrl"] {
            let label = real_comm(9_000_000, comm);
            assert_eq!(label, "unknown");
            assert!(!label.chars().any(char::is_control));
            assert!(!label.contains("evil"));
        }
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
    fn native_label_uses_ps_comm_never_argv_zero() {
        // `exec -a hunter2 /usr/bin/sleep` rewrites argv[0] but not the
        // kernel comm: the label must come from the ps comm column ("sleep"),
        // never from the args column — a credential hidden in argv[0] would
        // otherwise be published as label + comm metadata.
        let table = "  9000100  root       sleep      hunter2 --sleep-forever\n";
        let (nodes, capped) = native_process_nodes_from_ps_output(table, 9_000_000);
        assert!(!capped);
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].id, "native_process_9000100");
        assert_eq!(nodes[0].label, "sleep");
        assert_eq!(
            nodes[0].metadata.get("comm").map(String::as_str),
            Some("sleep")
        );
        assert!(!nodes[0].label.contains("hunter2"));
        assert!(nodes[0]
            .metadata
            .values()
            .all(|value| !value.contains("hunter2")));
    }

    #[test]
    fn restricted_pid_namespace_requires_explicit_container_evidence() {
        // Ordinary systemd services and user managers have non-root cgroups,
        // but they are host processes and must not trigger a container warning.
        assert!(!restricted_pid_namespace_evidence(
            Some("systemd"),
            "0::/system.slice/hermes.service\n",
            false,
            false,
        ));
        assert!(!restricted_pid_namespace_evidence(
            Some("init"),
            "0::/user.slice/user-1000.slice/user@1000.service\n",
            false,
            false,
        ));

        assert!(restricted_pid_namespace_evidence(
            Some("systemd"),
            "0::/\n",
            true,
            false,
        ));
        assert!(restricted_pid_namespace_evidence(
            Some("systemd"),
            "0::/\n",
            false,
            true,
        ));
        assert!(restricted_pid_namespace_evidence(
            Some("systemd"),
            "0::/system.slice/docker-abc123def456.scope\n",
            false,
            false,
        ));
        assert!(!restricted_pid_namespace_evidence(
            Some("entrypoint.sh"),
            "0::/\n",
            false,
            false,
        ));
    }

    #[test]
    fn cgroup_implies_container_classifies_known_paths() {
        // Docker: systemd-scope path (cgroup v2) and /docker/<id> (v1).
        assert!(cgroup_implies_container(
            "0::/system.slice/docker-abc123.scope/init.scope"
        ));
        assert!(cgroup_implies_container("11:devices:/docker/abc123def456"));
        // libpod (podman) and kubepods (Kubernetes) use recognizable scopes.
        assert!(cgroup_implies_container(
            "0::/machine.slice/libpod-abc123.scope/container"
        ));
        assert!(cgroup_implies_container(
            "0::/kubepods.slice/kubepods-besteffort.slice/..."
        ));
        // Host cgroups and host container runtimes are not container-owned.
        assert!(!cgroup_implies_container("0::/system.slice/docker.service"));
        assert!(!cgroup_implies_container(
            "0::/system.slice/containerd.service"
        ));
        assert!(!cgroup_implies_container("0::/system.slice/"));
        assert!(!cgroup_implies_container("0::/init.scope"));
        assert!(!cgroup_implies_container(""));
        assert!(!cgroup_implies_container(
            "0::/user.slice/user-1000.slice/..."
        ));
    }

    #[test]
    fn restricted_namespace_omits_native_nodes_but_host_collection_remains_available() {
        let mut omitted_nodes = Vec::new();
        let mut omitted_diagnostics = Vec::new();
        let mut ps_shim = Command::new("sh");
        ps_shim.args([
            "-c",
            "printf ' 9300000  root  worker  /usr/bin/worker --once'",
        ]);

        collect_native_processes_with_command(
            ps_shim,
            true,
            &mut omitted_nodes,
            &mut omitted_diagnostics,
        );

        assert!(omitted_nodes.is_empty());
        assert!(omitted_diagnostics.iter().any(|diagnostic| {
            diagnostic.provider == RuntimeProviderKind::Process
                && diagnostic.severity == DiagnosticSeverity::Info
                && diagnostic.message
                    == "Native process discovery omitted because the daemon runs in a restricted PID namespace; only the container's own processes would be visible"
        }));

        let mut host_nodes = Vec::new();
        let mut host_diagnostics = Vec::new();
        let mut ps_shim = Command::new("sh");
        ps_shim.args([
            "-c",
            "printf ' 9300000  root  worker  /usr/bin/worker --once'",
        ]);
        collect_native_processes_with_command(
            ps_shim,
            false,
            &mut host_nodes,
            &mut host_diagnostics,
        );

        assert_eq!(host_nodes.len(), 1);
        assert_eq!(host_nodes[0].id, "native_process_9300000");
        assert!(host_diagnostics.is_empty());
    }

    #[test]
    fn nonzero_ps_shim_exit_reports_safe_warning_for_both_process_providers() {
        let failing_ps_shim = || {
            let mut command = Command::new("sh");
            command.args([
                "-c",
                "printf 'ps-provider-output-must-not-leak' >&2; exit 7",
            ]);
            command
        };
        let mut python_nodes = Vec::new();
        let mut python_diagnostics = Vec::new();
        collect_python_processes_with_command(
            failing_ps_shim(),
            &mut python_nodes,
            &mut python_diagnostics,
        );
        let mut native_nodes = Vec::new();
        let mut native_diagnostics = Vec::new();
        collect_native_processes_with_command(
            failing_ps_shim(),
            false,
            &mut native_nodes,
            &mut native_diagnostics,
        );

        assert!(python_nodes.is_empty());
        assert!(native_nodes.is_empty());
        assert!(python_diagnostics.iter().any(|diagnostic| {
            diagnostic.provider == RuntimeProviderKind::Python
                && diagnostic.severity == DiagnosticSeverity::Warning
                && diagnostic.message == "Python process discovery command failed"
        }));
        assert!(native_diagnostics.iter().any(|diagnostic| {
            diagnostic.provider == RuntimeProviderKind::Process
                && diagnostic.severity == DiagnosticSeverity::Warning
                && diagnostic.message == "Native process discovery command failed"
        }));
        assert!(python_diagnostics
            .iter()
            .chain(&native_diagnostics)
            .all(|diagnostic| !diagnostic
                .message
                .contains("ps-provider-output-must-not-leak")));
    }

    #[test]
    fn native_process_cap_is_reported_and_bounded() {
        // Pids beyond pid_max (4_194_304) are unreadable, so is_container_owned
        // keeps them as host processes and the count is deterministic in any
        // environment (containerized CI included).
        let mut table = String::new();
        for pid in 9_000_000..9_000_300 {
            table.push_str(&format!(
                "{pid:>7}  root  benchmark-{pid}  /usr/bin/benchmark-{pid}\n"
            ));
        }
        let (nodes, capped) = native_process_nodes_from_ps_output(&table, 9_000_500);
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
            Some("9000000")
        );
        assert_eq!(
            nodes
                .last()
                .unwrap()
                .metadata
                .get("pid")
                .map(String::as_str),
            Some((9_000_000 + MAX_NATIVE_PROCESSES - 1).to_string().as_str())
        );
    }

    #[test]
    fn provider_output_cap_drops_partial_process_row_and_reports_diagnostic() {
        let complete_line =
            "  9000000  root  benchmark  /usr/bin/benchmark --arg xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n";
        let mut source = Vec::new();
        while source.len() + complete_line.len() <= MAX_PROVIDER_OUTPUT_BYTES - 96 {
            source.extend_from_slice(complete_line.as_bytes());
        }
        source.extend_from_slice(
            b"  9000999  root  partial  /usr/bin/partial --arg this-tail-must-not-become-a-row",
        );
        source.extend_from_slice(&vec![b'x'; 300_000]);

        let read = read_bounded(std::io::Cursor::new(source), MAX_PROVIDER_OUTPUT_BYTES);
        assert!(read.truncated);
        assert_eq!(read.bytes.len(), MAX_PROVIDER_OUTPUT_BYTES);
        let complete = complete_provider_lines(&read.bytes, read.truncated);
        assert!(complete.len() < read.bytes.len());
        assert!(parse_ps_table(&String::from_utf8_lossy(complete))
            .iter()
            .all(|record| record.pid != 9_000_999));

        let mut nodes = Vec::new();
        let mut diagnostics = Vec::new();
        collect_native_processes_from_output(
            &read.bytes,
            read.truncated,
            9_000_500,
            &mut nodes,
            &mut diagnostics,
        );
        assert!(nodes.iter().all(|node| node.id != "native_process_9000999"));
        assert!(diagnostics.iter().any(|diagnostic| {
            diagnostic.provider == RuntimeProviderKind::Process
                && diagnostic.message
                    == format!(
                        "Provider output exceeded {MAX_PROVIDER_OUTPUT_BYTES} bytes; truncated"
                    )
        }));
    }

    #[test]
    fn complete_unterminated_ps_row_is_retained_when_output_is_not_truncated() {
        let table = b"  9300000  root  worker  /usr/bin/worker --once";
        let mut nodes = Vec::new();
        let mut diagnostics = Vec::new();

        collect_native_processes_from_output(table, false, 9_000_500, &mut nodes, &mut diagnostics);

        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].id, "native_process_9300000");
        assert!(diagnostics.is_empty());
    }

    #[test]
    fn python_process_cap_is_reported_and_bounded() {
        let mut table = String::new();
        for pid in 9_000_000..(9_000_000 + MAX_PYTHON_PROCESSES as u32 + 1) {
            table.push_str(&format!(
                "{pid:>7}  root  python3  /usr/bin/python3 /srv/app-{pid}.py\n"
            ));
        }

        let mut nodes = Vec::new();
        let mut diagnostics = Vec::new();
        collect_python_processes_from_output(table.as_bytes(), false, &mut nodes, &mut diagnostics);
        assert_eq!(nodes.len(), MAX_PYTHON_PROCESSES);
        assert!(diagnostics.iter().any(|diagnostic| {
            diagnostic.provider == RuntimeProviderKind::Python
                && diagnostic.message
                    == format!(
                        "Python process discovery capped at {MAX_PYTHON_PROCESSES} processes"
                    )
        }));
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
        collect_npm_projects(
            &project_root,
            PidNamespaceScope::Host { diagnostic: None },
            &mut nodes,
            &mut edges,
            &mut diagnostics,
        );
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
        assert!(error.to_string().contains("timed out"), "{error}");
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
        collect_npm_projects(
            &project_root,
            PidNamespaceScope::Host { diagnostic: None },
            &mut nodes,
            &mut edges,
            &mut diagnostics,
        );

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
    fn redacts_compose_environment_keys_and_reports_normalization_collisions() {
        let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/providers/redaction");
        let file = project_root.join("compose-environment.yaml");
        let mut scan =
            scan_compose_files(&project_root, std::slice::from_ref(&file)).expect("fixture scans");
        let environment = &mut scan.services[0].environment;
        environment.insert(
            "DOCKERMAP_TEST_FAKE_SOL5_VALID_ENV_KEY".into(),
            "safe".into(),
        );
        environment.insert("bidi\u{202e}control\u{001b}key".into(), "safe".into());
        environment.insert("collision\u{200b}".into(), "first".into());
        environment.insert("collision\u{202e}".into(), "second".into());

        redact_compose_scan(&mut scan);

        let serialized = serde_json::to_string(&scan).expect("scan should serialize");
        assert!(!serialized.contains("DOCKERMAP_TEST_FAKE_SOL5_VALID_ENV_KEY"));
        assert!(!serialized.contains('\u{202e}'));
        assert!(!serialized.contains('\u{001b}'));
        let environment = &scan.services[0].environment;
        assert_eq!(
            environment
                .keys()
                .filter(|key| key.as_str() == "collision�")
                .count(),
            1,
            "normalization collisions retain one deterministic published key"
        );
        assert!(scan
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.id == "compose_environment_key_collision"));
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

    #[test]
    fn runtime_display_redaction_neutralizes_unicode_spoofing_in_process_comm_and_user_metadata() {
        // C0/DEL/C1, bidi controls, default-ignorables, separators, and
        // noncharacters are all operator-facing spoofing vectors. They must
        // be neutralized at the shared runtime publication boundary, not by
        // individual provider parsers.
        let unsafe_display = |value: &str| {
            value.chars().any(|character| {
                let code = character as u32;
                character.is_control()
                    || (0x200B..=0x200F).contains(&code)
                    || (0x2028..=0x202E).contains(&code)
                    || (0x2060..=0x2069).contains(&code)
                    || code == 0xFEFF
                    || (0xFDD0..=0xFDEF).contains(&code)
                    || matches!(code & 0xFFFF, 0xFFFE | 0xFFFF)
            })
        };
        let table = concat!(
            " 9000000  user\u{001b}\u{007f}\u{0080}  evil\u{202e}\u{200b}  /usr/bin/evil\n",
            " 9000001  user\u{001b}\u{007f}\u{0080}  python3  /srv/app\u{202e}\u{200b}.py\n"
        );
        let (mut native_nodes, _) = native_process_nodes_from_ps_output(table, 9_000_500);
        let (mut python_nodes, _) = python_nodes_from_ps_output(table);
        native_nodes.append(&mut python_nodes);

        redact_runtime_nodes(&mut native_nodes);

        assert_eq!(native_nodes.len(), 2);
        for node in native_nodes {
            assert!(!unsafe_display(&node.label), "unsafe label: {}", node.label);
            assert!(node.metadata.values().all(|value| !unsafe_display(value)));
        }
    }

    #[test]
    fn unavailable_ps_reports_static_warning_for_both_process_providers() {
        let unavailable_ps = || Command::new("/definitely-not-a-dockermap-ps-command");
        let mut python_nodes = Vec::new();
        let mut python_diagnostics = Vec::new();
        collect_python_processes_with_command(
            unavailable_ps(),
            &mut python_nodes,
            &mut python_diagnostics,
        );
        let mut native_nodes = Vec::new();
        let mut native_diagnostics = Vec::new();
        collect_native_processes_with_command(
            unavailable_ps(),
            false,
            &mut native_nodes,
            &mut native_diagnostics,
        );

        assert!(python_nodes.is_empty());
        assert!(native_nodes.is_empty());
        assert!(python_diagnostics.iter().any(|diagnostic| {
            diagnostic.provider == RuntimeProviderKind::Python
                && diagnostic.severity == DiagnosticSeverity::Warning
                && diagnostic.message == "Python process discovery command unavailable"
        }));
        assert!(native_diagnostics.iter().any(|diagnostic| {
            diagnostic.provider == RuntimeProviderKind::Process
                && diagnostic.severity == DiagnosticSeverity::Warning
                && diagnostic.message == "Native process discovery command unavailable"
        }));
    }

    #[test]
    fn pid_namespace_modes_require_affirmative_evidence_and_surface_ambiguity() {
        let runit = pid_namespace_scope_from_evidence(
            PidNamespaceMode::Auto,
            Some("runit"),
            "0::/\n",
            false,
            false,
            false,
        );
        assert_eq!(runit, PidNamespaceScope::Restricted);
        assert_eq!(
            pid_namespace_scope_from_evidence(
                PidNamespaceMode::Auto,
                Some("systemd"),
                "0::/\n",
                true,
                false,
                false,
            ),
            PidNamespaceScope::Restricted,
            "/.dockerenv is affirmative restricted evidence"
        );
        assert_eq!(
            pid_namespace_scope_from_evidence(
                PidNamespaceMode::Auto,
                Some("systemd"),
                "0::/\n",
                false,
                false,
                true,
            ),
            PidNamespaceScope::Restricted,
            "/run/.containerenv is affirmative Podman evidence"
        );
        assert_eq!(
            pid_namespace_scope_from_evidence(
                PidNamespaceMode::Restricted,
                Some("systemd"),
                "0::/\n",
                false,
                false,
                false,
            ),
            PidNamespaceScope::Restricted,
            "the explicit compose override wins over ambiguous auto evidence"
        );
        assert_eq!(
            pid_namespace_scope_from_evidence(
                PidNamespaceMode::Host,
                Some("entrypoint"),
                "0::/system.slice/docker-abc.scope\n",
                true,
                true,
                true,
            ),
            PidNamespaceScope::Host { diagnostic: None },
            "explicit host mode always collects host providers"
        );
        assert_eq!(
            PidNamespaceMode::from_env_value(None),
            PidNamespaceMode::Auto
        );
        assert_eq!(
            PidNamespaceMode::from_env_value(Some("restricted")),
            PidNamespaceMode::Restricted
        );
        assert_eq!(
            PidNamespaceMode::from_env_value(Some("unexpected")),
            PidNamespaceMode::Restricted,
            "invalid namespace configuration must not enable host collection"
        );
    }

    #[test]
    fn python_container_cgroup_rows_are_filtered_before_the_process_cap() {
        let cgroup = "0::/system.slice/docker-abc123def456.scope\n";
        assert!(cgroup_implies_container(cgroup));
        let table = concat!(
            " 9000000  root  python3  /usr/bin/python3 /container/app.py\n",
            " 9000001  root  python3  /usr/bin/python3 /host/app.py\n"
        );
        let (nodes, capped) = python_nodes_from_ps_output_with_container_filter(table, |pid| {
            pid == 9_000_000 && cgroup.lines().any(cgroup_implies_container)
        });
        assert!(!capped);
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].id, "python_process_9000001");
    }

    #[test]
    fn restricted_namespace_omits_host_scoped_collectors_and_python() {
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        let mut diagnostics = Vec::new();
        collect_host_scoped_runtime_providers(
            PidNamespaceScope::Restricted,
            &mut nodes,
            &mut edges,
            &mut diagnostics,
        );
        let mut python_command = Command::new("sh");
        python_command
            .arg("-c")
            .arg("printf ' 9000000 root python3 python3 /app.py'");
        collect_python_processes_with_command_in_scope(
            python_command,
            true,
            &mut nodes,
            &mut diagnostics,
        );

        assert!(nodes.is_empty());
        assert!(edges.is_empty());
        for provider in [
            RuntimeProviderKind::Network,
            RuntimeProviderKind::Systemd,
            RuntimeProviderKind::ScheduledJob,
            RuntimeProviderKind::Pm2,
            RuntimeProviderKind::Tmux,
            RuntimeProviderKind::Python,
        ] {
            assert!(diagnostics
                .iter()
                .any(|diagnostic| diagnostic.provider == provider));
        }
    }

    #[test]
    fn provider_diagnostics_are_redacted_before_stderr_and_api_storage() {
        let sentinel = "DOCKERMAP_TEST_FAKE_STDERR_SECRET";
        let mut diagnostics = Vec::new();
        push_provider_diagnostic(
            &mut diagnostics,
            RuntimeProviderKind::Npm,
            DiagnosticSeverity::Warning,
            format!("npm discovery failed at /tmp/{sentinel}/package.json"),
        );
        let api_message = &diagnostics[0].message;
        let mut captured_stderr = Vec::new();
        write_provider_diagnostic(
            &mut captured_stderr,
            &RuntimeProviderKind::Npm,
            &DiagnosticSeverity::Warning,
            api_message,
        )
        .expect("test stderr capture should accept a diagnostic");
        let captured_stderr = String::from_utf8(captured_stderr).expect("stderr is utf-8");

        assert_eq!(api_message, REDACTED_VALUE);
        assert!(!api_message.contains(sentinel));
        assert!(!captured_stderr.contains(sentinel));
        assert!(captured_stderr.contains(REDACTED_VALUE));
    }

    #[test]
    fn runtime_collection_guard_prevents_two_rapid_refreshes() {
        let in_flight = Arc::new(AtomicBool::new(false));
        let first = RuntimeCollectionGuard::acquire(in_flight.clone())
            .expect("first refresh starts one collection");
        assert!(
            RuntimeCollectionGuard::acquire(in_flight.clone()).is_none(),
            "a second refresh must skip while the first blocking collection remains in flight"
        );
        drop(first);
        assert!(
            RuntimeCollectionGuard::acquire(in_flight).is_some(),
            "the next refresh may run after the original collection finishes"
        );
    }

    #[test]
    fn publishes_live_and_mock_logs_through_the_shared_sanitizer_before_paging() {
        let sentinel = "DOCKERMAP_TEST_FAKE_LIVE_LOG_SECRET";
        let live = publish_log_response(
            Some("service\u{202e}name"),
            vec![LogEntry {
                id: "live\u{202e}id".into(),
                timestamp: 1,
                container: "container\u{202e}name".into(),
                level: dockermap_core::LogLevel::Info,
                message: format!("token={sentinel}"),
            }],
            Some("redacted"),
            None,
            10,
        );
        let live_json = serde_json::to_string(&live).expect("response should serialize");
        assert!(!live_json.contains(sentinel));
        assert!(!live_json.contains('\u{202e}'));
        assert_eq!(live.entries.len(), 1, "filtering sees the redacted message");
        assert_eq!(live.service.as_deref(), Some("service�name"));

        let mut snapshot = mock_snapshot();
        snapshot.containers[0].role = format!("token={sentinel}");
        let mock = publish_log_response(
            None,
            mock_log_entries(&snapshot, None),
            Some("redacted"),
            None,
            MAX_LOG_PAGE_SIZE,
        );
        let mock_json = serde_json::to_string(&mock).expect("response should serialize");
        assert!(!mock_json.contains(sentinel));
        assert!(
            mock.entries
                .iter()
                .any(|entry| entry.message == REDACTED_VALUE),
            "mock messages are redacted before filtering"
        );

        let raw_secret_query = publish_log_response(
            None,
            mock_log_entries(&snapshot, None),
            Some(sentinel),
            None,
            MAX_LOG_PAGE_SIZE,
        );
        assert!(
            raw_secret_query.entries.is_empty(),
            "a raw secret must not influence observable mock filtering"
        );
    }

    #[test]
    fn restricted_namespace_skips_tailnet_and_filesystem_marker_collectors() {
        let mut snapshot = mock_snapshot();
        snapshot.containers.clear();
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        let mut diagnostics = Vec::new();

        collect_network_infrastructure(
            PidNamespaceScope::Restricted,
            &snapshot,
            &mut nodes,
            &mut edges,
            &mut diagnostics,
        );

        assert!(nodes
            .iter()
            .all(|node| node.kind != RuntimeNodeKind::TailnetNode));
        assert!(nodes
            .iter()
            .all(|node| !node.id.starts_with("reverse_proxy_config_")));
        for (provider, message) in [
            (
                RuntimeProviderKind::Tailscale,
                "Tailscale discovery skipped in restricted PID namespace",
            ),
            (
                RuntimeProviderKind::Headscale,
                "Headscale discovery skipped in restricted PID namespace",
            ),
            (
                RuntimeProviderKind::ReverseProxy,
                "Reverse-proxy configuration marker discovery skipped in restricted PID namespace",
            ),
            (
                RuntimeProviderKind::LocalDns,
                "Local DNS configuration marker discovery skipped in restricted PID namespace",
            ),
        ] {
            assert!(diagnostics.iter().any(|diagnostic| {
                diagnostic.provider == provider
                    && diagnostic.severity == DiagnosticSeverity::Info
                    && diagnostic.message == message
            }));
        }
    }

    #[test]
    fn runtime_graph_edges_resolve_in_host_and_restricted_namespaces() {
        let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/providers/redaction");
        let snapshot = mock_snapshot();

        for scope in [
            PidNamespaceScope::Host { diagnostic: None },
            PidNamespaceScope::Restricted,
        ] {
            let mut nodes = Vec::new();
            let mut edges = Vec::new();
            let mut diagnostics = Vec::new();
            if !scope.is_restricted() {
                collect_host_node(None, &mut nodes);
            }
            collect_npm_projects(
                &project_root,
                scope,
                &mut nodes,
                &mut edges,
                &mut diagnostics,
            );
            let mut map = derive_runtime_map(&snapshot, nodes, edges, diagnostics);
            redact_runtime_map(&mut map);
            let ids = map
                .nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<HashSet<_>>();
            assert!(map.edges.iter().all(|edge| {
                ids.contains(edge.source.as_str()) && ids.contains(edge.target.as_str())
            }));
            if scope.is_restricted() {
                assert!(map.nodes.iter().all(|node| node.id != "host_local"));
                assert!(map.edges.iter().all(|edge| {
                    !(edge.relationship == RuntimeRelationshipKind::RunsOn
                        && edge.target == "host_local")
                }));
            }
        }
    }

    #[test]
    fn runtime_id_components_keep_raw_identity_variants_distinct() {
        let identities = [
            "sol-r4-a-b",
            "sol-r4-a_b",
            "SOL-R4-A",
            "sol-r4-a",
            "bidi\u{202e}value",
            "bidi\u{202d}value",
            "/srv/sol-r4-a-b",
            "/srv/sol-r4-a_b",
            "@scope/sol-r4-a-b",
            "@scope_sol-r4-a-b",
        ];
        let generated = identities
            .iter()
            .map(|identity| safe_runtime_id_component(identity, "fallback"))
            .collect::<HashSet<_>>();
        assert_eq!(
            generated.len(),
            identities.len(),
            "runtime and package IDs must include a raw-identity hash suffix"
        );
    }

    #[test]
    fn runtime_map_publication_normalizes_all_ids_and_keeps_edges_consistent() {
        let unsafe_id = "node\u{202e}id";
        let unsafe_package_id = "package\u{202e}id";
        let mut service =
            RuntimeServiceEntity::minimal("service".into(), RuntimeServiceStatus::Running);
        service.logs.push(RuntimeLogRef {
            id: "log\u{202e}id".into(),
            source: "source".into(),
            level: Some(RuntimeLogLevel::Info),
        });
        service.events.push(RuntimeEventRef {
            id: "event\u{202e}id".into(),
            kind: "event".into(),
            timestamp: None,
            message: None,
        });
        service.owner = Some(RuntimeOwnership {
            kind: RuntimeOwnershipKind::Person,
            name: "owner".into(),
            id: Some("owner\u{202e}id".into()),
        });
        let mut package = RuntimePackageEntity::minimal("package".into(), "1.0.0".into());
        package.update = Some(RuntimePackageUpdate {
            current_version: "1.0.0".into(),
            latest_version: None,
            available: true,
            advisories: vec![RuntimePackageAdvisory {
                id: "advisory\u{202e}id".into(),
                source: "source".into(),
                title: "title".into(),
                severity: RuntimeAdvisorySeverity::Low,
                fixed_version: None,
                url: None,
                published_at: None,
            }],
        });
        let node = RuntimeMapNode {
            id: unsafe_id.into(),
            provider: RuntimeProviderKind::Other,
            kind: RuntimeNodeKind::Service,
            label: "node".into(),
            status: None,
            layer: None,
            metadata: BTreeMap::new(),
            service: Some(service),
            package: None,
        };
        let duplicate_after_normalization = RuntimeMapNode {
            id: "node\u{202d}id".into(),
            ..node.clone()
        };
        let package_node = RuntimeMapNode {
            id: unsafe_package_id.into(),
            provider: RuntimeProviderKind::Npm,
            kind: RuntimeNodeKind::PackageDependency,
            label: "package".into(),
            status: None,
            layer: None,
            metadata: BTreeMap::new(),
            service: None,
            package: Some(package),
        };
        let edge = RuntimeMapEdge {
            source: unsafe_id.into(),
            target: unsafe_package_id.into(),
            relationship: RuntimeRelationshipKind::DependsOn,
            metadata: BTreeMap::new(),
        };
        let mut map = RuntimeMap {
            nodes: vec![node, duplicate_after_normalization, package_node],
            edges: vec![edge.clone(), edge],
            diagnostics: Vec::new(),
            last_updated: 0,
            ..Default::default()
        };

        redact_runtime_map(&mut map);

        let ids = map
            .nodes
            .iter()
            .map(|node| node.id.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(map.nodes.len(), 3, "normalized node IDs remain visible");
        assert!(
            map.diagnostics.iter().any(|diagnostic| diagnostic
                .message
                .contains("records remain visible and non-routable")),
            "a publication-time collision must be surfaced without discarding either node"
        );
        assert_eq!(
            map.edges.len(),
            1,
            "normalized equivalent edges are deduplicated"
        );
        assert!(map.edges.iter().all(|edge| {
            ids.contains(edge.source.as_str()) && ids.contains(edge.target.as_str())
        }));
        let service = map
            .nodes
            .iter()
            .find_map(|node| node.service.as_ref())
            .expect("service node remains");
        assert_eq!(service.logs[0].id, "log�id");
        assert_eq!(service.events[0].id, "event�id");
        assert_eq!(
            service.owner.as_ref().and_then(|owner| owner.id.as_deref()),
            Some("owner�id")
        );
        let advisory = map
            .nodes
            .iter()
            .find_map(|node| node.package.as_ref())
            .and_then(|package| package.update.as_ref())
            .and_then(|update| update.advisories.first())
            .expect("package advisory remains");
        assert_eq!(advisory.id, "advisory�id");
    }

    #[test]
    fn compose_publication_normalizes_diagnostics_and_graph_inputs() {
        let mut scan = ComposeScan {
            files: vec!["/project\u{202e}/compose.yaml".into()],
            project_root: "/project\u{202e}".into(),
            services: Vec::new(),
            mounts: vec![ComposeMount {
                id: "mount\u{202e}id".into(),
                service: "service\u{202e}name".into(),
                kind: ComposeMountKind::Bind,
                source: Some("/host\u{202e}/source".into()),
                resolved_source: Some("/host\u{202e}/source".into()),
                target: "/container\u{202e}/target".into(),
                read_only: false,
                origin: ComposeFileOrigin {
                    file: "/project\u{202e}/compose.yaml".into(),
                    service: Some("service\u{202e}name".into()),
                    field: "services\u{202e}.volumes".into(),
                },
            }],
            correlations: Vec::new(),
            diagnostics: vec![ComposeDiagnostic {
                id: "diagnostic\u{202e}id".into(),
                severity: DiagnosticSeverity::Warning,
                message: "message\u{202e}text".into(),
                origin: ComposeFileOrigin {
                    file: "/project\u{202e}/compose.yaml".into(),
                    service: Some("service\u{202e}name".into()),
                    field: "services\u{202e}.volumes".into(),
                },
            }],
        };

        redact_compose_scan(&mut scan);
        let graph = derive_compose_graph(&scan);
        let scan_json = serde_json::to_string(&scan).expect("scan should serialize");
        let graph_json = serde_json::to_string(&graph).expect("graph should serialize");
        assert!(!scan_json.contains('\u{202e}'));
        assert!(!graph_json.contains('\u{202e}'));
        assert_eq!(scan.diagnostics[0].id, "diagnostic�id");
        assert_eq!(scan.diagnostics[0].origin.file, "/project�/compose.yaml");
        assert_eq!(
            scan.diagnostics[0].origin.service.as_deref(),
            Some("service�name")
        );
        assert_eq!(scan.diagnostics[0].origin.field, "services�.volumes");
    }

    #[test]
    fn publication_helpers_redact_and_normalize_compose_inventory_and_health() {
        let sentinel = "DOCKERMAP_TEST_FAKE_PUBLICATION_SECRET";
        let hostile = format!("token={sentinel}\u{202e}\u{200b}\u{001b}\u{2028}\u{fdd0}");
        let mut plan = ComposeEditPlan {
            file: hostile.clone(),
            service: hostile.clone(),
            mount_id: hostile.clone(),
            original_source: Some(hostile.clone()),
            original_target: hostile.clone(),
            new_source: Some(hostile.clone()),
            new_target: Some(hostile.clone()),
            unified_diff: format!(
                "--- {hostile}\n+++ {hostile}\n- token={sentinel}\n+ token={sentinel}"
            ),
            diagnostics: vec![ComposeDiagnostic {
                id: hostile.clone(),
                severity: DiagnosticSeverity::Warning,
                message: hostile.clone(),
                origin: ComposeFileOrigin {
                    file: hostile.clone(),
                    service: Some(hostile.clone()),
                    field: hostile.clone(),
                },
            }],
            will_write: false,
        };
        redact_compose_edit_plan(&mut plan);

        let mut snapshot = mock_snapshot();
        snapshot.containers[0].id = hostile.clone();
        snapshot.containers[0].name = hostile.clone();
        snapshot.containers[0].image = hostile.clone();
        snapshot.containers[0].status = hostile.clone();
        snapshot.containers[0].role = hostile.clone();
        snapshot.containers[0].networks = vec![hostile.clone()];
        snapshot.containers[0].ports = vec![hostile.clone()];
        snapshot.containers[0].mounts = vec![ContainerMount {
            id: hostile.clone(),
            kind: ComposeMountKind::Bind,
            source: Some(hostile.clone()),
            target: hostile.clone(),
            read_only: false,
        }];
        snapshot.containers[0].depends_on = vec![hostile.clone()];
        snapshot.images = vec![dockermap_core::ImageRecord {
            image: hostile.clone(),
            containers: vec![hostile.clone()],
            status: hostile.clone(),
        }];
        snapshot.networks = vec![NetworkRecord {
            id: hostile.clone(),
            name: hostile.clone(),
            driver: hostile.clone(),
            internal: false,
            members: vec![hostile.clone()],
        }];
        snapshot.volumes = vec![VolumeRecord {
            id: hostile.clone(),
            name: hostile.clone(),
            attached_to: vec![hostile.clone()],
        }];
        let published_snapshot = publish_docker_snapshot(&snapshot);
        assert!(
            snapshot.containers[0].name.contains(sentinel),
            "the internal cache must retain raw inventory identities for lookup"
        );

        let mut health = HealthResponse {
            status: HealthState::Degraded,
            mode: RuntimeMode::Mock,
            docker_reachable: false,
            last_updated: 1,
            snapshot_version: "1".into(),
            message: Some(hostile),
        };
        redact_health_response(&mut health);

        let serialized = serde_json::to_string(&(plan, published_snapshot, health))
            .expect("published values should serialize");
        assert!(!serialized.contains(sentinel));
        assert!(!serialized.chars().any(unsafe_runtime_display_character));
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
