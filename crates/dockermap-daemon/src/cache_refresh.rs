//! Daemon cache state and bounded refresh orchestration.
//!
//! This module owns the cache lifecycle, the explicitly configured filtered
//! Docker gateway client, and the periodic snapshot/runtime refresh. HTTP
//! routes only publish this state; they never reconnect to Docker or collect
//! host providers directly.

use crate::{
    docker_collector::DockerCollector, publication::redact_health_response,
    runtime_collection::collect_runtime_map_bounded,
};
use dockermap_core::{
    derive_images, mock_snapshot, DockerSnapshot, HealthResponse, HealthState, RuntimeMap,
    RuntimeMode,
};
use std::{
    sync::{atomic::AtomicBool, Arc},
    time::Duration,
};
use tokio::{sync::RwLock, time::sleep};

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) cache: Arc<RwLock<DaemonCache>>,
    /// Reused Bollard client for the filtered gateway socket. It is created
    /// only through `DockerCollector::connect`, which has no raw-socket
    /// fallback, and is discarded after a failed Docker interaction.
    pub(crate) docker: Arc<RwLock<Option<DockerCollector>>>,
    /// A timed-out blocking collection keeps running until its subprocesses
    /// unwind. Do not start a second expensive collection while that happens.
    pub(crate) runtime_collection_in_flight: Arc<AtomicBool>,
}

impl AppState {
    pub(crate) fn new() -> Self {
        Self {
            cache: Arc::new(RwLock::new(DaemonCache::mock())),
            docker: Arc::new(RwLock::new(None)),
            runtime_collection_in_flight: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[derive(Clone)]
pub(crate) struct DaemonCache {
    pub(crate) snapshot: DockerSnapshot,
    pub(crate) health: HealthResponse,
    pub(crate) runtime_map: RuntimeMap,
}

impl DaemonCache {
    pub(crate) fn mock() -> Self {
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

pub(crate) async fn refresh_loop(state: AppState) {
    loop {
        refresh_cache(&state).await;
        sleep(Duration::from_secs(2)).await;
    }
}

pub(crate) async fn refresh_cache(state: &AppState) {
    let updated = collect_snapshot(state).await;
    let mut cache = state.cache.write().await;
    *cache = updated;
}

/// Returns the cached gateway collector, connecting only to the configured
/// Docker Read Gateway on first use. Reuse avoids unnecessary Unix-socket
/// churn for refresh ticks and log requests.
pub(crate) async fn docker_collector(state: &AppState) -> Result<DockerCollector, String> {
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

/// Drop the cached client after an interaction failure so a restarted gateway
/// or Docker daemon is picked up by the next refresh. No direct-socket
/// alternative is attempted.
async fn invalidate_docker_collector(state: &AppState) {
    *state.docker.write().await = None;
}

async fn collect_snapshot(state: &AppState) -> DaemonCache {
    if std::env::var("DOCKERMAP_FORCE_MOCK").ok().as_deref() == Some("true") {
        let mut cache = DaemonCache::mock();
        cache.health.message = Some("Mock mode forced by DOCKERMAP_FORCE_MOCK".into());
        redact_health_response(&mut cache.health);
        cache.runtime_map = collect_runtime_map_bounded(
            state.runtime_collection_in_flight.clone(),
            &cache.snapshot,
        )
        .await;
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

    // Host collection is expensive and blocking; run it once per snapshot
    // cadence and retain its original source alongside the snapshot cache.
    cache.runtime_map =
        collect_runtime_map_bounded(state.runtime_collection_in_flight.clone(), &cache.snapshot)
            .await;
    // Docker failure details are provider-controlled. Sanitize before the
    // cache is observable through health, API proxy, or SSE routes.
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
