//! Read-only network-infrastructure discovery.
//!
//! Filesystem discovery is limited to fixed marker paths and observes only
//! existence: configuration content is never opened. Container classifications
//! are derived exclusively from the already-collected Docker snapshot. The
//! caller supplies PID namespace scope so container-local marker files cannot
//! be published as host evidence.

use super::overlay_network::{collect_headscale, collect_tailscale, provider_opt_in};
use crate::pid_namespace::PidNamespaceScope;
use crate::{push_provider_diagnostic, safe_runtime_id_component};
use dockermap_core::{
    collision_resistant_id_component, service_entity_kind_name, ContainerRecord,
    DiagnosticSeverity, DockerSnapshot, RuntimeMapDiagnostic, RuntimeMapEdge, RuntimeMapNode,
    RuntimeNodeKind, RuntimeNodeLayer, RuntimeProviderKind, RuntimeRelationshipKind,
    RuntimeServiceEntity, RuntimeServiceStatus, ServiceEntityKind,
};
use std::{collections::BTreeMap, path::Path};

pub(crate) fn collect_network_infrastructure(
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
            "{id_prefix}_{}_{}",
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
    Path::new(path).exists()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::redact_runtime_nodes;
    use dockermap_core::mock_snapshot;

    fn assert_no_raw_secrets<T: serde::Serialize>(value: &T, secrets: &[&str]) {
        let rendered = serde_json::to_string(value).expect("test values serialize");
        for secret in secrets {
            assert!(
                !rendered.contains(secret),
                "published value leaked {secret}"
            );
        }
    }

    #[test]
    fn marker_nodes_never_open_or_publish_configuration_content() {
        let proxy_config =
            include_str!("../../../../tests/fixtures/providers/redaction/reverse-proxy-caddyfile");
        let dns_config =
            include_str!("../../../../tests/fixtures/providers/redaction/dns-adguard.yaml");
        assert!(proxy_config.contains("DOCKERMAP_TEST_FAKE_PROXY_AUTH"));
        assert!(dns_config.contains("DOCKERMAP_TEST_FAKE_DNS_URL_TOKEN"));
        let mut nodes = vec![
            network_marker_node(
                &NetworkMarker {
                    product: "Caddy",
                    path: "/etc/caddy/Caddyfile",
                },
                RuntimeProviderKind::ReverseProxy,
                RuntimeNodeKind::ReverseProxy,
                ServiceEntityKind::ReverseProxy,
                "reverse_proxy_config",
            ),
            network_marker_node(
                &NetworkMarker {
                    product: "AdGuard Home",
                    path: "/opt/adguardhome/conf/AdGuardHome.yaml",
                },
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
        assert!(nodes
            .iter()
            .all(|node| !node.id.starts_with("local_dns_config_")));
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
            assert!(diagnostics
                .iter()
                .any(|diagnostic| diagnostic.provider == provider
                    && diagnostic.severity == DiagnosticSeverity::Info
                    && diagnostic.message == message));
        }
    }
}
