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
    derive_runtime_map, service_entity_kind_name, DiagnosticSeverity, DockerSnapshot, ProviderSlot,
    ProviderStateKind, RuntimeMap, RuntimeMapNode, RuntimeMode, RuntimeNodeKind, RuntimeNodeLayer,
    RuntimeProviderKind, ServiceEntityKind,
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

/// Fixed, daemon-owned provider slots. This is deliberately not a plugin or
/// scheduling configuration surface.
pub(crate) type StaticProviderSlot = ProviderSlot;

pub(crate) const STATIC_PROVIDER_SLOTS: &[StaticProviderSlot] = &[
    StaticProviderSlot::NetworkInfrastructure,
    StaticProviderSlot::HostScoped,
    StaticProviderSlot::Systemd,
    StaticProviderSlot::PythonProcesses,
    StaticProviderSlot::NativeProcesses,
    StaticProviderSlot::ProjectNpm,
];

/// Completion-relative cadence for each fixed slot. The values are private
/// implementation policy, intentionally not environment-configurable.
pub(crate) fn slot_interval(slot: StaticProviderSlot) -> Duration {
    match slot {
        StaticProviderSlot::NetworkInfrastructure => Duration::from_secs(10),
        StaticProviderSlot::HostScoped => Duration::from_secs(15),
        StaticProviderSlot::Systemd => Duration::from_secs(15),
        StaticProviderSlot::PythonProcesses => Duration::from_secs(10),
        StaticProviderSlot::NativeProcesses => Duration::from_secs(10),
        StaticProviderSlot::ProjectNpm => Duration::from_secs(60),
    }
}

/// Result of one bounded provider-observation attempt. This is deliberately
/// internal: the cache owns both retained observations and the public runtime
/// map, so a failed optional provider pass can never relabel old observations
/// as a fresh successful collection.
pub(crate) enum ProviderCollectionOutcome {
    Collected(ProviderCollection),
    InFlight,
    Failed,
    TimedOut,
}

/// Collect provider observations off the async runtime: provider commands are
/// blocking `std::process` calls, so they must never run on a Tokio worker
/// thread. The collection is single-flight and bounded so pathological
/// providers cannot stall Docker snapshot publication.
pub(crate) async fn collect_provider_slot_bounded(
    in_flight: Arc<AtomicBool>,
    slot: StaticProviderSlot,
    snapshot: &DockerSnapshot,
) -> ProviderCollectionOutcome {
    let snapshot = snapshot.clone();
    let Some(collection_guard) = RuntimeCollectionGuard::acquire(in_flight) else {
        eprintln!("runtime map collection skipped: previous collection is still in flight");
        return ProviderCollectionOutcome::InFlight;
    };
    let work = {
        let snapshot = snapshot.clone();
        tokio::task::spawn_blocking(move || {
            let _collection_guard = collection_guard;
            collect_provider_slot(slot, &snapshot)
        })
    };
    match tokio::time::timeout(RUNTIME_MAP_COLLECTION_TIMEOUT, work).await {
        Ok(Ok(collection)) => ProviderCollectionOutcome::Collected(collection),
        Ok(Err(join_error)) => {
            eprintln!("runtime map collection task failed: {join_error}");
            ProviderCollectionOutcome::Failed
        }
        Err(_elapsed) => {
            eprintln!("runtime map collection timed out after {RUNTIME_MAP_COLLECTION_TIMEOUT:?}");
            ProviderCollectionOutcome::TimedOut
        }
    }
}

pub(crate) fn runtime_map_from_collection(
    snapshot: &DockerSnapshot,
    collection: &ProviderCollection,
    docker_observation_revision: &str,
    mode: &RuntimeMode,
) -> RuntimeMap {
    let (nodes, edges, diagnostics) = collection.clone().into_parts();
    let mut runtime_map = derive_runtime_map(
        snapshot,
        nodes,
        edges,
        diagnostics,
        docker_observation_revision,
    );
    // `mock_snapshot` intentionally preserves a representative topology, but
    // it is not an observation from Docker.  Never let derived Docker (or
    // retained provider) evidence attest those sample nodes and edges.
    if *mode != RuntimeMode::Docker {
        for edge in &mut runtime_map.edges {
            edge.evidence_refs.clear();
        }
    }
    redact_runtime_map(&mut runtime_map);
    runtime_map
}

/// Runs exactly one fixed slot. Each slot returns a self-contained collection
/// with a single state entry so cache retention never mixes freshness claims.
fn collect_provider_slot(
    slot: StaticProviderSlot,
    snapshot: &DockerSnapshot,
) -> ProviderCollection {
    let mut collection = ProviderCollection::default();
    let project_root = project_root().ok();
    let pid_namespace = daemon_pid_namespace_scope();
    match slot {
        StaticProviderSlot::NetworkInfrastructure => {
            let (nodes, edges, diagnostics) = collection.parts_mut();
            collect_network_infrastructure(pid_namespace, snapshot, nodes, edges, diagnostics);
            collection.set_state(slot, ProviderStateKind::Fresh);
        }
        StaticProviderSlot::HostScoped => {
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
            collect_host_scoped_runtime_providers(pid_namespace, &mut collection);
            collection.set_state(
                slot,
                if pid_namespace.is_restricted() {
                    ProviderStateKind::Disabled
                } else {
                    ProviderStateKind::Fresh
                },
            );
        }
        StaticProviderSlot::Systemd => {
            collect_systemd_runtime_provider(pid_namespace, &mut collection);
            collection.set_state(
                slot,
                if pid_namespace.is_restricted() {
                    ProviderStateKind::Disabled
                } else {
                    ProviderStateKind::Fresh
                },
            );
        }
        StaticProviderSlot::PythonProcesses => {
            let (nodes, _, diagnostics) = collection.parts_mut();
            collect_python_processes(pid_namespace.is_restricted(), nodes, diagnostics);
            collection.set_state(
                slot,
                if pid_namespace.is_restricted() {
                    ProviderStateKind::Disabled
                } else {
                    ProviderStateKind::Fresh
                },
            );
        }
        StaticProviderSlot::NativeProcesses => {
            let (nodes, _, diagnostics) = collection.parts_mut();
            collect_native_processes_with_scope(pid_namespace.is_restricted(), nodes, diagnostics);
            collection.set_state(
                slot,
                if pid_namespace.is_restricted() {
                    ProviderStateKind::Disabled
                } else {
                    ProviderStateKind::Fresh
                },
            );
        }
        StaticProviderSlot::ProjectNpm => {
            if let Some(root) = project_root.as_deref() {
                let (nodes, edges, diagnostics) = collection.parts_mut();
                collect_npm_projects(root, pid_namespace, nodes, edges, diagnostics);
                collection.set_state(slot, ProviderStateKind::Fresh);
            } else {
                collection.push_diagnostic(ProviderDiagnostic::new(
                    RuntimeProviderKind::Npm,
                    DiagnosticSeverity::Info,
                    "npm discovery skipped: project root unavailable",
                ));
                collection.set_state(slot, ProviderStateKind::Disabled);
            }
        }
    }
    collection
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

/// `/proc/net`, schedulers, PM2, and tmux expose only
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

    let (nodes, _, diagnostics) = collection.parts_mut();
    collect_network_listeners(nodes, diagnostics);
    collect_scheduled_jobs(nodes, diagnostics);
    collect_pm2_apps(nodes, diagnostics);
    collect_tmux_sessions(nodes, diagnostics);
}

/// systemd's unit graph is independently scheduled so its relationship facts
/// have their own state and revision.  This does not add a command: it keeps
/// the existing fixed, read-only `systemctl` collector and its diagnostics.
fn collect_systemd_runtime_provider(
    pid_namespace: PidNamespaceScope,
    collection: &mut ProviderCollection,
) {
    if pid_namespace.is_restricted() {
        collection.push_diagnostic(ProviderDiagnostic::new(
            RuntimeProviderKind::Systemd,
            DiagnosticSeverity::Info,
            "systemd discovery omitted because the daemon runs in a restricted PID namespace",
        ));
        return;
    }

    let (nodes, edges, diagnostics) = collection.parts_mut();
    collect_systemd_services(nodes, edges, diagnostics);
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
    fn restricted_namespace_keeps_systemd_as_a_distinct_disabled_slot() {
        let mut host = ProviderCollection::default();
        collect_host_scoped_runtime_providers(PidNamespaceScope::Restricted, &mut host);
        let (_, _, host_diagnostics) = host.into_parts();
        assert!(host_diagnostics
            .iter()
            .all(|diagnostic| diagnostic.provider != RuntimeProviderKind::Systemd));

        let mut systemd = ProviderCollection::default();
        collect_systemd_runtime_provider(PidNamespaceScope::Restricted, &mut systemd);
        systemd.set_state(StaticProviderSlot::Systemd, ProviderStateKind::Disabled);
        assert!(systemd.states().iter().any(|state| {
            state.slot == StaticProviderSlot::Systemd && state.state == ProviderStateKind::Disabled
        }));
        let (_, _, systemd_diagnostics) = systemd.into_parts();
        assert!(systemd_diagnostics.iter().any(|diagnostic| {
            diagnostic.provider == RuntimeProviderKind::Systemd
                && diagnostic.message.contains("restricted PID namespace")
        }));
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
    fn static_provider_baseline_has_one_fixed_slot_per_collection_stage() {
        assert_eq!(
            STATIC_PROVIDER_SLOTS,
            [
                StaticProviderSlot::NetworkInfrastructure,
                StaticProviderSlot::HostScoped,
                StaticProviderSlot::Systemd,
                StaticProviderSlot::PythonProcesses,
                StaticProviderSlot::NativeProcesses,
                StaticProviderSlot::ProjectNpm,
            ],
            "changing provider cadence or introducing an independently scheduled provider requires an explicit contract revision"
        );
    }
}
