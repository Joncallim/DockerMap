//! Daemon cache state and bounded refresh orchestration.
//!
//! This module owns the cache lifecycle, the explicitly configured filtered
//! Docker gateway client, and the periodic snapshot/runtime refresh. HTTP
//! routes only publish this state; they never reconnect to Docker or collect
//! host providers directly.

use crate::{
    docker_collector::DockerCollector,
    provider_contract::ProviderCollection,
    publication::redact_health_response,
    runtime_collection::{
        collect_provider_observations_bounded, runtime_map_from_collection,
        ProviderCollectionOutcome,
    },
};
use dockermap_core::{
    derive_images, mock_snapshot, DiagnosticSeverity, DockerSnapshot, HealthResponse, HealthState,
    RuntimeMap, RuntimeMapDiagnostic, RuntimeMode, RuntimeProviderKind,
};
use std::{
    sync::{atomic::AtomicBool, Arc},
    time::Duration,
};
use tokio::{sync::RwLock, time::sleep};

/// Current static Docker snapshot cadence. Optional provider collection is
/// single-flight and may still be unwinding when the next snapshot publishes;
/// this interval is not a provider scheduler or policy API.
pub(crate) const STATIC_REFRESH_INTERVAL: Duration = Duration::from_secs(2);

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
    runtime_providers: RuntimeProviderState,
}

/// Provider observations are retained independently from the Docker snapshot.
/// The public `RuntimeMap` is always rebuilt against the currently published
/// Docker snapshot. This avoids holding fresh Docker evidence hostage to an
/// optional host collector while making retained host observations explicit.
#[derive(Clone, Default)]
enum RuntimeProviderState {
    #[default]
    Unavailable,
    Fresh(ProviderCollection),
    Collecting(Option<ProviderCollection>),
    Degraded(Option<ProviderCollection>),
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
            snapshot_version: snapshot_observation_token(snapshot.last_updated),
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
            runtime_providers: RuntimeProviderState::Unavailable,
        }
    }
}

pub(crate) async fn refresh_loop(state: AppState) {
    loop {
        refresh_cache(&state).await;
        sleep(STATIC_REFRESH_INTERVAL).await;
    }
}

pub(crate) async fn refresh_cache(state: &AppState) {
    let (snapshot, mode) =
        publish_docker_snapshot_cache(state, collect_snapshot(state).await).await;

    // Publish Docker evidence before running any optional host command. The
    // spawned task uses the existing single-flight guard; it has no route,
    // Docker client, or source-fallback authority.
    if mode == RuntimeMode::Docker {
        mark_runtime_collection_started(state).await;
        let state = state.clone();
        tokio::spawn(async move {
            let outcome = collect_provider_observations_bounded(
                state.runtime_collection_in_flight.clone(),
                &snapshot,
            )
            .await;
            apply_runtime_collection_outcome(&state, snapshot, mode, outcome).await;
        });
    }
}

/// Publish a completed Docker read without awaiting optional provider work.
/// Kept separate from gateway collection so deterministic cache tests can
/// exercise source changes and out-of-order provider completion directly.
async fn publish_docker_snapshot_cache(
    state: &AppState,
    mut updated: DaemonCache,
) -> (DockerSnapshot, RuntimeMode) {
    let mut cache = state.cache.write().await;
    // A mock fallback is a distinct source of bytes. Do not retain live host
    // observations and relabel them as sample data (or vice versa).
    updated.runtime_providers = if cache.health.mode == updated.health.mode {
        cache.runtime_providers.clone()
    } else {
        RuntimeProviderState::Unavailable
    };
    updated.runtime_map = runtime_map_for_snapshot(&updated.snapshot, &updated.runtime_providers);
    *cache = updated;
    (cache.snapshot.clone(), cache.health.mode.clone())
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
                    snapshot_version: snapshot_observation_token(snapshot.last_updated),
                    message: Some("Docker engine connected".into()),
                };
                DaemonCache {
                    snapshot,
                    health,
                    runtime_map: empty_runtime_map(0),
                    runtime_providers: RuntimeProviderState::Unavailable,
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
    // Docker failure details are provider-controlled. Sanitize before the
    // cache is observable through health, API proxy, or SSE routes.
    redact_health_response(&mut cache.health);
    cache
}

async fn mark_runtime_collection_started(state: &AppState) {
    let mut cache = state.cache.write().await;
    let retained = match &cache.runtime_providers {
        RuntimeProviderState::Fresh(collection)
        | RuntimeProviderState::Collecting(Some(collection))
        | RuntimeProviderState::Degraded(Some(collection)) => Some(collection.clone()),
        RuntimeProviderState::Unavailable
        | RuntimeProviderState::Collecting(None)
        | RuntimeProviderState::Degraded(None) => None,
    };
    cache.runtime_providers = RuntimeProviderState::Collecting(retained);
    cache.runtime_map = runtime_map_for_snapshot(&cache.snapshot, &cache.runtime_providers);
}

async fn apply_runtime_collection_outcome(
    state: &AppState,
    observed_snapshot: DockerSnapshot,
    observed_mode: RuntimeMode,
    outcome: ProviderCollectionOutcome,
) {
    let mut cache = state.cache.write().await;
    // Never apply observations across a live/mock transition. The current
    // map remains explicitly unavailable until a collection for that source
    // completes.
    if cache.health.mode != observed_mode {
        return;
    }
    match outcome {
        ProviderCollectionOutcome::Collected(collection) if cache.snapshot == observed_snapshot => {
            cache.runtime_providers =
                RuntimeProviderState::Fresh(collection.sanitized_for_retention());
        }
        ProviderCollectionOutcome::Collected(collection) => {
            // Docker changed while the bounded optional pass was in flight.
            // Preserve it only as explicitly stale evidence; the next tick
            // collects against the new snapshot.
            cache.runtime_providers =
                RuntimeProviderState::Degraded(Some(collection.sanitized_for_retention()));
        }
        ProviderCollectionOutcome::InFlight => return,
        ProviderCollectionOutcome::Failed | ProviderCollectionOutcome::TimedOut => {
            let retained = match &cache.runtime_providers {
                RuntimeProviderState::Collecting(retained)
                | RuntimeProviderState::Degraded(retained) => retained.clone(),
                RuntimeProviderState::Fresh(collection) => Some(collection.clone()),
                RuntimeProviderState::Unavailable => None,
            };
            cache.runtime_providers = RuntimeProviderState::Degraded(retained);
        }
    }
    cache.runtime_map = runtime_map_for_snapshot(&cache.snapshot, &cache.runtime_providers);
}

fn runtime_map_for_snapshot(snapshot: &DockerSnapshot, state: &RuntimeProviderState) -> RuntimeMap {
    let (collection, diagnostic) = match state {
        RuntimeProviderState::Fresh(collection) => (collection.clone(), None),
        RuntimeProviderState::Collecting(Some(collection)) => (
            collection.clone(),
            Some("Runtime provider refresh is in progress; serving retained provider observations (stale)"),
        ),
        RuntimeProviderState::Degraded(Some(collection)) => (
            collection.clone(),
            Some("Runtime provider refresh failed, timed out, or observed an older snapshot; serving retained provider observations (stale)"),
        ),
        RuntimeProviderState::Collecting(None) => (
            ProviderCollection::default(),
            Some("Runtime provider refresh is in progress; no successful provider observations are available"),
        ),
        RuntimeProviderState::Degraded(None) => (
            ProviderCollection::default(),
            Some("Runtime provider refresh failed or timed out; no successful provider observations are available"),
        ),
        RuntimeProviderState::Unavailable => (
            ProviderCollection::default(),
            Some("Runtime provider observations are unavailable until the first successful collection"),
        ),
    };
    let mut runtime_map = runtime_map_from_collection(snapshot, &collection);
    if let Some(message) = diagnostic {
        runtime_map.diagnostics.push(RuntimeMapDiagnostic {
            provider: RuntimeProviderKind::Other,
            severity: DiagnosticSeverity::Warning,
            message: message.into(),
        });
    }
    runtime_map
}

/// The existing public field is only the opaque string form of the Docker
/// snapshot observation timestamp. It is not a cache-publication/model
/// revision: runtime collection may complete after this value is assigned.
fn snapshot_observation_token(last_updated: u64) -> String {
    last_updated.to_string()
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider_contract::{ProviderCollection, ProviderDiagnostic};
    use dockermap_core::{mock_snapshot, DiagnosticSeverity, RuntimeProviderKind};
    use std::time::Duration;

    fn docker_cache(snapshot: DockerSnapshot) -> DaemonCache {
        let last_updated = snapshot.last_updated;
        DaemonCache {
            snapshot,
            health: HealthResponse {
                status: HealthState::Ok,
                mode: RuntimeMode::Docker,
                docker_reachable: true,
                last_updated,
                snapshot_version: snapshot_observation_token(last_updated),
                message: Some("controlled Docker cache".into()),
            },
            runtime_map: empty_runtime_map(last_updated),
            runtime_providers: RuntimeProviderState::Unavailable,
        }
    }

    #[test]
    fn static_refresh_cadence_is_explicit_and_not_a_provider_scheduler() {
        assert_eq!(STATIC_REFRESH_INTERVAL, Duration::from_secs(2));
        assert!(
            !STATIC_REFRESH_INTERVAL.is_zero(),
            "a zero cadence would turn the static sequential loop into a busy refresh loop"
        );
    }

    #[test]
    fn retained_provider_observations_are_explicitly_stale_but_fresh_docker_nodes_publish() {
        let mut snapshot = mock_snapshot();
        snapshot.last_updated = 101;
        let mut providers = ProviderCollection::default();
        providers.push_diagnostic(ProviderDiagnostic::new(
            RuntimeProviderKind::Process,
            DiagnosticSeverity::Info,
            "controlled retained provider observation",
        ));

        let map =
            runtime_map_for_snapshot(&snapshot, &RuntimeProviderState::Degraded(Some(providers)));
        assert_eq!(
            map.last_updated, 101,
            "fresh Docker snapshot remains publishable"
        );
        assert!(map
            .nodes
            .iter()
            .any(|node| node.provider == RuntimeProviderKind::Docker));
        assert!(map
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.message == "controlled retained provider observation"));
        assert!(
            map.diagnostics.iter().any(|diagnostic| diagnostic
                .message
                .contains("retained provider observations (stale)")),
            "retained observations must never masquerade as fresh"
        );
    }

    #[test]
    fn failed_first_provider_attempt_is_degraded_not_healthy_or_fresh() {
        let mut snapshot = mock_snapshot();
        snapshot.last_updated = 202;
        let map = runtime_map_for_snapshot(&snapshot, &RuntimeProviderState::Degraded(None));
        assert_eq!(map.last_updated, 202);
        assert!(map
            .nodes
            .iter()
            .any(|node| node.provider == RuntimeProviderKind::Docker));
        assert!(map
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.message.contains("failed or timed out")));
    }

    #[tokio::test]
    async fn failed_refresh_retains_prior_provider_observations_against_the_new_docker_snapshot() {
        let mut previous = docker_cache(mock_snapshot());
        let mut retained = ProviderCollection::default();
        retained.push_diagnostic(ProviderDiagnostic::new(
            RuntimeProviderKind::Npm,
            DiagnosticSeverity::Info,
            "controlled previously successful provider observation",
        ));
        previous.runtime_providers = RuntimeProviderState::Fresh(retained);

        let state = AppState {
            cache: Arc::new(RwLock::new(previous)),
            docker: Arc::new(RwLock::new(None)),
            runtime_collection_in_flight: Arc::new(AtomicBool::new(false)),
        };
        let mut fresh_snapshot = mock_snapshot();
        fresh_snapshot.last_updated = 303;
        let (observed_snapshot, observed_mode) =
            publish_docker_snapshot_cache(&state, docker_cache(fresh_snapshot.clone())).await;
        mark_runtime_collection_started(&state).await;

        apply_runtime_collection_outcome(
            &state,
            observed_snapshot,
            observed_mode,
            ProviderCollectionOutcome::TimedOut,
        )
        .await;

        let cache = state.cache.read().await;
        assert_eq!(cache.runtime_map.last_updated, 303);
        assert!(cache
            .runtime_map
            .nodes
            .iter()
            .any(|node| node.provider == RuntimeProviderKind::Docker));
        assert!(cache
            .runtime_map
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.message
                == "controlled previously successful provider observation"));
        assert!(cache
            .runtime_map
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic
                .message
                .contains("retained provider observations (stale)")));
    }

    #[tokio::test]
    async fn prior_docker_provider_result_cannot_cross_a_mock_source_transition() {
        let mut initial_snapshot = mock_snapshot();
        initial_snapshot.last_updated = 401;
        let mut previous = docker_cache(initial_snapshot);
        let mut retained = ProviderCollection::default();
        retained.push_diagnostic(ProviderDiagnostic::new(
            RuntimeProviderKind::Process,
            DiagnosticSeverity::Info,
            "controlled live provider observation",
        ));
        previous.runtime_providers = RuntimeProviderState::Fresh(retained);
        let state = AppState {
            cache: Arc::new(RwLock::new(previous)),
            docker: Arc::new(RwLock::new(None)),
            runtime_collection_in_flight: Arc::new(AtomicBool::new(false)),
        };
        // This is the same cache-publication seam `refresh_cache` uses after
        // a gateway failure returns mock bytes.
        publish_docker_snapshot_cache(&state, DaemonCache::mock()).await;
        apply_runtime_collection_outcome(
            &state,
            mock_snapshot(),
            RuntimeMode::Docker,
            ProviderCollectionOutcome::Collected(ProviderCollection::default()),
        )
        .await;
        let cache = state.cache.read().await;
        assert!(matches!(
            cache.runtime_providers,
            RuntimeProviderState::Unavailable
        ));
        assert_eq!(cache.health.mode, RuntimeMode::Mock);
        assert!(
            !cache
                .runtime_map
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic
                    .message
                    .contains("controlled live provider observation")),
            "mock cache must not receive live provider observations"
        );
    }

    #[tokio::test]
    async fn provider_result_from_an_older_snapshot_is_retained_only_as_stale() {
        let mut old_snapshot = mock_snapshot();
        old_snapshot.last_updated = 501;
        let state = AppState {
            cache: Arc::new(RwLock::new(docker_cache(old_snapshot.clone()))),
            docker: Arc::new(RwLock::new(None)),
            runtime_collection_in_flight: Arc::new(AtomicBool::new(false)),
        };
        let (observed_snapshot, observed_mode) =
            publish_docker_snapshot_cache(&state, docker_cache(old_snapshot)).await;
        let mut newer_snapshot = mock_snapshot();
        newer_snapshot.last_updated = 502;
        publish_docker_snapshot_cache(&state, docker_cache(newer_snapshot)).await;

        apply_runtime_collection_outcome(
            &state,
            observed_snapshot,
            observed_mode,
            ProviderCollectionOutcome::Collected(ProviderCollection::default()),
        )
        .await;

        let cache = state.cache.read().await;
        assert_eq!(cache.runtime_map.last_updated, 502);
        assert!(matches!(
            cache.runtime_providers,
            RuntimeProviderState::Degraded(Some(_))
        ));
        assert!(cache
            .runtime_map
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic
                .message
                .contains("retained provider observations (stale)")));
    }

    #[test]
    fn snapshot_version_is_only_the_snapshot_observation_token() {
        assert_eq!(snapshot_observation_token(42), "42");
        assert_eq!(
            snapshot_observation_token(42),
            snapshot_observation_token(42),
            "the existing field has no per-publication uniqueness guarantee"
        );
    }
}
