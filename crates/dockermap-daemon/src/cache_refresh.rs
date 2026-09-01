//! Daemon cache state and bounded refresh orchestration.
//!
//! This module owns the cache lifecycle, the explicitly configured filtered
//! Docker gateway client, and the periodic snapshot/runtime refresh. HTTP
//! routes only publish this state; they never reconnect to Docker or collect
//! host providers directly.

use crate::{
    docker_collector::DockerCollector,
    provider_contract::ProviderCollection,
    publication::{publish_docker_snapshot, redact_health_response, redact_runtime_map},
    runtime_collection::{
        collect_provider_observations_bounded, runtime_map_from_collection,
        ProviderCollectionOutcome,
    },
};
use dockermap_core::{
    derive_images, mock_snapshot, DiagnosticSeverity, DockerSnapshot, HealthResponse, HealthState,
    ProviderSlot, ProviderState, ProviderStateKind, RuntimeMap, RuntimeMapDiagnostic, RuntimeMode,
    RuntimeProviderKind,
};
use std::{
    sync::{atomic::AtomicBool, Arc, OnceLock},
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
    revision: PublicationRevision,
}

/// Per-process, opaque revision source. The boot value comes from the OS CSPRNG
/// and is deliberately never derived from inventory, timestamps, or secrets.
#[derive(Clone)]
struct PublicationRevision {
    boot: String,
    sequence: u64,
    last_observable: Option<String>,
}

impl PublicationRevision {
    fn new() -> Self {
        Self {
            boot: boot_instance_component(),
            sequence: 0,
            last_observable: None,
        }
    }

    fn current(&self) -> String {
        format!("{}-{}", self.boot, self.sequence)
    }

    fn assign(
        &mut self,
        snapshot: &mut DockerSnapshot,
        health: &mut HealthResponse,
        runtime_map: &mut RuntimeMap,
    ) {
        // Compare precisely the model that routes can expose. Cache inventory
        // intentionally retains raw identities for correlation, so serializing
        // it here would make a revision change an oracle for secret-only raw
        // changes. The opaque revision fields themselves cannot influence
        // change detection.
        let mut published_snapshot = publish_docker_snapshot(snapshot);
        let mut published_health = health.clone();
        let mut published_runtime_map = runtime_map.clone();
        redact_health_response(&mut published_health);
        redact_runtime_map(&mut published_runtime_map);
        published_snapshot.model_revision.clear();
        published_health.model_revision.clear();
        published_runtime_map.model_revision.clear();
        let observable = serde_json::to_string(&(
            &published_snapshot,
            &published_health,
            &published_runtime_map,
        ))
        .expect("public DockerMap models are serializable");
        if self.last_observable.as_deref() != Some(observable.as_str()) {
            self.sequence = self
                .sequence
                .checked_add(1)
                .expect("model revision sequence overflow");
            self.last_observable = Some(observable);
        }
        let revision = self.current();
        snapshot.model_revision = revision.clone();
        health.model_revision = revision.clone();
        runtime_map.model_revision = revision;
    }
}

fn boot_instance_component() -> String {
    static BOOT: OnceLock<String> = OnceLock::new();
    BOOT.get_or_init(|| {
        let mut bytes = [0_u8; 16];
        getrandom::fill(&mut bytes)
            .expect("OS CSPRNG must be available for model revision boot instance");
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    })
    .clone()
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
    TimedOut(Option<ProviderCollection>),
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
            model_revision: String::new(),
            message: Some("Docker unavailable, serving mock data".into()),
        };
        redact_health_response(&mut health);

        let last_updated = snapshot.last_updated;
        let mut cache = Self {
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
            revision: PublicationRevision::new(),
        };
        cache.assign_revision();
        cache
    }

    fn assign_revision(&mut self) {
        // All three independently routable model envelopes attest the same
        // publication. Provider state is runtime-topology evidence only.
        self.revision
            .assign(&mut self.snapshot, &mut self.health, &mut self.runtime_map);
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
    updated.revision = cache.revision.clone();
    updated.assign_revision();
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
                    model_revision: String::new(),
                    message: Some("Docker engine connected".into()),
                };
                DaemonCache {
                    snapshot,
                    health,
                    runtime_map: empty_runtime_map(0),
                    runtime_providers: RuntimeProviderState::Unavailable,
                    revision: PublicationRevision::new(),
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
        | RuntimeProviderState::Degraded(Some(collection))
        | RuntimeProviderState::TimedOut(Some(collection)) => Some(collection.clone()),
        RuntimeProviderState::Unavailable
        | RuntimeProviderState::Collecting(None)
        | RuntimeProviderState::Degraded(None)
        | RuntimeProviderState::TimedOut(None) => None,
    };
    cache.runtime_providers = RuntimeProviderState::Collecting(retained);
    cache.runtime_map = runtime_map_for_snapshot(&cache.snapshot, &cache.runtime_providers);
    cache.assign_revision();
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
        ProviderCollectionOutcome::Collected(collection)
            if same_collection_evidence(&cache.snapshot, &observed_snapshot) =>
        {
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
                | RuntimeProviderState::Degraded(retained)
                | RuntimeProviderState::TimedOut(retained) => retained.clone(),
                RuntimeProviderState::Fresh(collection) => Some(collection.clone()),
                RuntimeProviderState::Unavailable => None,
            };
            cache.runtime_providers = if matches!(outcome, ProviderCollectionOutcome::TimedOut) {
                RuntimeProviderState::TimedOut(retained)
            } else {
                RuntimeProviderState::Degraded(retained)
            };
        }
    }
    cache.runtime_map = runtime_map_for_snapshot(&cache.snapshot, &cache.runtime_providers);
    cache.assign_revision();
}

/// A provider pass is bound to Docker evidence, not its cache-publication
/// revision. The latter is intentionally updated when `Collecting` is
/// published, so comparing the complete envelope would incorrectly make every
/// normal successful collection look stale.
fn same_collection_evidence(left: &DockerSnapshot, right: &DockerSnapshot) -> bool {
    // The cache deliberately retains raw Docker identifiers for internal
    // correlation. A provider pass must be tied to the same public evidence
    // that its completion can affect, otherwise a redacted-only raw change can
    // falsely turn a normal completion stale and expose a change oracle.
    let mut left = publish_docker_snapshot(left);
    let mut right = publish_docker_snapshot(right);
    left.model_revision.clear();
    right.model_revision.clear();
    left == right
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
        RuntimeProviderState::TimedOut(Some(collection)) => (
            collection.clone(),
            Some("Runtime provider refresh timed out; serving retained provider observations (stale)"),
        ),
        RuntimeProviderState::TimedOut(None) => (
            ProviderCollection::default(),
            Some("Runtime provider refresh timed out; no successful provider observations are available"),
        ),
        RuntimeProviderState::Unavailable => (
            ProviderCollection::default(),
            Some("Runtime provider observations are unavailable until the first successful collection"),
        ),
    };
    let mut runtime_map = runtime_map_from_collection(snapshot, &collection);
    runtime_map.provider_states = provider_states_for(state, &collection);
    if let Some(message) = diagnostic {
        runtime_map.diagnostics.push(RuntimeMapDiagnostic {
            provider: RuntimeProviderKind::Other,
            severity: DiagnosticSeverity::Warning,
            message: message.into(),
        });
    }
    runtime_map
}

const STATIC_PROVIDER_SLOTS: [ProviderSlot; 5] = [
    ProviderSlot::NetworkInfrastructure,
    ProviderSlot::HostScoped,
    ProviderSlot::PythonProcesses,
    ProviderSlot::NativeProcesses,
    ProviderSlot::ProjectNpm,
];

/// Retained successful slots stay explicitly stale while a new attempt runs or
/// after a failed attempt. Disabled slots are configuration/profile facts, not
/// transient freshness states, and remain disabled through those transitions.
fn provider_states_for(
    state: &RuntimeProviderState,
    collection: &ProviderCollection,
) -> Vec<ProviderState> {
    STATIC_PROVIDER_SLOTS
        .into_iter()
        .map(|slot| {
            let base = collection
                .states()
                .iter()
                .find(|candidate| candidate.slot == slot)
                .map(|candidate| candidate.state)
                .unwrap_or(ProviderStateKind::Unavailable);
            let state = match state {
                RuntimeProviderState::Fresh(_) => base,
                RuntimeProviderState::Collecting(_) if base == ProviderStateKind::Disabled => {
                    ProviderStateKind::Disabled
                }
                RuntimeProviderState::Collecting(_) if base == ProviderStateKind::Unavailable => {
                    ProviderStateKind::Collecting
                }
                RuntimeProviderState::Collecting(_) => ProviderStateKind::Stale,
                RuntimeProviderState::Degraded(_) if base == ProviderStateKind::Disabled => {
                    ProviderStateKind::Disabled
                }
                RuntimeProviderState::Degraded(Some(_)) => ProviderStateKind::Stale,
                RuntimeProviderState::Degraded(None) => ProviderStateKind::Unavailable,
                RuntimeProviderState::TimedOut(_) if base == ProviderStateKind::Disabled => {
                    ProviderStateKind::Disabled
                }
                RuntimeProviderState::TimedOut(_) => ProviderStateKind::TimedOut,
                RuntimeProviderState::Unavailable => ProviderStateKind::Unavailable,
            };
            ProviderState { slot, state }
        })
        .collect()
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
                model_revision: String::new(),
                message: Some("controlled Docker cache".into()),
            },
            runtime_map: empty_runtime_map(last_updated),
            runtime_providers: RuntimeProviderState::Unavailable,
            revision: PublicationRevision::new(),
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

    #[tokio::test]
    async fn normal_provider_completion_for_the_same_docker_evidence_is_fresh() {
        let state = AppState {
            cache: Arc::new(RwLock::new(docker_cache(mock_snapshot()))),
            docker: Arc::new(RwLock::new(None)),
            runtime_collection_in_flight: Arc::new(AtomicBool::new(false)),
        };
        let (observed_snapshot, observed_mode) =
            publish_docker_snapshot_cache(&state, docker_cache(mock_snapshot())).await;
        mark_runtime_collection_started(&state).await;

        apply_runtime_collection_outcome(
            &state,
            observed_snapshot,
            observed_mode,
            ProviderCollectionOutcome::Collected(ProviderCollection::default()),
        )
        .await;

        assert!(matches!(
            state.cache.read().await.runtime_providers,
            RuntimeProviderState::Fresh(_)
        ));
    }

    #[tokio::test]
    async fn secret_only_midflight_snapshot_change_keeps_provider_completion_fresh() {
        let mut first_snapshot = mock_snapshot();
        first_snapshot.containers[0].role = "token=DOCKERMAP_TEST_FAKE_MIDFLIGHT_A".into();
        let mut second_snapshot = first_snapshot.clone();
        second_snapshot.containers[0].role = "token=DOCKERMAP_TEST_FAKE_MIDFLIGHT_B".into();

        let state = AppState {
            cache: Arc::new(RwLock::new(docker_cache(mock_snapshot()))),
            docker: Arc::new(RwLock::new(None)),
            runtime_collection_in_flight: Arc::new(AtomicBool::new(false)),
        };
        let (observed_snapshot, observed_mode) =
            publish_docker_snapshot_cache(&state, docker_cache(first_snapshot)).await;
        mark_runtime_collection_started(&state).await;
        let collecting_revision = state.cache.read().await.snapshot.model_revision.clone();

        publish_docker_snapshot_cache(&state, docker_cache(second_snapshot)).await;
        assert_eq!(
            state.cache.read().await.snapshot.model_revision,
            collecting_revision,
            "redacted-only raw inventory must not publish a new revision"
        );

        apply_runtime_collection_outcome(
            &state,
            observed_snapshot,
            observed_mode,
            ProviderCollectionOutcome::Collected(ProviderCollection::default()),
        )
        .await;
        assert!(matches!(
            state.cache.read().await.runtime_providers,
            RuntimeProviderState::Fresh(_)
        ));
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

    #[tokio::test]
    async fn coherent_model_revision_is_stable_for_unchanged_publication_and_monotonic_for_state_change(
    ) {
        let initial = docker_cache(mock_snapshot());
        let state = AppState {
            cache: Arc::new(RwLock::new(initial)),
            docker: Arc::new(RwLock::new(None)),
            runtime_collection_in_flight: Arc::new(AtomicBool::new(false)),
        };

        let same = docker_cache(mock_snapshot());
        publish_docker_snapshot_cache(&state, same.clone()).await;
        let first = state.cache.read().await.clone();
        assert_eq!(first.snapshot.model_revision, first.health.model_revision);
        assert_eq!(
            first.health.model_revision,
            first.runtime_map.model_revision
        );

        publish_docker_snapshot_cache(&state, same).await;
        let stable = state.cache.read().await.clone();
        assert_eq!(
            stable.snapshot.model_revision,
            first.snapshot.model_revision
        );

        mark_runtime_collection_started(&state).await;
        let changed = state.cache.read().await.clone();
        assert_ne!(
            changed.snapshot.model_revision,
            stable.snapshot.model_revision
        );
        assert_eq!(
            changed.snapshot.model_revision,
            changed.health.model_revision
        );
        assert_eq!(
            changed.health.model_revision,
            changed.runtime_map.model_revision
        );
    }

    #[tokio::test]
    async fn secret_only_raw_inventory_change_does_not_advance_public_revision() {
        let mut first_snapshot = mock_snapshot();
        first_snapshot.containers[0].role = "token=DOCKERMAP_TEST_FAKE_REVISION_A".into();
        let mut second_snapshot = first_snapshot.clone();
        second_snapshot.containers[0].role = "token=DOCKERMAP_TEST_FAKE_REVISION_B".into();
        assert_ne!(first_snapshot, second_snapshot);

        let state = AppState {
            cache: Arc::new(RwLock::new(docker_cache(mock_snapshot()))),
            docker: Arc::new(RwLock::new(None)),
            runtime_collection_in_flight: Arc::new(AtomicBool::new(false)),
        };
        publish_docker_snapshot_cache(&state, docker_cache(first_snapshot)).await;
        let first_revision = state.cache.read().await.snapshot.model_revision.clone();
        publish_docker_snapshot_cache(&state, docker_cache(second_snapshot)).await;
        let second_revision = state.cache.read().await.snapshot.model_revision.clone();

        assert_eq!(first_revision, second_revision);
    }

    #[test]
    fn model_revision_has_an_opaque_boot_component_and_monotonic_sequence() {
        let mut first = PublicationRevision {
            boot: "boot-a".into(),
            sequence: 0,
            last_observable: None,
        };
        let second = PublicationRevision {
            boot: "boot-b".into(),
            sequence: 0,
            last_observable: None,
        };
        assert_ne!(
            first.current(),
            second.current(),
            "distinct daemon boot instances must not share revisions"
        );
        first.sequence = 1;
        assert_eq!(first.current(), "boot-a-1");
        assert_eq!(
            boot_instance_component().len(),
            32,
            "boot component is 128 bits of CSPRNG output encoded as hex"
        );
    }

    #[test]
    fn provider_states_are_fixed_and_timeout_and_failure_do_not_masquerade_as_fresh() {
        let snapshot = mock_snapshot();
        let failed = runtime_map_for_snapshot(&snapshot, &RuntimeProviderState::Degraded(None));
        assert_eq!(failed.provider_states.len(), STATIC_PROVIDER_SLOTS.len());
        assert!(failed
            .provider_states
            .iter()
            .all(|state| state.state == ProviderStateKind::Unavailable));

        let timed_out = runtime_map_for_snapshot(&snapshot, &RuntimeProviderState::TimedOut(None));
        assert!(timed_out
            .provider_states
            .iter()
            .all(|state| state.state == ProviderStateKind::TimedOut));

        let mut collection = ProviderCollection::default();
        collection.set_state(ProviderSlot::HostScoped, ProviderStateKind::Disabled);
        let retained =
            runtime_map_for_snapshot(&snapshot, &RuntimeProviderState::Degraded(Some(collection)));
        assert!(retained
            .provider_states
            .iter()
            .any(|state| state.slot == ProviderSlot::HostScoped
                && state.state == ProviderStateKind::Disabled));
        assert!(retained
            .provider_states
            .iter()
            .any(|state| state.slot == ProviderSlot::ProjectNpm
                && state.state == ProviderStateKind::Stale));
    }
}
