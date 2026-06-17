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
    derive_compose_graph, derive_graph, derive_images, derive_runtime_map, discover_compose_files,
    mock_logs, mock_snapshot, plan_compose_mount_edit, scan_compose_files, unix_timestamp_millis,
    ComposeDiagnostic, ComposeEditPlan, ComposeGraph, ComposeScan, ContainerRecord,
    DiagnosticSeverity, DockerSnapshot, GraphResponse, HealthResponse, HealthState, LogEntry,
    LogsResponse, NetworkRecord, RuntimeMap, RuntimeMapDiagnostic, RuntimeMapEdge, RuntimeMapNode,
    RuntimeMode, RuntimeNodeKind, RuntimeProviderKind, RuntimeRelationshipKind, VolumeRecord,
};
use futures_util::stream::StreamExt;
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    net::{IpAddr, SocketAddr},
    path::{Component, Path as StdPath, PathBuf},
    process::Command,
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

fn collect_runtime_map(snapshot: &DockerSnapshot) -> RuntimeMap {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut diagnostics = Vec::new();

    collect_network_listeners(&mut nodes, &mut diagnostics);
    collect_network_infrastructure(snapshot, &mut nodes, &mut edges, &mut diagnostics);
    collect_systemd_services(&mut nodes, &mut diagnostics);
    collect_scheduled_jobs(&mut nodes, &mut diagnostics);
    collect_pm2_apps(&mut nodes, &mut diagnostics);
    collect_tmux_sessions(&mut nodes, &mut diagnostics);

    derive_runtime_map(snapshot, nodes, edges, diagnostics)
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
    let output = match Command::new("tailscale")
        .args(["status", "--json"])
        .output()
    {
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
        for (id, peer) in peers {
            push_tailnet_node(nodes, RuntimeProviderKind::Tailscale, id, peer);
        }
    }
}

fn collect_headscale(nodes: &mut Vec<RuntimeMapNode>, diagnostics: &mut Vec<RuntimeMapDiagnostic>) {
    let output = match Command::new("headscale")
        .args(["nodes", "list", "--output", "json"])
        .output()
    {
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

    for node in nodes_json {
        let id = node
            .get("id")
            .and_then(value_to_string_ref)
            .or_else(|| node.get("machineKey").and_then(value_to_string_ref))
            .unwrap_or_else(|| "headscale-node".into());
        push_tailnet_node(nodes, RuntimeProviderKind::Headscale, &id, &node);
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
        id: format!("{provider_id}_node_{}", sanitize_runtime_id(&label)),
        provider,
        kind: RuntimeNodeKind::TailnetNode,
        label,
        status: online.map(|value| if value { "online" } else { "offline" }.into()),
        metadata,
    });
}

fn collect_network_config_markers(nodes: &mut Vec<RuntimeMapNode>) {
    for marker in reverse_proxy_markers() {
        if path_exists(marker.path) {
            let mut metadata = BTreeMap::new();
            metadata.insert("source".into(), marker.path.into());
            metadata.insert("product".into(), marker.product.into());
            nodes.push(RuntimeMapNode {
                id: format!(
                    "reverse_proxy_config_{}_{}",
                    sanitize_runtime_id(marker.product),
                    sanitize_runtime_id(marker.path)
                ),
                provider: RuntimeProviderKind::ReverseProxy,
                kind: RuntimeNodeKind::ReverseProxy,
                label: marker.product.into(),
                status: Some("configured".into()),
                metadata,
            });
        }
    }

    for marker in local_dns_markers() {
        if path_exists(marker.path) {
            let mut metadata = BTreeMap::new();
            metadata.insert("source".into(), marker.path.into());
            metadata.insert("product".into(), marker.product.into());
            nodes.push(RuntimeMapNode {
                id: format!(
                    "local_dns_config_{}_{}",
                    sanitize_runtime_id(marker.product),
                    sanitize_runtime_id(marker.path)
                ),
                provider: RuntimeProviderKind::LocalDns,
                kind: RuntimeNodeKind::LocalDnsResolver,
                label: marker.product.into(),
                status: Some("configured".into()),
                metadata,
            });
        }
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
    nodes.push(RuntimeMapNode {
        id: id.clone(),
        provider,
        kind,
        label: format!("{product}: {}", container.name),
        status: Some(container.status.clone()),
        metadata,
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
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    let output = match Command::new("systemctl")
        .args([
            "list-units",
            "--type=service",
            "--all",
            "--no-legend",
            "--no-pager",
            "--plain",
        ])
        .output()
    {
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

    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let parts = line.split_whitespace().collect::<Vec<_>>();
        if parts.len() < 4 {
            continue;
        }
        let unit = parts[0];
        let active = parts[2];
        let sub = parts[3];
        let description = parts
            .get(4..)
            .map(|items| items.join(" "))
            .unwrap_or_default();
        let mut metadata = BTreeMap::new();
        metadata.insert("unit".into(), unit.into());
        metadata.insert("subState".into(), sub.into());
        if !description.is_empty() {
            metadata.insert("description".into(), description);
        }
        nodes.push(RuntimeMapNode {
            id: format!("systemd_service_{}", sanitize_runtime_id(unit)),
            provider: RuntimeProviderKind::Systemd,
            kind: RuntimeNodeKind::SystemdService,
            label: unit.trim_end_matches(".service").into(),
            status: Some(active.into()),
            metadata,
        });
    }
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

    match Command::new("crontab").arg("-l").output() {
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
        let mut metadata = BTreeMap::new();
        metadata.insert("source".into(), source.clone());
        metadata.insert("line".into(), line.to_string());
        metadata.insert("command".into(), command.clone());
        nodes.push(RuntimeMapNode {
            id: format!(
                "scheduled_job_{}_{}",
                sanitize_runtime_id(&source),
                sanitize_runtime_id(&format!("{line}_{command}"))
            ),
            provider: RuntimeProviderKind::ScheduledJob,
            kind: RuntimeNodeKind::ScheduledJob,
            label: command,
            status: Some("scheduled".into()),
            metadata,
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
    let output = match Command::new("pm2").arg("jlist").output() {
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
        nodes.push(RuntimeMapNode {
            id: format!("pm2_app_{}", sanitize_runtime_id(&id)),
            provider: RuntimeProviderKind::Pm2,
            kind: RuntimeNodeKind::Pm2App,
            label: name.into(),
            status,
            metadata,
        });
    }
}

fn collect_tmux_sessions(
    nodes: &mut Vec<RuntimeMapNode>,
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
) {
    let output = match Command::new("tmux")
        .args([
            "list-sessions",
            "-F",
            "#{session_id}\t#{session_name}\t#{session_attached}\t#{session_windows}",
        ])
        .output()
    {
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

    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let parts = line.split('\t').collect::<Vec<_>>();
        if parts.len() < 4 {
            continue;
        }
        let mut metadata = BTreeMap::new();
        metadata.insert("sessionId".into(), parts[0].into());
        metadata.insert("windows".into(), parts[3].into());
        nodes.push(RuntimeMapNode {
            id: format!("tmux_session_{}", sanitize_runtime_id(parts[0])),
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
            metadata,
        });
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
                metadata,
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

fn value_to_string_ref(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(value) => Some(value.clone()),
        serde_json::Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn push_provider_diagnostic(
    diagnostics: &mut Vec<RuntimeMapDiagnostic>,
    provider: RuntimeProviderKind,
    severity: DiagnosticSeverity,
    message: String,
) {
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
    let cache = state.cache.read().await;
    let snapshot = cache.snapshot.clone();
    drop(cache);

    Json(collect_runtime_map(&snapshot))
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
