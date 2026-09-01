//! Bounded orchestration for host-side runtime-map collection.
//!
//! This module owns provider ordering, PID-namespace fail-closed behavior,
//! and the single-flight timeout guard. Route/cache ownership remains in the
//! daemon entrypoint so collection cannot change publication semantics.

use crate::{
    config::project_root,
    pid_namespace::{daemon_pid_namespace_scope, PidNamespaceScope},
    provider_contract::{ProviderCollection, ProviderDiagnostic},
    providers::{
        cron::collect_scheduled_jobs,
        listeners::collect_network_listeners,
        network_infrastructure::collect_network_infrastructure,
        npm::collect_npm_projects,
        pm2::collect_pm2_apps,
        processes::{collect_native_processes_with_scope, collect_python_processes},
        systemd::collect_systemd_services,
        tmux::collect_tmux_sessions,
    },
    publication::redact_runtime_map,
};
use dockermap_core::{
    derive_runtime_map, service_entity_kind_name, DiagnosticSeverity, DockerSnapshot, RuntimeMap,
    RuntimeMapDiagnostic, RuntimeMapNode, RuntimeNodeKind, RuntimeNodeLayer, RuntimeProviderKind,
    ServiceEntityKind,
};
use std::{
    collections::BTreeMap,
    fs,
    path::Path as StdPath,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

/// Overall budget for one full runtime-map collection (all provider
/// subprocesses, the npm filesystem walk, and /proc reads) when it runs off
/// the async runtime.
const RUNTIME_MAP_COLLECTION_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) fn collect_runtime_map(snapshot: &DockerSnapshot) -> RuntimeMap {
    let mut collection = ProviderCollection::default();
    let project_root = project_root().ok();
    let pid_namespace = daemon_pid_namespace_scope();

    if let Some(message) = pid_namespace.diagnostic() {
        collection.push_diagnostic(ProviderDiagnostic::new(
            RuntimeProviderKind::Process,
            DiagnosticSeverity::Info,
            message,
        ));
    }

    if pid_namespace.is_restricted() {
        collection.push_diagnostic(ProviderDiagnostic::new(
            RuntimeProviderKind::Host,
            DiagnosticSeverity::Info,
            "Host node omitted because the daemon runs in a restricted PID namespace",
        ));
    } else {
        collect_host_node(project_root.as_deref(), collection.nodes_mut());
    }
    {
        let (nodes, edges, diagnostics) = collection.parts_mut();
        collect_network_infrastructure(pid_namespace, snapshot, nodes, edges, diagnostics);
    }
    collect_host_scoped_runtime_providers(pid_namespace, &mut collection);
    {
        let (nodes, _, diagnostics) = collection.parts_mut();
        collect_python_processes(pid_namespace.is_restricted(), nodes, diagnostics);
        collect_native_processes_with_scope(pid_namespace.is_restricted(), nodes, diagnostics);
    }
    if let Some(root) = project_root.as_deref() {
        // This root is an explicit project mount/configuration target rather
        // than namespace-global discovery, so npm remains available even to a
        // containerized daemon (and is documented as mounted project data).
        let (nodes, edges, diagnostics) = collection.parts_mut();
        collect_npm_projects(root, pid_namespace, nodes, edges, diagnostics);
    } else {
        collection.push_diagnostic(ProviderDiagnostic::new(
            RuntimeProviderKind::Npm,
            DiagnosticSeverity::Info,
            "npm discovery skipped: project root unavailable",
        ));
    }

    let (nodes, edges, diagnostics) = collection.into_parts();
    let mut runtime_map = derive_runtime_map(snapshot, nodes, edges, diagnostics);
    redact_runtime_map(&mut runtime_map);
    runtime_map
}

/// Collect the runtime map off the async runtime: provider commands are
/// blocking `std::process` calls, so they must never run on a Tokio worker
/// thread. The collection is single-flight and bounded so pathological
/// providers degrade the map rather than stalling refresh.
pub(crate) async fn collect_runtime_map_bounded(
    in_flight: Arc<AtomicBool>,
    snapshot: &DockerSnapshot,
) -> RuntimeMap {
    let snapshot = snapshot.clone();
    let Some(collection_guard) = RuntimeCollectionGuard::acquire(in_flight) else {
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
/// Docker-derived nodes remain useful, and the warning explains why host
/// providers are absent.
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

/// `/proc/net`, init-service managers, schedulers, PM2, and tmux expose only
/// the daemon container's view in a restricted PID namespace. Keep them out
/// of a host topology rather than relabeling container-local evidence.
pub(crate) fn collect_host_scoped_runtime_providers(
    pid_namespace: PidNamespaceScope,
    collection: &mut ProviderCollection,
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
            collection.push_diagnostic(ProviderDiagnostic::new(
                provider,
                DiagnosticSeverity::Info,
                message,
            ));
        }
        return;
    }

    let (nodes, edges, diagnostics) = collection.parts_mut();
    collect_network_listeners(nodes, diagnostics);
    collect_systemd_services(nodes, edges, diagnostics);
    collect_scheduled_jobs(nodes, diagnostics);
    collect_pm2_apps(nodes, diagnostics);
    collect_tmux_sessions(nodes, diagnostics);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restricted_namespace_omits_host_scoped_collectors() {
        let mut collection = ProviderCollection::default();
        collect_host_scoped_runtime_providers(PidNamespaceScope::Restricted, &mut collection);
        let (nodes, edges, diagnostics) = collection.into_parts();

        assert!(nodes.is_empty());
        assert!(edges.is_empty());
        for provider in [
            RuntimeProviderKind::Network,
            RuntimeProviderKind::Systemd,
            RuntimeProviderKind::ScheduledJob,
            RuntimeProviderKind::Pm2,
            RuntimeProviderKind::Tmux,
        ] {
            assert!(diagnostics
                .iter()
                .any(|diagnostic| diagnostic.provider == provider));
        }
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
}
