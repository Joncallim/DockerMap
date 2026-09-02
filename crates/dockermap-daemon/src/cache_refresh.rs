//! Daemon cache state and bounded refresh orchestration.
//!
//! This module owns the cache lifecycle, the explicitly configured filtered
//! Docker gateway client, and the periodic snapshot/runtime refresh. HTTP
//! routes only publish this state; they never reconnect to Docker or collect
//! host providers directly.

use crate::{
    docker_collector::DockerCollector,
    provider_contract::ProviderCollection,
    providers::npm::NPM_EVIDENCE_DEPENDENCY_MARKER,
    providers::systemd::{
        SYSTEMD_EVIDENCE_KIND_MARKER, SYSTEMD_EVIDENCE_PART_OF, SYSTEMD_EVIDENCE_REQUIRES,
        SYSTEMD_EVIDENCE_WANTS,
    },
    publication::{publish_docker_snapshot, redact_health_response, redact_runtime_map},
    runtime_collection::{
        collect_provider_slot_bounded, runtime_map_from_collection, slot_interval,
        ProviderCollectionOutcome, STATIC_PROVIDER_SLOTS,
    },
};
use dockermap_core::{
    collision_resistant_id_component, derive_findings, derive_images, mock_snapshot,
    DiagnosticSeverity, DockerSnapshot, FindingsResponse, HealthResponse, HealthState,
    ProviderSlot, ProviderState, ProviderStateKind, ProviderStatusReason,
    RuntimeEvidenceAssertionKind, RuntimeEvidenceFreshness, RuntimeEvidenceKind,
    RuntimeEvidenceProvider, RuntimeEvidenceRef, RuntimeMap, RuntimeMapDiagnostic, RuntimeMapEdge,
    RuntimeMode, RuntimeProviderKind,
};
use std::{
    collections::BTreeMap,
    sync::{atomic::AtomicBool, Arc, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
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
    /// Each static slot has an independent guard. A timed-out blocking slot
    /// holds its guard until the blocking worker unwinds, preventing overlap.
    pub(crate) provider_slot_in_flight: Arc<ProviderSlotFlights>,
}

impl AppState {
    pub(crate) fn new() -> Self {
        Self {
            cache: Arc::new(RwLock::new(DaemonCache::mock())),
            docker: Arc::new(RwLock::new(None)),
            provider_slot_in_flight: Arc::new(ProviderSlotFlights::default()),
        }
    }
}

#[derive(Clone)]
pub(crate) struct DaemonCache {
    pub(crate) snapshot: DockerSnapshot,
    pub(crate) health: HealthResponse,
    pub(crate) runtime_map: RuntimeMap,
    pub(crate) findings: FindingsResponse,
    runtime_providers: RuntimeProviderSlots,
    /// Increments on every Docker/mock source transition. A late worker must
    /// match this generation as well as evidence, so Docker→mock→Docker can
    /// never accept a completion from the earlier live generation.
    source_generation: u64,
    /// Opaque source-observation token attached to Docker-native evidence.
    /// This is intentionally distinct from the broader publication revision:
    /// provider slot state may change without changing Docker facts.
    docker_observation_revision: DockerObservationRevision,
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
        clear_volatile_observation_markers(
            &mut published_snapshot,
            &mut published_health,
            &mut published_runtime_map,
        );
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

/// Per-process opaque identity for the current sanitized Docker observation.
/// It advances only when bounded Docker semantics (or source mode) change,
/// never for the two-second observation timestamp tick.
#[derive(Clone)]
struct DockerObservationRevision {
    boot: String,
    sequence: u64,
    last_observable: Option<String>,
}

impl DockerObservationRevision {
    fn new() -> Self {
        Self {
            boot: opaque_revision_boot_component(),
            sequence: 0,
            last_observable: None,
        }
    }

    fn current(&self) -> String {
        format!("{}-{}", self.boot, self.sequence)
    }

    fn assign(&mut self, snapshot: &DockerSnapshot, mode: &RuntimeMode) {
        let mut published = publish_docker_snapshot(snapshot);
        // Observation time and the publication revision do not describe a
        // Docker fact. Clearing them prevents a healthy refresh ticker from
        // fabricating a new evidence revision every two seconds.
        published.last_updated = 0;
        published.model_revision.clear();
        let observable = serde_json::to_string(&(mode, published))
            .expect("public Docker observation is serializable");
        if self.last_observable.as_deref() != Some(observable.as_str()) {
            self.sequence = self
                .sequence
                .checked_add(1)
                .expect("Docker observation revision sequence overflow");
            self.last_observable = Some(observable);
        }
    }
}

fn opaque_revision_boot_component() -> String {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).expect("OS CSPRNG for opaque revision boot component");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Remove only fields which record when Docker was observed from the cloned,
/// already-public model used to decide whether a semantic publication changed.
/// The cache and HTTP responses retain the original values. In particular,
/// `snapshotVersion` is currently the string form of `lastUpdated`, so it is
/// another observation marker rather than model evidence.
fn clear_volatile_observation_markers(
    snapshot: &mut DockerSnapshot,
    health: &mut HealthResponse,
    runtime_map: &mut RuntimeMap,
) {
    snapshot.model_revision.clear();
    health.model_revision.clear();
    runtime_map.model_revision.clear();
    snapshot.last_updated = 0;
    health.last_updated = 0;
    health.snapshot_version.clear();
    runtime_map.last_updated = 0;
    // Docker evidence retains its real collection time for clients, but it is
    // not semantic topology. The stable opaque provider token remains in the
    // comparison so a genuine sanitized Docker observation still advances the
    // model revision exactly once.
    for edge in &mut runtime_map.edges {
        for evidence in &mut edge.evidence_refs {
            evidence.collected_at = 0;
        }
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

type RuntimeProviderSlots = BTreeMap<ProviderSlot, SlotRuntimeState>;

#[derive(Clone)]
struct SlotRuntimeState {
    observation: RuntimeProviderState,
    /// Monotonic process-relative completion time. It is private cache state,
    /// never exposed as host/provider telemetry.
    completed_at: Option<Duration>,
    freshness: SlotFreshness,
}

impl Default for SlotRuntimeState {
    fn default() -> Self {
        Self {
            observation: RuntimeProviderState::Unavailable,
            completed_at: None,
            freshness: SlotFreshness::default(),
        }
    }
}

/// Private scheduler metadata. Only `ProviderState` projects its bounded,
/// sanitized fields; no command, path, collector diagnostics, cadence, guard
/// state, source generation, or raw-data identity is retained here.
#[derive(Clone, Default)]
struct SlotFreshness {
    last_attempt_ms: Option<u64>,
    last_success_ms: Option<u64>,
    last_duration_ms: Option<u64>,
    consecutive_failure_count: u32,
    data_revision: Option<SlotDataRevision>,
    /// A private serialization of already-sanitized observable collection
    /// evidence. It is comparison-only and never enters a public envelope.
    data_observable: Option<String>,
    status_reason: Option<ProviderStatusReason>,
}

#[derive(Clone)]
struct SlotDataRevision {
    boot: String,
    sequence: u64,
}

impl SlotDataRevision {
    fn first() -> Self {
        Self {
            boot: boot_instance_component(),
            sequence: 1,
        }
    }

    fn advance(&mut self) {
        self.sequence = self
            .sequence
            .checked_add(1)
            .expect("provider data revision sequence overflow");
    }

    fn public(&self) -> String {
        format!("{}-{}", self.boot, self.sequence)
    }
}

pub(crate) struct ProviderSlotFlights {
    network: Arc<AtomicBool>,
    host: Arc<AtomicBool>,
    systemd: Arc<AtomicBool>,
    python: Arc<AtomicBool>,
    native: Arc<AtomicBool>,
    npm: Arc<AtomicBool>,
}

impl Default for ProviderSlotFlights {
    fn default() -> Self {
        Self {
            network: Arc::new(AtomicBool::new(false)),
            host: Arc::new(AtomicBool::new(false)),
            systemd: Arc::new(AtomicBool::new(false)),
            python: Arc::new(AtomicBool::new(false)),
            native: Arc::new(AtomicBool::new(false)),
            npm: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl ProviderSlotFlights {
    fn for_slot(&self, slot: ProviderSlot) -> Arc<AtomicBool> {
        // The atomics are never individually replaced. The caller needs an
        // Arc for the blocking guard, so the AppState keeps one small map of
        // guards instead of sharing Docker authority or a scheduler API.
        match slot {
            ProviderSlot::NetworkInfrastructure => self.network.clone(),
            ProviderSlot::HostScoped => self.host.clone(),
            ProviderSlot::Systemd => self.systemd.clone(),
            ProviderSlot::PythonProcesses => self.python.clone(),
            ProviderSlot::NativeProcesses => self.native.clone(),
            ProviderSlot::ProjectNpm => self.npm.clone(),
        }
    }

    fn active_count(&self) -> usize {
        [
            &self.network,
            &self.host,
            &self.systemd,
            &self.python,
            &self.native,
            &self.npm,
        ]
        .into_iter()
        .filter(|guard| guard.load(std::sync::atomic::Ordering::Acquire))
        .count()
    }
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
                provider_states: unavailable_provider_states(),
                ..Default::default()
            },
            findings: FindingsResponse::default(),
            runtime_providers: unavailable_provider_slots(),
            source_generation: 0,
            docker_observation_revision: DockerObservationRevision::new(),
            revision: PublicationRevision::new(),
        };
        cache.assign_docker_observation_revision();
        cache.assign_revision();
        cache
    }

    fn assign_revision(&mut self) {
        // All three independently routable model envelopes attest the same
        // publication. Provider state is runtime-topology evidence only.
        self.revision
            .assign(&mut self.snapshot, &mut self.health, &mut self.runtime_map);
        // Findings are a pure projection of the sanitized runtime map, so
        // calculate and cache them only after the publication revision exists.
        self.findings = FindingsResponse {
            findings: derive_findings(&self.runtime_map),
            model_revision: self.runtime_map.model_revision.clone(),
        };
    }

    fn assign_docker_observation_revision(&mut self) {
        self.docker_observation_revision
            .assign(&self.snapshot, &self.health.mode);
    }

    fn docker_observation_token(&self) -> String {
        self.docker_observation_revision.current()
    }

    fn rebuild_runtime_map(&mut self) {
        self.assign_docker_observation_revision();
        let docker_observation_token = self.docker_observation_token();
        self.runtime_map = runtime_map_for_snapshot(
            &self.snapshot,
            &self.health.mode,
            &self.runtime_providers,
            &docker_observation_token,
        );
    }
}

pub(crate) async fn refresh_loop(state: AppState) {
    loop {
        refresh_cache(&state).await;
        sleep(STATIC_REFRESH_INTERVAL).await;
    }
}

pub(crate) async fn refresh_cache(state: &AppState) {
    let (snapshot, mode, source_generation) =
        publish_docker_snapshot_cache(state, collect_snapshot(state).await).await;

    // Publish Docker evidence before running any optional host command. The
    // Spawned slot workers use fixed per-slot guards; they have no route,
    // Docker client, or source-fallback authority.
    if mode == RuntimeMode::Docker {
        let due = claim_due_provider_slots(state, monotonic_now()).await;
        spawn_provider_slots(state.clone(), snapshot, mode, source_generation, due);
    }
}

fn spawn_provider_slots(
    state: AppState,
    snapshot: DockerSnapshot,
    mode: RuntimeMode,
    source_generation: u64,
    slots: Vec<ProviderSlot>,
) {
    for slot in slots {
        let state = state.clone();
        let snapshot = snapshot.clone();
        let mode = mode.clone();
        tokio::spawn(async move {
            let outcome = collect_provider_slot_bounded(
                state.provider_slot_in_flight.for_slot(slot),
                slot,
                &snapshot,
            )
            .await;
            apply_provider_slot_outcome(
                &state,
                slot,
                snapshot,
                mode,
                source_generation,
                outcome,
                monotonic_now(),
            )
            .await;
        });
    }
}

/// Publish a completed Docker read without awaiting optional provider work.
/// Kept separate from gateway collection so deterministic cache tests can
/// exercise source changes and out-of-order provider completion directly.
async fn publish_docker_snapshot_cache(
    state: &AppState,
    mut updated: DaemonCache,
) -> (DockerSnapshot, RuntimeMode, u64) {
    let mut cache = state.cache.write().await;
    // A mock fallback is a distinct source of bytes. Do not retain live host
    // observations and relabel them as sample data (or vice versa).
    let same_source = cache.health.mode == updated.health.mode;
    updated.source_generation = if same_source {
        cache.source_generation
    } else {
        cache
            .source_generation
            .checked_add(1)
            .expect("source generation overflow")
    };
    updated.runtime_providers = if same_source {
        cache.runtime_providers.clone()
    } else {
        source_reset_provider_slots()
    };
    if same_source && !same_collection_evidence(&cache.snapshot, &updated.snapshot) {
        mark_network_observation_stale(&mut updated.runtime_providers);
    }
    updated.docker_observation_revision = cache.docker_observation_revision.clone();
    updated.rebuild_runtime_map();
    updated.revision = cache.revision.clone();
    updated.assign_revision();
    *cache = updated;
    (
        cache.snapshot.clone(),
        cache.health.mode.clone(),
        cache.source_generation,
    )
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
                    findings: FindingsResponse::default(),
                    runtime_providers: unavailable_provider_slots(),
                    source_generation: 0,
                    docker_observation_revision: DockerObservationRevision::new(),
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

const MAX_CONCURRENT_PROVIDER_SLOTS: usize = 2;

fn monotonic_now() -> Duration {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed()
}

/// The public contract uses Unix milliseconds for browser age calculations.
/// A system clock before the Unix epoch is represented as absent rather than
/// wrapping or emitting an unsafe number.
fn wall_clock_millis() -> Option<u64> {
    const MAX_SAFE_JS_INTEGER: u128 = 9_007_199_254_740_991;
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis();
    (millis <= MAX_SAFE_JS_INTEGER).then_some(millis as u64)
}

fn successful_duration_ms(attempt_ms: Option<u64>, completed_ms: Option<u64>) -> Option<u64> {
    Some(completed_ms?.saturating_sub(attempt_ms?))
}

fn unavailable_provider_slots() -> RuntimeProviderSlots {
    STATIC_PROVIDER_SLOTS
        .iter()
        .copied()
        .map(|slot| (slot, SlotRuntimeState::default()))
        .collect()
}

fn source_reset_provider_slots() -> RuntimeProviderSlots {
    let mut slots = unavailable_provider_slots();
    for slot in slots.values_mut() {
        // A source flip deliberately drops all retained live/mock evidence and
        // its opaque identity. The reason says only that a source reset
        // happened; it leaks neither source generation nor host details.
        slot.freshness.status_reason = Some(ProviderStatusReason::SourceReset);
    }
    slots
}

/// Claims immediately due fixed slots, capped by the policy's total worker
/// bound. A collection is due on first startup or only after its completion
/// interval; slow/timeout work never creates catch-up runs.
#[cfg(test)]
fn claim_due_slots(
    slots: &mut RuntimeProviderSlots,
    now: Duration,
    max_concurrency: usize,
) -> Vec<ProviderSlot> {
    claim_due_slots_with_active_workers(slots, now, max_concurrency, 0)
}

fn claim_due_slots_with_active_workers(
    slots: &mut RuntimeProviderSlots,
    now: Duration,
    max_concurrency: usize,
    active_workers: usize,
) -> Vec<ProviderSlot> {
    let occupied = slots
        .values()
        .filter(|slot| matches!(slot.observation, RuntimeProviderState::Collecting(_)))
        .count();
    // Cache state can be TimedOut while its blocking worker still unwinds.
    // Count the guards as well as publication state, taking the larger value
    // to avoid double-counting a normal collecting worker.
    let mut remaining = max_concurrency.saturating_sub(occupied.max(active_workers));
    let mut claimed = Vec::new();
    for slot in STATIC_PROVIDER_SLOTS.iter().copied() {
        if remaining == 0 {
            break;
        }
        let current = slots.get_mut(&slot).expect("fixed slot state exists");
        if matches!(current.observation, RuntimeProviderState::Collecting(_)) {
            continue;
        }
        let due = current
            .completed_at
            .map(|at| now.saturating_sub(at) >= slot_interval(slot))
            .unwrap_or(true);
        if !due {
            continue;
        }
        // Disabled is a profile fact. It is allowed one initial probe so the
        // diagnostic is observable, but is never queued thereafter.
        if matches!(current.observation, RuntimeProviderState::Fresh(ref collection) if collection.states().iter().any(|state| state.slot == slot && state.state == ProviderStateKind::Disabled))
        {
            continue;
        }
        let retained = retained_collection(&current.observation);
        current.observation = RuntimeProviderState::Collecting(retained);
        current.freshness.last_attempt_ms = wall_clock_millis();
        current.freshness.status_reason = Some(ProviderStatusReason::Refreshing);
        claimed.push(slot);
        remaining -= 1;
    }
    claimed
}

async fn claim_due_provider_slots(state: &AppState, now: Duration) -> Vec<ProviderSlot> {
    let mut cache = state.cache.write().await;
    let due = claim_due_slots_with_active_workers(
        &mut cache.runtime_providers,
        now,
        MAX_CONCURRENT_PROVIDER_SLOTS,
        state.provider_slot_in_flight.active_count(),
    );
    if !due.is_empty() {
        cache.rebuild_runtime_map();
        cache.assign_revision();
    }
    due
}

fn retained_collection(state: &RuntimeProviderState) -> Option<ProviderCollection> {
    match state {
        RuntimeProviderState::Fresh(collection)
        | RuntimeProviderState::Collecting(Some(collection))
        | RuntimeProviderState::Degraded(Some(collection))
        | RuntimeProviderState::TimedOut(Some(collection)) => Some(collection.clone()),
        _ => None,
    }
}

async fn apply_provider_slot_outcome(
    state: &AppState,
    slot: ProviderSlot,
    observed_snapshot: DockerSnapshot,
    observed_mode: RuntimeMode,
    observed_generation: u64,
    outcome: ProviderCollectionOutcome,
    completed_at: Duration,
) {
    let mut cache = state.cache.write().await;
    // Never apply observations across a live/mock transition. The current
    // map remains explicitly unavailable until a collection for that source
    // completes.
    if cache.health.mode != observed_mode || cache.source_generation != observed_generation {
        return;
    }
    let same_evidence = same_collection_evidence(&cache.snapshot, &observed_snapshot);
    let Some(slot_state) = cache.runtime_providers.get_mut(&slot) else {
        return;
    };
    match outcome {
        ProviderCollectionOutcome::Collected(collection) if same_evidence => {
            let collection = collection.sanitized_for_retention();
            update_slot_data_revision(&mut slot_state.freshness, &collection);
            let completed_ms = wall_clock_millis();
            slot_state.freshness.last_success_ms = completed_ms;
            slot_state.freshness.last_duration_ms =
                successful_duration_ms(slot_state.freshness.last_attempt_ms, completed_ms);
            slot_state.freshness.consecutive_failure_count = 0;
            slot_state.freshness.status_reason = None;
            slot_state.observation = RuntimeProviderState::Fresh(collection);
            slot_state.completed_at = Some(completed_at);
        }
        ProviderCollectionOutcome::Collected(collection) => {
            // Docker changed while the bounded optional pass was in flight.
            // Preserve it only as explicitly stale evidence; the next tick
            // collects against the new snapshot.
            let collection = collection.sanitized_for_retention();
            update_slot_data_revision(&mut slot_state.freshness, &collection);
            // This is still a successful bounded collection, but its evidence
            // is stale relative to Docker. Preserve its completion metadata
            // without pretending its observations are fresh.
            let completed_ms = wall_clock_millis();
            slot_state.freshness.last_success_ms = completed_ms;
            slot_state.freshness.last_duration_ms =
                successful_duration_ms(slot_state.freshness.last_attempt_ms, completed_ms);
            slot_state.freshness.consecutive_failure_count = 0;
            slot_state.freshness.status_reason = None;
            slot_state.observation = RuntimeProviderState::Degraded(Some(collection));
            slot_state.completed_at = Some(completed_at);
        }
        // A prior timed-out worker still owns the per-slot guard. Restore an
        // explicit timeout state rather than leaving a false `collecting`
        // claim forever; its next retry remains completion-relative.
        ProviderCollectionOutcome::InFlight => {
            let retained = retained_collection(&slot_state.observation);
            slot_state.observation = RuntimeProviderState::TimedOut(retained);
            slot_state.freshness.consecutive_failure_count = slot_state
                .freshness
                .consecutive_failure_count
                .saturating_add(1);
            slot_state.freshness.status_reason = Some(ProviderStatusReason::CollectionTimedOut);
        }
        ProviderCollectionOutcome::Failed | ProviderCollectionOutcome::TimedOut => {
            let retained = retained_collection(&slot_state.observation);
            slot_state.observation = if matches!(outcome, ProviderCollectionOutcome::TimedOut) {
                RuntimeProviderState::TimedOut(retained)
            } else {
                RuntimeProviderState::Degraded(retained)
            };
            slot_state.freshness.consecutive_failure_count = slot_state
                .freshness
                .consecutive_failure_count
                .saturating_add(1);
            slot_state.freshness.status_reason =
                Some(if matches!(outcome, ProviderCollectionOutcome::TimedOut) {
                    ProviderStatusReason::CollectionTimedOut
                } else {
                    ProviderStatusReason::CollectionFailed
                });
            slot_state.completed_at = Some(completed_at);
        }
    }
    cache.rebuild_runtime_map();
    cache.assign_revision();
    let current_snapshot = cache.snapshot.clone();
    let current_mode = cache.health.mode.clone();
    drop(cache);
    // If an initial fast slot finished, admit the next initial slot without
    // waiting for the two-second Docker tick. This remains globally bounded.
    if current_mode == RuntimeMode::Docker {
        let due = claim_due_provider_slots(state, monotonic_now()).await;
        spawn_provider_slots(
            state.clone(),
            current_snapshot,
            current_mode,
            cache_generation(state).await,
            due,
        );
    }
}

fn update_slot_data_revision(freshness: &mut SlotFreshness, collection: &ProviderCollection) {
    let observable = collection.sanitized_observable_identity();
    if freshness.data_observable.as_deref() == Some(observable.as_str()) {
        return;
    }
    match freshness.data_revision.as_mut() {
        Some(revision) => revision.advance(),
        None => freshness.data_revision = Some(SlotDataRevision::first()),
    }
    freshness.data_observable = Some(observable);
}

async fn cache_generation(state: &AppState) -> u64 {
    state.cache.read().await.source_generation
}

fn mark_network_observation_stale(slots: &mut RuntimeProviderSlots) {
    let network = slots
        .get_mut(&ProviderSlot::NetworkInfrastructure)
        .expect("fixed network slot exists");
    if let RuntimeProviderState::Fresh(collection) = &network.observation {
        network.observation = RuntimeProviderState::Degraded(Some(collection.clone()));
    }
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

fn runtime_map_for_snapshot(
    snapshot: &DockerSnapshot,
    mode: &RuntimeMode,
    slots: &RuntimeProviderSlots,
    docker_observation_revision: &str,
) -> RuntimeMap {
    let mut combined = ProviderCollection::default();
    let mut extra_diagnostics = Vec::new();
    for slot in STATIC_PROVIDER_SLOTS.iter().copied() {
        let slot_state = &slots[&slot];
        let observation = &slot_state.observation;
        if let Some(collection) = retained_collection(observation) {
            let (nodes, mut edges, diagnostics) = collection.into_parts();
            if slot == ProviderSlot::Systemd {
                bind_systemd_evidence(&mut edges, slot_state);
            } else if slot == ProviderSlot::ProjectNpm {
                bind_npm_evidence(&mut edges, slot_state);
            }
            let (target_nodes, target_edges, target_diagnostics) = combined.parts_mut();
            target_nodes.extend(nodes);
            target_edges.extend(edges);
            target_diagnostics.extend(diagnostics);
        }
        if !matches!(observation, RuntimeProviderState::Fresh(_)) {
            extra_diagnostics.push(RuntimeMapDiagnostic {
                provider: RuntimeProviderKind::Other,
                severity: DiagnosticSeverity::Warning,
                message: slot_diagnostic(slot, observation).into(),
            });
        }
    }
    let mut runtime_map =
        runtime_map_from_collection(snapshot, &combined, docker_observation_revision, mode);
    runtime_map.provider_states = provider_states_for(slots);
    runtime_map.diagnostics.extend(extra_diagnostics);
    runtime_map
}

/// Convert the private NPM manifest marker into public evidence only after
/// this exact ProjectNpm slot has a sanitized opaque revision and successful
/// collection timestamp. Retention is explicit: stale/timed-out observations
/// remain labelled as such, while disabled, unavailable, revision-less, and
/// source-reset observations publish no NPM evidence.
fn bind_npm_evidence(edges: &mut [RuntimeMapEdge], state: &SlotRuntimeState) {
    let disabled = retained_collection(&state.observation)
        .as_ref()
        .is_some_and(|collection| {
            collection.states().iter().any(|candidate| {
                candidate.slot == ProviderSlot::ProjectNpm
                    && candidate.state == ProviderStateKind::Disabled
            })
        });
    let freshness = match &state.observation {
        RuntimeProviderState::Fresh(_) => RuntimeEvidenceFreshness::Fresh,
        RuntimeProviderState::Collecting(Some(_)) | RuntimeProviderState::Degraded(Some(_)) => {
            RuntimeEvidenceFreshness::Stale
        }
        RuntimeProviderState::TimedOut(Some(_)) => RuntimeEvidenceFreshness::TimedOut,
        RuntimeProviderState::Unavailable
        | RuntimeProviderState::Collecting(None)
        | RuntimeProviderState::Degraded(None)
        | RuntimeProviderState::TimedOut(None) => {
            clear_npm_evidence(edges);
            return;
        }
    };
    if disabled {
        clear_npm_evidence(edges);
        return;
    }
    let Some(revision) = state
        .freshness
        .data_revision
        .as_ref()
        .map(SlotDataRevision::public)
    else {
        clear_npm_evidence(edges);
        return;
    };
    let Some(collected_at) = state.freshness.last_success_ms else {
        clear_npm_evidence(edges);
        return;
    };

    for edge in edges {
        let marker = edge.metadata.remove(NPM_EVIDENCE_DEPENDENCY_MARKER);
        if marker.as_deref() != Some("declared")
            || edge.relationship != dockermap_core::RuntimeRelationshipKind::DependsOn
            || !edge.source.starts_with("npm_project_")
            || !edge.target.starts_with("npm_package_")
            || edge.source == edge.target
        {
            edge.evidence_refs.clear();
            continue;
        }
        edge.evidence_refs = vec![RuntimeEvidenceRef {
            version: 3,
            id: format!(
                "npm_evidence_manifest_dependency_{}",
                collision_resistant_id_component(&format!("{}\u{1f}{}", edge.source, edge.target))
            ),
            provider: RuntimeEvidenceProvider::Npm,
            kind: RuntimeEvidenceKind::NpmPackageManifestDependency,
            assertion_kind: RuntimeEvidenceAssertionKind::Declared,
            summary: "package manifest declared a dependency".into(),
            subject_ref: edge.source.clone(),
            collected_at,
            provider_revision: revision.clone(),
            provider_slot: Some(ProviderSlot::ProjectNpm),
            freshness,
        }];
    }
}

fn clear_npm_evidence(edges: &mut [RuntimeMapEdge]) {
    for edge in edges {
        edge.metadata.remove(NPM_EVIDENCE_DEPENDENCY_MARKER);
        edge.evidence_refs.clear();
    }
}

/// Convert the private, closed systemd dependency marker into public evidence
/// only after this exact slot completed and owns a sanitized opaque revision.
/// Retained observations deliberately become stale/timed-out evidence instead
/// of being relabelled as fresh; a disabled or revision-less observation emits
/// no evidence at all.
fn bind_systemd_evidence(edges: &mut [RuntimeMapEdge], state: &SlotRuntimeState) {
    let is_disabled = retained_collection(&state.observation)
        .as_ref()
        .map(|collection| {
            collection.states().iter().any(|candidate| {
                candidate.slot == ProviderSlot::Systemd
                    && candidate.state == ProviderStateKind::Disabled
            })
        })
        .unwrap_or(false);
    if is_disabled {
        for edge in edges {
            edge.metadata.remove(SYSTEMD_EVIDENCE_KIND_MARKER);
            edge.evidence_refs.clear();
        }
        return;
    }
    let freshness = match &state.observation {
        RuntimeProviderState::Fresh(_) => RuntimeEvidenceFreshness::Fresh,
        RuntimeProviderState::Collecting(Some(_)) | RuntimeProviderState::Degraded(Some(_)) => {
            RuntimeEvidenceFreshness::Stale
        }
        RuntimeProviderState::TimedOut(Some(_)) => RuntimeEvidenceFreshness::TimedOut,
        RuntimeProviderState::Unavailable
        | RuntimeProviderState::Collecting(None)
        | RuntimeProviderState::Degraded(None)
        | RuntimeProviderState::TimedOut(None) => {
            for edge in edges {
                edge.metadata.remove(SYSTEMD_EVIDENCE_KIND_MARKER);
                edge.evidence_refs.clear();
            }
            return;
        }
    };
    let Some(revision) = state
        .freshness
        .data_revision
        .as_ref()
        .map(SlotDataRevision::public)
    else {
        for edge in edges {
            edge.metadata.remove(SYSTEMD_EVIDENCE_KIND_MARKER);
            edge.evidence_refs.clear();
        }
        return;
    };
    let Some(collected_at) = state.freshness.last_success_ms else {
        for edge in edges {
            edge.metadata.remove(SYSTEMD_EVIDENCE_KIND_MARKER);
            edge.evidence_refs.clear();
        }
        return;
    };

    for edge in edges {
        let kind = match edge
            .metadata
            .remove(SYSTEMD_EVIDENCE_KIND_MARKER)
            .as_deref()
        {
            Some(SYSTEMD_EVIDENCE_REQUIRES) => RuntimeEvidenceKind::SystemdRequires,
            Some(SYSTEMD_EVIDENCE_WANTS) => RuntimeEvidenceKind::SystemdWants,
            Some(SYSTEMD_EVIDENCE_PART_OF) => RuntimeEvidenceKind::SystemdPartOf,
            _ => {
                edge.evidence_refs.clear();
                continue;
            }
        };
        let expected_relationship = match kind {
            RuntimeEvidenceKind::SystemdRequires => {
                dockermap_core::RuntimeRelationshipKind::Requires
            }
            RuntimeEvidenceKind::SystemdWants => dockermap_core::RuntimeRelationshipKind::Wants,
            RuntimeEvidenceKind::SystemdPartOf => dockermap_core::RuntimeRelationshipKind::PartOf,
            _ => unreachable!("closed systemd marker maps only to systemd evidence"),
        };
        if edge.relationship != expected_relationship
            || !edge.source.starts_with("systemd_service_")
            || !edge.target.starts_with("systemd_service_")
            || edge.source == edge.target
        {
            edge.evidence_refs.clear();
            continue;
        }
        let kind_id = match kind {
            RuntimeEvidenceKind::SystemdRequires => "requires",
            RuntimeEvidenceKind::SystemdWants => "wants",
            RuntimeEvidenceKind::SystemdPartOf => "part-of",
            _ => unreachable!("closed systemd marker maps only to systemd evidence"),
        };
        edge.evidence_refs = vec![RuntimeEvidenceRef {
            version: 2,
            id: format!(
                "systemd_evidence_{kind_id}_{}",
                collision_resistant_id_component(&format!("{}\u{1f}{}", edge.source, edge.target))
            ),
            provider: RuntimeEvidenceProvider::Systemd,
            kind,
            assertion_kind: RuntimeEvidenceAssertionKind::Declared,
            summary: match kind {
                RuntimeEvidenceKind::SystemdRequires => "systemd declared a Requires dependency",
                RuntimeEvidenceKind::SystemdWants => "systemd declared a Wants dependency",
                RuntimeEvidenceKind::SystemdPartOf => "systemd declared a PartOf dependency",
                _ => unreachable!("closed systemd marker maps only to systemd evidence"),
            }
            .into(),
            subject_ref: edge.source.clone(),
            collected_at,
            provider_revision: revision.clone(),
            provider_slot: Some(ProviderSlot::Systemd),
            freshness,
        }];
    }
}

fn slot_diagnostic(_slot: ProviderSlot, state: &RuntimeProviderState) -> &'static str {
    match state {
        RuntimeProviderState::Collecting(Some(_)) => "Runtime provider slot refresh is in progress; serving retained observations (stale)",
        RuntimeProviderState::Collecting(None) => "Runtime provider slot refresh is in progress; no successful observations are available",
        RuntimeProviderState::Degraded(Some(_)) => "Runtime provider slot refresh failed or observed older Docker evidence; serving retained observations (stale)",
        RuntimeProviderState::Degraded(None) => "Runtime provider slot refresh failed; no successful observations are available",
        RuntimeProviderState::TimedOut(Some(_)) => "Runtime provider slot refresh timed out; serving retained observations (stale)",
        RuntimeProviderState::TimedOut(None) => "Runtime provider slot refresh timed out; no successful observations are available",
        RuntimeProviderState::Unavailable => "Runtime provider observations are unavailable until the first successful collection",
        RuntimeProviderState::Fresh(_) => unreachable!("fresh slots have no degradation diagnostic"),
    }
}

fn unavailable_provider_states() -> Vec<ProviderState> {
    STATIC_PROVIDER_SLOTS
        .iter()
        .copied()
        .map(|slot| ProviderState {
            slot,
            state: ProviderStateKind::Unavailable,
            last_attempt_ms: None,
            last_success_ms: None,
            last_duration_ms: None,
            consecutive_failure_count: 0,
            data_revision: None,
            status_reason: None,
        })
        .collect()
}

/// Retained successful slots stay explicitly stale while a new attempt runs or
/// after a failed attempt. Disabled slots are configuration/profile facts, not
/// transient freshness states, and remain disabled through those transitions.
fn provider_states_for(slots: &RuntimeProviderSlots) -> Vec<ProviderState> {
    STATIC_PROVIDER_SLOTS
        .iter()
        .copied()
        .map(|slot| {
            let observation = &slots[&slot].observation;
            let base = retained_collection(observation)
                .as_ref()
                .map(|collection| collection.states())
                .unwrap_or(&[])
                .iter()
                .find(|candidate| candidate.slot == slot)
                .map(|candidate| candidate.state)
                .unwrap_or(ProviderStateKind::Unavailable);
            let state = match observation {
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
            let freshness = &slots[&slot].freshness;
            let disabled = state == ProviderStateKind::Disabled;
            ProviderState {
                slot,
                state,
                last_attempt_ms: freshness.last_attempt_ms,
                last_success_ms: freshness.last_success_ms,
                last_duration_ms: freshness.last_duration_ms,
                consecutive_failure_count: freshness.consecutive_failure_count,
                data_revision: freshness
                    .data_revision
                    .as_ref()
                    .map(SlotDataRevision::public),
                status_reason: if disabled {
                    Some(ProviderStatusReason::Disabled)
                } else {
                    freshness.status_reason
                },
            }
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
        provider_states: unavailable_provider_states(),
        ..Default::default()
    }
}

#[cfg(test)]
mod scheduler_tests {
    use super::*;
    use crate::provider_contract::ProviderDiagnostic;
    use dockermap_core::{
        mock_snapshot, ComposeMountKind, ContainerMount, HealthState, RuntimeMapNode,
        RuntimeNodeKind, RuntimeNodeLayer, RuntimeProviderKind,
    };
    use std::{
        collections::BTreeMap as TestBTreeMap, fs, os::unix::fs::PermissionsExt, process::Command,
    };

    // Before Systemd was extracted into its own independently scheduled slot,
    // every two-second pass ran these five aggregate collection bundles.
    const LEGACY_AGGREGATE_SLOT_COUNT: u64 = 5;

    const SCHEDULER_CHURN_CHILD_ENV: &str = "DOCKERMAP_SCHEDULER_CHURN_CHILD";
    const SCHEDULER_CHURN_ATTESTATION_PATH_ENV: &str = "DOCKERMAP_SCHEDULER_CHURN_ATTESTATION_PATH";
    const SCHEDULER_CHURN_ATTESTATION_TOKEN_ENV: &str =
        "DOCKERMAP_SCHEDULER_CHURN_ATTESTATION_TOKEN";

    fn new_scheduler_churn_attestation() -> String {
        let mut bytes = [0_u8; 32];
        getrandom::fill(&mut bytes).expect("OS CSPRNG for isolated test attestation");
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    /// A test child may run real collectors only after its parent creates an
    /// unguessable, temporary file attestation and passes the matching token.
    /// An ambient profile flag is deliberately insufficient: it returns to
    /// the test harness without starting a collector.
    fn attested_scheduler_churn_profile() -> Option<String> {
        let profile = std::env::var(SCHEDULER_CHURN_CHILD_ENV).ok()?;
        let path = std::env::var(SCHEDULER_CHURN_ATTESTATION_PATH_ENV).ok()?;
        let token = std::env::var(SCHEDULER_CHURN_ATTESTATION_TOKEN_ENV).ok()?;
        let stored = fs::read_to_string(path).ok()?;
        (scheduler_churn_attestation_matches(&profile, &token, &stored)
            && scheduler_churn_parent_is_current_test_exe())
        .then_some(profile)
    }

    fn scheduler_churn_attestation_matches(profile: &str, token: &str, stored: &str) -> bool {
        matches!(profile, "full-host" | "restricted") && token.len() == 64 && stored == token
    }

    /// Linux-only test-child lineage guard. `Command::new(current_exe())`
    /// makes the parent executable the same test binary. An ambient process
    /// (including Cargo, a shell, or a CI wrapper) cannot satisfy this just by
    /// creating a token-shaped file and exporting matching variables.
    fn scheduler_churn_parent_is_current_test_exe() -> bool {
        let Ok(current) = std::env::current_exe().and_then(fs::canonicalize) else {
            return false;
        };
        let Ok(status) = fs::read_to_string("/proc/self/status") else {
            return false;
        };
        let Some(parent_pid) = status
            .lines()
            .find_map(|line| line.strip_prefix("PPid:")?.trim().parse::<u32>().ok())
        else {
            return false;
        };
        fs::canonicalize(format!("/proc/{parent_pid}/exe"))
            .map(|parent| parent == current)
            .unwrap_or(false)
    }

    fn slots() -> RuntimeProviderSlots {
        unavailable_provider_slots()
    }

    fn marked_systemd_dependency() -> ProviderCollection {
        let mut collection = ProviderCollection::default();
        collection.set_state(ProviderSlot::Systemd, ProviderStateKind::Fresh);
        for (id, label) in [
            ("systemd_service_application", "application"),
            ("systemd_service_database", "database"),
        ] {
            collection.nodes_mut().push(RuntimeMapNode {
                id: id.into(),
                provider: RuntimeProviderKind::Systemd,
                kind: RuntimeNodeKind::SystemdService,
                label: label.into(),
                status: Some(
                    if id == "systemd_service_application" {
                        "active"
                    } else {
                        "failed"
                    }
                    .into(),
                ),
                layer: Some(RuntimeNodeLayer::Service),
                metadata: BTreeMap::new(),
                service: None,
                package: None,
            });
        }
        collection.parts_mut().1.push(RuntimeMapEdge {
            source: "systemd_service_application".into(),
            target: "systemd_service_database".into(),
            relationship: dockermap_core::RuntimeRelationshipKind::Requires,
            metadata: BTreeMap::from([(
                SYSTEMD_EVIDENCE_KIND_MARKER.into(),
                SYSTEMD_EVIDENCE_REQUIRES.into(),
            )]),
            evidence_refs: Vec::new(),
        });
        collection
    }

    fn marked_npm_dependency() -> ProviderCollection {
        let mut collection = ProviderCollection::default();
        collection.set_state(ProviderSlot::ProjectNpm, ProviderStateKind::Fresh);
        for (id, label, kind) in [
            (
                "npm_project_application",
                "application",
                RuntimeNodeKind::Package,
            ),
            (
                "npm_package_dependency",
                "dependency",
                RuntimeNodeKind::PackageDependency,
            ),
        ] {
            collection.nodes_mut().push(RuntimeMapNode {
                id: id.into(),
                provider: RuntimeProviderKind::Npm,
                kind,
                label: label.into(),
                status: None,
                layer: Some(RuntimeNodeLayer::Package),
                metadata: BTreeMap::new(),
                service: None,
                package: None,
            });
        }
        collection.parts_mut().1.push(RuntimeMapEdge {
            source: "npm_project_application".into(),
            target: "npm_package_dependency".into(),
            relationship: dockermap_core::RuntimeRelationshipKind::DependsOn,
            metadata: BTreeMap::from([(NPM_EVIDENCE_DEPENDENCY_MARKER.into(), "declared".into())]),
            evidence_refs: Vec::new(),
        });
        collection
    }

    #[test]
    fn systemd_evidence_is_slot_bound_and_truthfully_retained() {
        for (observation, expected) in [
            (
                RuntimeProviderState::Fresh(marked_systemd_dependency()),
                RuntimeEvidenceFreshness::Fresh,
            ),
            (
                RuntimeProviderState::Degraded(Some(marked_systemd_dependency())),
                RuntimeEvidenceFreshness::Stale,
            ),
            (
                RuntimeProviderState::TimedOut(Some(marked_systemd_dependency())),
                RuntimeEvidenceFreshness::TimedOut,
            ),
        ] {
            let mut slots = slots();
            let state = slots.get_mut(&ProviderSlot::Systemd).unwrap();
            state.observation = observation;
            state.freshness.data_revision = Some(SlotDataRevision::first());
            state.freshness.last_success_ms = Some(42);
            let map = runtime_map_for_snapshot(
                &mock_snapshot(),
                &RuntimeMode::Docker,
                &slots,
                "docker-observation",
            );
            let edge = map
                .edges
                .iter()
                .find(|edge| edge.source == "systemd_service_application")
                .expect("systemd relationship is retained");
            assert!(edge.metadata.is_empty(), "private marker never publishes");
            assert_eq!(edge.evidence_refs.len(), 1);
            let evidence = &edge.evidence_refs[0];
            assert_eq!(evidence.version, 2);
            assert_eq!(evidence.provider, RuntimeEvidenceProvider::Systemd);
            assert_eq!(evidence.kind, RuntimeEvidenceKind::SystemdRequires);
            assert_eq!(
                edge.relationship,
                dockermap_core::RuntimeRelationshipKind::Requires
            );
            assert_eq!(
                evidence.assertion_kind,
                RuntimeEvidenceAssertionKind::Declared
            );
            assert_eq!(evidence.provider_slot, Some(ProviderSlot::Systemd));
            assert_eq!(evidence.collected_at, 42);
            assert_eq!(evidence.freshness, expected);
            assert!(!evidence.provider_revision.is_empty());
        }
    }

    #[test]
    fn npm_manifest_evidence_is_slot_bound_redacted_and_truthfully_retained() {
        for (observation, expected) in [
            (
                RuntimeProviderState::Fresh(marked_npm_dependency()),
                RuntimeEvidenceFreshness::Fresh,
            ),
            (
                RuntimeProviderState::Degraded(Some(marked_npm_dependency())),
                RuntimeEvidenceFreshness::Stale,
            ),
            (
                RuntimeProviderState::TimedOut(Some(marked_npm_dependency())),
                RuntimeEvidenceFreshness::TimedOut,
            ),
        ] {
            let mut slots = slots();
            let state = slots.get_mut(&ProviderSlot::ProjectNpm).unwrap();
            state.observation = observation;
            state.freshness.data_revision = Some(SlotDataRevision::first());
            state.freshness.last_success_ms = Some(42);
            let map = runtime_map_for_snapshot(
                &mock_snapshot(),
                &RuntimeMode::Docker,
                &slots,
                "docker-observation",
            );
            let edge = map
                .edges
                .iter()
                .find(|edge| edge.source == "npm_project_application")
                .expect("npm dependency remains visible");
            assert!(edge.metadata.is_empty(), "private marker never publishes");
            assert_eq!(edge.evidence_refs.len(), 1);
            let evidence = &edge.evidence_refs[0];
            assert_eq!(evidence.version, 3);
            assert_eq!(evidence.provider, RuntimeEvidenceProvider::Npm);
            assert_eq!(
                evidence.kind,
                RuntimeEvidenceKind::NpmPackageManifestDependency
            );
            assert_eq!(
                evidence.assertion_kind,
                RuntimeEvidenceAssertionKind::Declared
            );
            assert_eq!(evidence.provider_slot, Some(ProviderSlot::ProjectNpm));
            assert_eq!(evidence.freshness, expected);
            assert_eq!(evidence.summary, "package manifest declared a dependency");
            assert!(!evidence.summary.contains("package.json"));
        }
    }

    #[test]
    fn npm_manifest_marker_cannot_publish_without_success_revision_or_after_source_reset() {
        let mut provider_slots = slots();
        let state = provider_slots.get_mut(&ProviderSlot::ProjectNpm).unwrap();
        state.observation = RuntimeProviderState::Fresh(marked_npm_dependency());
        let map = runtime_map_for_snapshot(
            &mock_snapshot(),
            &RuntimeMode::Docker,
            &provider_slots,
            "docker-observation",
        );
        let npm_edges = map
            .edges
            .iter()
            .filter(|edge| edge.source.starts_with("npm_project_"))
            .collect::<Vec<_>>();
        assert!(npm_edges.iter().all(|edge| edge.evidence_refs.is_empty()));
        assert!(npm_edges.iter().all(|edge| edge.metadata.is_empty()));

        let mut disabled = slots();
        let state = disabled.get_mut(&ProviderSlot::ProjectNpm).unwrap();
        let mut collection = marked_npm_dependency();
        collection.set_state(ProviderSlot::ProjectNpm, ProviderStateKind::Disabled);
        state.observation = RuntimeProviderState::Fresh(collection);
        state.freshness.data_revision = Some(SlotDataRevision::first());
        state.freshness.last_success_ms = Some(42);
        let map = runtime_map_for_snapshot(
            &mock_snapshot(),
            &RuntimeMode::Docker,
            &disabled,
            "docker-observation",
        );
        assert!(map
            .edges
            .iter()
            .filter(|edge| edge.source.starts_with("npm_project_"))
            .all(|edge| edge.evidence_refs.is_empty() && edge.metadata.is_empty()));

        let mut reset = source_reset_provider_slots();
        let state = reset.get_mut(&ProviderSlot::ProjectNpm).unwrap();
        state.observation = RuntimeProviderState::Unavailable;
        let map = runtime_map_for_snapshot(
            &mock_snapshot(),
            &RuntimeMode::Docker,
            &reset,
            "docker-observation",
        );
        assert!(map
            .edges
            .iter()
            .filter(|edge| edge.source.starts_with("npm_project_"))
            .all(|edge| edge.evidence_refs.is_empty()));
    }

    #[test]
    fn findings_are_cached_only_after_the_runtime_map_revision_is_published() {
        let mut cache = docker_cache(mock_snapshot());
        let mut provider_slots = slots();
        let state = provider_slots.get_mut(&ProviderSlot::Systemd).unwrap();
        state.observation = RuntimeProviderState::Fresh(marked_systemd_dependency());
        state.freshness.data_revision = Some(SlotDataRevision::first());
        state.freshness.last_success_ms = Some(42);
        cache.runtime_providers = provider_slots;
        cache.rebuild_runtime_map();
        assert!(cache.runtime_map.model_revision.is_empty());
        assert!(cache.findings.model_revision.is_empty());

        cache.assign_revision();

        assert_eq!(
            cache.findings.model_revision,
            cache.runtime_map.model_revision
        );
        let finding = cache
            .findings
            .findings
            .iter()
            .find(|finding| {
                finding.rule_id == dockermap_core::FindingRule::SystemdRequiresTargetNotActive
            })
            .expect("fresh systemd evidence produces its warning alongside other cached findings");
        assert_eq!(finding.evidence_refs.len(), 1);
        assert_eq!(finding.evidence_refs[0].version, 2);
        let serialized = serde_json::to_string(finding).unwrap();
        assert!(serialized.contains("evidenceRefs"));
        assert!(serialized.contains("systemd_requires"));

        let docker_finding = cache
            .findings
            .findings
            .iter()
            .find(|finding| {
                finding.rule_id
                    == dockermap_core::FindingRule::DockerInternalNetworkMemberPublishesPort
            })
            .expect("a Docker-mode representative topology produces the bounded internal-network advisory");
        assert_eq!(docker_finding.evidence_refs.len(), 2);
        assert_eq!(
            docker_finding.evidence_refs[0].kind,
            RuntimeEvidenceKind::DockerNetworkMembership
        );
        assert_eq!(
            docker_finding.evidence_refs[1].kind,
            RuntimeEvidenceKind::DockerPortPublication
        );
    }

    #[test]
    fn daemon_state_bind_mount_finding_is_cached_after_publication() {
        let mut snapshot = mock_snapshot();
        snapshot.containers[0].mounts = vec![ContainerMount {
            id: "private-mount-id".into(),
            kind: ComposeMountKind::Bind,
            source: Some("/private/DOCKERMAP_TEST_DAEMON_STATE/docker.sock".into()),
            target: "/private/target".into(),
            read_only: true,
        }];
        let mut cache = docker_cache(snapshot);
        cache.rebuild_runtime_map();
        cache.assign_revision();
        let finding = cache
            .findings
            .findings
            .iter()
            .find(|finding| {
                finding.rule_id == dockermap_core::FindingRule::DockerDaemonStateBindMount
            })
            .expect("cached runtime map produces the daemon-state warning");
        assert_eq!(finding.evidence_refs.len(), 1);
        assert_eq!(
            finding.evidence_refs[0].kind,
            RuntimeEvidenceKind::DockerDaemonStateBindMount
        );
        let serialized = serde_json::to_string(finding).unwrap();
        for forbidden in [
            "DOCKERMAP_TEST_DAEMON_STATE",
            "/private/target",
            "private-mount-id",
            "readOnly",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "cached finding leaked {forbidden}"
            );
        }
    }

    #[test]
    fn revisionless_or_disabled_systemd_collection_cannot_publish_evidence() {
        let mut slots = slots();
        slots.get_mut(&ProviderSlot::Systemd).unwrap().observation =
            RuntimeProviderState::Fresh(marked_systemd_dependency());
        let map = runtime_map_for_snapshot(
            &mock_snapshot(),
            &RuntimeMode::Docker,
            &slots,
            "docker-observation",
        );
        let edge = map
            .edges
            .iter()
            .find(|edge| edge.source == "systemd_service_application")
            .expect("systemd relationship remains visible without evidence");
        assert!(edge.evidence_refs.is_empty());
        assert!(edge.metadata.is_empty());

        let mut disabled = marked_systemd_dependency();
        disabled.set_state(ProviderSlot::Systemd, ProviderStateKind::Disabled);
        let state = slots.get_mut(&ProviderSlot::Systemd).unwrap();
        state.observation = RuntimeProviderState::Fresh(disabled);
        state.freshness.data_revision = Some(SlotDataRevision::first());
        state.freshness.last_success_ms = Some(42);
        let map = runtime_map_for_snapshot(
            &mock_snapshot(),
            &RuntimeMode::Docker,
            &slots,
            "docker-observation",
        );
        assert!(map
            .edges
            .iter()
            .find(|edge| edge.source == "systemd_service_application")
            .expect("disabled systemd relationship remains visible without evidence")
            .evidence_refs
            .is_empty());
    }

    fn docker_cache(snapshot: DockerSnapshot) -> DaemonCache {
        let last_updated = snapshot.last_updated;
        let mut cache = DaemonCache {
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
            findings: FindingsResponse::default(),
            runtime_providers: unavailable_provider_slots(),
            source_generation: 0,
            docker_observation_revision: DockerObservationRevision::new(),
            revision: PublicationRevision::new(),
        };
        cache.assign_docker_observation_revision();
        cache
    }

    fn first_docker_evidence_revision(cache: &DaemonCache) -> String {
        cache
            .runtime_map
            .edges
            .iter()
            .flat_map(|edge| &edge.evidence_refs)
            .next()
            .expect("Docker runtime map carries evidence")
            .provider_revision
            .clone()
    }

    /// Complete a claimed fixed slot without running a host collector. This is
    /// intentionally a virtual-time policy trace: it counts scheduler
    /// execution opportunities, not CPU time or child-process creation.
    fn complete_synthetic_slot(
        slots: &mut RuntimeProviderSlots,
        slot: ProviderSlot,
        completed_at: Duration,
    ) {
        let mut collection = ProviderCollection::default();
        collection.set_state(slot, ProviderStateKind::Fresh);
        let state = slots.get_mut(&slot).expect("fixed slot state exists");
        state.observation = RuntimeProviderState::Fresh(collection);
        state.completed_at = Some(completed_at);
    }

    /// Apply immediate synthetic completions through the same cache state the
    /// real scheduler claims from. This keeps the virtual trace deterministic
    /// without invoking host collectors or inventing a production clock.
    async fn complete_synthetic_claims(
        app: &AppState,
        claimed: &[ProviderSlot],
        completed_at: Duration,
    ) {
        let mut cache = app.cache.write().await;
        for slot in claimed {
            complete_synthetic_slot(&mut cache.runtime_providers, *slot, completed_at);
        }
        cache.rebuild_runtime_map();
        cache.assign_revision();
    }

    fn generated_large_snapshot(last_updated: u64) -> DockerSnapshot {
        let mut snapshot = mock_snapshot();
        let template = snapshot.containers[0].clone();
        snapshot.containers = (0..500)
            .map(|index| {
                let mut container = template.clone();
                container.id = format!("generated-container-{index:03}");
                container.name = format!("generated-service-{index:03}");
                container.depends_on.clear();
                // Keep this a 500-container inventory-scale test, rather
                // than accidentally turning it into a dense shared-network
                // graph benchmark. The metric here is scheduler opportunity.
                container.networks.clear();
                container.ports.clear();
                container.mounts.clear();
                container
            })
            .collect();
        snapshot.last_updated = last_updated;
        snapshot
    }

    fn fresh_slots_at(completed_at: Duration) -> RuntimeProviderSlots {
        let mut slots = slots();
        for slot in STATIC_PROVIDER_SLOTS.iter().copied() {
            complete_synthetic_slot(&mut slots, slot, completed_at);
        }
        slots
    }

    #[test]
    fn fixed_policy_is_completion_relative_and_bounded() {
        assert_eq!(MAX_CONCURRENT_PROVIDER_SLOTS, 2);
        assert_eq!(
            slot_interval(ProviderSlot::NetworkInfrastructure),
            Duration::from_secs(10)
        );
        assert_eq!(
            slot_interval(ProviderSlot::HostScoped),
            Duration::from_secs(15)
        );
        assert_eq!(
            slot_interval(ProviderSlot::Systemd),
            Duration::from_secs(15)
        );
        assert_eq!(
            slot_interval(ProviderSlot::PythonProcesses),
            Duration::from_secs(10)
        );
        assert_eq!(
            slot_interval(ProviderSlot::NativeProcesses),
            Duration::from_secs(10)
        );
        assert_eq!(
            slot_interval(ProviderSlot::ProjectNpm),
            Duration::from_secs(60)
        );

        let mut slots = slots();
        let first = claim_due_slots(&mut slots, Duration::ZERO, MAX_CONCURRENT_PROVIDER_SLOTS);
        assert_eq!(
            first,
            vec![
                ProviderSlot::NetworkInfrastructure,
                ProviderSlot::HostScoped
            ]
        );
        assert!(
            claim_due_slots(
                &mut slots,
                Duration::from_secs(100),
                MAX_CONCURRENT_PROVIDER_SLOTS
            )
            .is_empty(),
            "collecting slots never overlap or catch up"
        );
    }

    #[test]
    fn policy_makes_the_old_two_second_invocation_cost_measurable() {
        let window = Duration::from_secs(60);
        let old_whole_passes = 1 + window.as_secs() / STATIC_REFRESH_INTERVAL.as_secs();
        assert_eq!(
            old_whole_passes, 31,
            "previous baseline invoked every slot every two seconds"
        );
        let invocations = |slot| 1 + window.as_secs() / slot_interval(slot).as_secs();
        assert_eq!(invocations(ProviderSlot::NetworkInfrastructure), 7);
        assert_eq!(invocations(ProviderSlot::HostScoped), 5);
        assert_eq!(invocations(ProviderSlot::Systemd), 5);
        assert_eq!(invocations(ProviderSlot::PythonProcesses), 7);
        assert_eq!(invocations(ProviderSlot::NativeProcesses), 7);
        assert_eq!(invocations(ProviderSlot::ProjectNpm), 2);
    }

    #[tokio::test]
    async fn five_hundred_container_publications_keep_provider_opportunities_inventory_independent()
    {
        let initial = docker_cache(generated_large_snapshot(0));
        let state = AppState {
            cache: Arc::new(RwLock::new(initial)),
            docker: Arc::new(RwLock::new(None)),
            provider_slot_in_flight: Arc::new(ProviderSlotFlights::default()),
        };

        let mut publications = 0;
        let mut starts = BTreeMap::new();
        let mut maximum_live_workers = 0;
        for second in 0..=60 {
            let now = Duration::from_secs(second);
            if second % STATIC_REFRESH_INTERVAL.as_secs() == 0 {
                let snapshot = generated_large_snapshot(second);
                publish_docker_snapshot_cache(&state, docker_cache(snapshot)).await;
                publications += 1;
                let cache = state.cache.read().await;
                assert_eq!(cache.snapshot.containers.len(), 500);
                assert_eq!(cache.runtime_map.last_updated, second);
                assert!(!cache.snapshot.model_revision.is_empty());
                assert_eq!(
                    cache.snapshot.model_revision,
                    cache.runtime_map.model_revision
                );
                assert_eq!(
                    cache.runtime_map.provider_states.len(),
                    STATIC_PROVIDER_SLOTS.len()
                );
                for (provider, expected_slot) in cache
                    .runtime_map
                    .provider_states
                    .iter()
                    .zip(STATIC_PROVIDER_SLOTS.iter())
                {
                    assert_eq!(&provider.slot, expected_slot);
                }
                assert!(cache
                    .runtime_map
                    .nodes
                    .iter()
                    .any(|node| node.provider == RuntimeProviderKind::Docker));
            }
            loop {
                let claimed = claim_due_provider_slots(&state, now).await;
                maximum_live_workers = maximum_live_workers.max(claimed.len());
                if claimed.is_empty() {
                    break;
                }
                for slot in &claimed {
                    *starts.entry(*slot).or_insert(0) += 1;
                }
                complete_synthetic_claims(&state, &claimed, now).await;
            }
        }
        assert_eq!(publications, 31);
        assert_eq!(starts[&ProviderSlot::NetworkInfrastructure], 7);
        assert_eq!(starts[&ProviderSlot::HostScoped], 5);
        assert_eq!(starts[&ProviderSlot::Systemd], 5);
        assert_eq!(starts[&ProviderSlot::PythonProcesses], 7);
        assert_eq!(starts[&ProviderSlot::NativeProcesses], 7);
        assert_eq!(starts[&ProviderSlot::ProjectNpm], 2);
        assert_eq!(starts.values().sum::<usize>(), 33);
        assert!(maximum_live_workers <= MAX_CONCURRENT_PROVIDER_SLOTS);
        // Before Systemd became independently schedulable, one aggregate
        // host-scoped pass covered it alongside the four other fixed bundles.
        // Preserve that actual historical five-bundle baseline rather than
        // retroactively multiplying the old cadence by today's six slots.
        let legacy_aggregate_passes =
            (1 + 60 / STATIC_REFRESH_INTERVAL.as_secs()) * LEGACY_AGGREGATE_SLOT_COUNT;
        assert_eq!(legacy_aggregate_passes, 155);
    }

    /// The scheduler's timing trace above deliberately counts claims rather
    /// than doing host work. This companion test is a controlled, separate
    /// process which puts only fixed harmless command stubs on `PATH` and
    /// drives those same claims through the real slot collectors. Keeping the
    /// environment in a child prevents PATH/PID-profile changes from racing
    /// the rest of the Rust suite.
    #[test]
    fn scheduler_process_churn_uses_fixed_path_stubs_in_isolated_child() {
        const TEST_NAME: &str = "cache_refresh::scheduler_tests::scheduler_process_churn_uses_fixed_path_stubs_in_isolated_child";

        if std::env::var_os(SCHEDULER_CHURN_CHILD_ENV).is_some() {
            let Some(profile) = attested_scheduler_churn_profile() else {
                // Fail safe for ambient/malformed child flags. In particular,
                // do not run any provider collector using the test process's
                // ordinary PATH or PID-namespace settings.
                return;
            };
            let starts = tokio::runtime::Runtime::new()
                .expect("test runtime")
                .block_on(run_real_collector_churn_trace(&profile));
            match profile.as_str() {
                "full-host" => {
                    assert_eq!(starts.values().sum::<usize>(), 33);
                    // The old whole-runtime pass had five aggregate bundles;
                    // systemd was part of host-scoped collection, not a sixth
                    // independently scheduled unit.
                    let legacy_aggregate_starts =
                        (1 + 60 / STATIC_REFRESH_INTERVAL.as_secs()) * LEGACY_AGGREGATE_SLOT_COUNT;
                    assert_eq!(legacy_aggregate_starts, 155);
                    assert_eq!(
                        legacy_aggregate_starts * 8 / LEGACY_AGGREGATE_SLOT_COUNT,
                        248
                    );
                }
                "restricted" => {
                    assert_eq!(starts.values().sum::<usize>(), 13);
                    assert_eq!(starts[&ProviderSlot::HostScoped], 1);
                    assert_eq!(starts[&ProviderSlot::Systemd], 1);
                    assert_eq!(starts[&ProviderSlot::PythonProcesses], 1);
                    assert_eq!(starts[&ProviderSlot::NativeProcesses], 1);
                }
                unexpected => panic!("unknown scheduler churn profile: {unexpected}"),
            }
            return;
        }

        for (profile, expected_children) in [("full-host", 48_usize), ("restricted", 0)] {
            let fixture = tempfile::tempdir().expect("temporary scheduler churn fixture");
            let bin = fixture.path().join("fixed-bin");
            let project_root = fixture.path().join("empty-project-root");
            let counter = fixture.path().join("fixed-command-count");
            let attestation_path = fixture.path().join("parent-attestation");
            let attestation = new_scheduler_churn_attestation();
            fs::create_dir(&bin).expect("fixed stub directory");
            fs::create_dir(&project_root).expect("empty project root");
            fs::write(&counter, "").expect("empty stub counter");
            fs::write(&attestation_path, &attestation).expect("parent attestation");
            fs::set_permissions(&attestation_path, fs::Permissions::from_mode(0o600))
                .expect("private parent attestation");
            for command in [
                "tailscale",
                "headscale",
                "systemctl",
                "crontab",
                "pm2",
                "tmux",
                "ps",
            ] {
                let stub = bin.join(command);
                fs::write(
                    &stub,
                    "#!/bin/sh\nprintf '%s\\n' \"${0##*/}\" >> \"$DOCKERMAP_SCHEDULER_CHURN_COUNTER\"\n",
                )
                .expect("fixed command stub");
                fs::set_permissions(&stub, fs::Permissions::from_mode(0o755))
                    .expect("executable fixed command stub");
            }

            // Regression: a profile flag without the parent attestation must
            // be a no-op, even with otherwise tempting host/PATH inputs.
            let invalid_status = Command::new(std::env::current_exe().expect("test executable"))
                .args(["--exact", TEST_NAME, "--nocapture", "--test-threads=1"])
                .env(SCHEDULER_CHURN_CHILD_ENV, "full-host")
                .env_remove(SCHEDULER_CHURN_ATTESTATION_PATH_ENV)
                .env_remove(SCHEDULER_CHURN_ATTESTATION_TOKEN_ENV)
                .env("DOCKERMAP_PID_NAMESPACE", "host")
                .env("DOCKERMAP_SCHEDULER_CHURN_COUNTER", &counter)
                .env("PATH", &bin)
                .status()
                .expect("unattested churn child starts");
            assert!(invalid_status.success(), "unattested child safely exits");
            assert!(
                fs::read_to_string(&counter)
                    .expect("unattested counter")
                    .is_empty(),
                "an ambient child profile cannot start a host collector"
            );

            // Even a matching, private 0600 sentinel/token pair is not
            // enough under a normal non-test parent (as cargo or a CI wrapper
            // would be). The shell is deliberately the direct parent here.
            let forged_status = Command::new("/bin/sh")
                .args([
                    "-c",
                    "\"$1\" --exact \"$2\" --nocapture --test-threads=1",
                    "scheduler-churn-forge",
                ])
                .arg(std::env::current_exe().expect("test executable"))
                .arg(TEST_NAME)
                .env(SCHEDULER_CHURN_CHILD_ENV, "full-host")
                .env(SCHEDULER_CHURN_ATTESTATION_PATH_ENV, &attestation_path)
                .env(SCHEDULER_CHURN_ATTESTATION_TOKEN_ENV, &attestation)
                .env("DOCKERMAP_PID_NAMESPACE", "host")
                .env("DOCKERMAP_SCHEDULER_CHURN_COUNTER", &counter)
                .env("PATH", &bin)
                .status()
                .expect("forged churn child starts");
            assert!(forged_status.success(), "forged child safely exits");
            assert!(
                fs::read_to_string(&counter)
                    .expect("forged counter")
                    .is_empty(),
                "a forged matching attestation under a non-test parent cannot start a host collector"
            );

            let status = Command::new(std::env::current_exe().expect("test executable"))
                .args(["--exact", TEST_NAME, "--nocapture", "--test-threads=1"])
                .env(SCHEDULER_CHURN_CHILD_ENV, profile)
                .env(SCHEDULER_CHURN_ATTESTATION_PATH_ENV, &attestation_path)
                .env(SCHEDULER_CHURN_ATTESTATION_TOKEN_ENV, &attestation)
                .env(
                    "DOCKERMAP_PID_NAMESPACE",
                    if profile == "full-host" {
                        "host"
                    } else {
                        "restricted"
                    },
                )
                .env("DOCKERMAP_PROJECT_ROOT", &project_root)
                .env("DOCKERMAP_ENABLE_TAILSCALE", "true")
                .env("DOCKERMAP_ENABLE_HEADSCALE", "true")
                .env("DOCKERMAP_SCHEDULER_CHURN_COUNTER", &counter)
                .env("PATH", &bin)
                .status()
                .expect("isolated scheduler churn child starts");
            assert!(status.success(), "isolated {profile} churn child passes");

            let commands = fs::read_to_string(&counter)
                .expect("fixed command counter")
                .lines()
                .map(str::to_owned)
                .collect::<Vec<_>>();
            assert_eq!(commands.len(), expected_children, "{profile} child count");
            if profile == "full-host" {
                let by_command =
                    commands
                        .into_iter()
                        .fold(TestBTreeMap::new(), |mut counts, name| {
                            *counts.entry(name).or_insert(0_usize) += 1;
                            counts
                        });
                assert_eq!(by_command.get("tailscale"), Some(&7));
                assert_eq!(by_command.get("headscale"), Some(&7));
                assert_eq!(by_command.get("systemctl"), Some(&5));
                assert_eq!(by_command.get("crontab"), Some(&5));
                assert_eq!(by_command.get("pm2"), Some(&5));
                assert_eq!(by_command.get("tmux"), Some(&5));
                assert_eq!(by_command.get("ps"), Some(&14));
            }
        }
    }

    #[test]
    fn scheduler_churn_attestation_requires_parent_token_and_known_profile() {
        let token = new_scheduler_churn_attestation();
        assert_eq!(token.len(), 64);
        assert!(token.as_bytes().iter().all(u8::is_ascii_hexdigit));
        for (profile, supplied, stored) in [
            ("full-host", token.as_str(), token.as_str()),
            ("restricted", token.as_str(), token.as_str()),
        ] {
            assert!(scheduler_churn_attestation_matches(
                profile, supplied, stored
            ));
        }
        for (profile, supplied, stored) in [
            ("full-host", "", token.as_str()),
            ("unknown", token.as_str(), token.as_str()),
            ("restricted", token.as_str(), "different-parent-attestation"),
        ] {
            assert!(!scheduler_churn_attestation_matches(
                profile, supplied, stored
            ));
        }
    }

    async fn run_real_collector_churn_trace(profile: &str) -> BTreeMap<ProviderSlot, usize> {
        let state = AppState {
            cache: Arc::new(RwLock::new(docker_cache(mock_snapshot()))),
            docker: Arc::new(RwLock::new(None)),
            provider_slot_in_flight: Arc::new(ProviderSlotFlights::default()),
        };
        let snapshot = state.cache.read().await.snapshot.clone();
        let mut starts = BTreeMap::new();
        for second in 0..=60 {
            let now = Duration::from_secs(second);
            loop {
                let claimed = claim_due_provider_slots(&state, now).await;
                if claimed.is_empty() {
                    break;
                }
                assert!(claimed.len() <= MAX_CONCURRENT_PROVIDER_SLOTS);
                for slot in claimed {
                    *starts.entry(slot).or_insert(0_usize) += 1;
                    // Deliberately invoke the actual bounded fixed collector.
                    // Only its command resolution is substituted by the child
                    // PATH; the scheduler claim and profile branches are
                    // production code. The test records a virtual immediate
                    // completion after the real collector returns.
                    let ProviderCollectionOutcome::Collected(collection) =
                        collect_provider_slot_bounded(
                            state.provider_slot_in_flight.for_slot(slot),
                            slot,
                            &snapshot,
                        )
                        .await
                    else {
                        panic!("fixed stub collector completes within its bounded test window");
                    };
                    let collection = collection.sanitized_for_retention();
                    let mut cache = state.cache.write().await;
                    let slot_state = cache
                        .runtime_providers
                        .get_mut(&slot)
                        .expect("static slot remains present");
                    slot_state.observation = RuntimeProviderState::Fresh(collection);
                    slot_state.completed_at = Some(now);
                }
            }
        }

        let cache = state.cache.read().await;
        if profile == "restricted" {
            for slot in [
                ProviderSlot::HostScoped,
                ProviderSlot::PythonProcesses,
                ProviderSlot::NativeProcesses,
            ] {
                assert!(matches!(
                    cache.runtime_providers[&slot].observation,
                    RuntimeProviderState::Fresh(ref collection)
                        if collection.states().iter().any(|state| state.slot == slot && state.state == ProviderStateKind::Disabled)
                ));
            }
        } else {
            assert_eq!(starts[&ProviderSlot::NetworkInfrastructure], 7);
            assert_eq!(starts[&ProviderSlot::HostScoped], 5);
            assert_eq!(starts[&ProviderSlot::Systemd], 5);
            assert_eq!(starts[&ProviderSlot::PythonProcesses], 7);
            assert_eq!(starts[&ProviderSlot::NativeProcesses], 7);
            assert_eq!(starts[&ProviderSlot::ProjectNpm], 2);
        }
        drop(cache);
        starts
    }

    #[tokio::test]
    async fn occupied_timeout_and_stale_slots_do_not_block_docker_publication() {
        let mut initial = docker_cache(generated_large_snapshot(0));
        initial.runtime_providers = fresh_slots_at(Duration::ZERO);
        let network = initial
            .runtime_providers
            .get_mut(&ProviderSlot::NetworkInfrastructure)
            .expect("fixed network slot exists");
        network.observation =
            RuntimeProviderState::TimedOut(retained_collection(&network.observation));
        let python = initial
            .runtime_providers
            .get_mut(&ProviderSlot::PythonProcesses)
            .expect("fixed python slot exists");
        python.observation =
            RuntimeProviderState::Collecting(retained_collection(&python.observation));
        initial.rebuild_runtime_map();
        initial.assign_revision();
        let state = AppState {
            cache: Arc::new(RwLock::new(initial)),
            docker: Arc::new(RwLock::new(None)),
            provider_slot_in_flight: Arc::new(ProviderSlotFlights::default()),
        };
        state
            .provider_slot_in_flight
            .for_slot(ProviderSlot::NetworkInfrastructure)
            .store(true, std::sync::atomic::Ordering::Release);
        state
            .provider_slot_in_flight
            .for_slot(ProviderSlot::PythonProcesses)
            .store(true, std::sync::atomic::Ordering::Release);
        assert!(claim_due_provider_slots(&state, Duration::from_secs(60))
            .await
            .is_empty());

        for second in [2_u64, 4, 6] {
            let snapshot = generated_large_snapshot(second);
            publish_docker_snapshot_cache(&state, docker_cache(snapshot)).await;
            let cache = state.cache.read().await;
            assert_eq!(cache.snapshot.last_updated, second);
            assert_eq!(cache.snapshot.containers.len(), 500);
            let network = cache
                .runtime_map
                .provider_states
                .iter()
                .find(|state| state.slot == ProviderSlot::NetworkInfrastructure)
                .expect("network state is always projected");
            let python = cache
                .runtime_map
                .provider_states
                .iter()
                .find(|state| state.slot == ProviderSlot::PythonProcesses)
                .expect("python state is always projected");
            assert_eq!(network.state, ProviderStateKind::TimedOut);
            assert_eq!(python.state, ProviderStateKind::Stale);
            assert!(cache
                .runtime_map
                .nodes
                .iter()
                .any(|node| node.provider == RuntimeProviderKind::Docker));
        }
    }

    #[test]
    fn completion_time_not_start_time_controls_next_due_claim() {
        let mut slots = slots();
        let slot = ProviderSlot::NetworkInfrastructure;
        let entry = slots.get_mut(&slot).unwrap();
        entry.observation = RuntimeProviderState::Fresh(ProviderCollection::default());
        entry.completed_at = Some(Duration::from_secs(100));
        assert!(!claim_due_slots(
            &mut slots,
            Duration::from_secs(109),
            STATIC_PROVIDER_SLOTS.len()
        )
        .contains(&slot));
        assert!(claim_due_slots(
            &mut slots,
            Duration::from_secs(110),
            STATIC_PROVIDER_SLOTS.len()
        )
        .contains(&slot));
    }

    #[test]
    fn disabled_slots_are_never_queued_after_profile_fact_is_observed() {
        let mut slots = slots();
        let slot = ProviderSlot::Systemd;
        let mut collection = ProviderCollection::default();
        collection.set_state(slot, ProviderStateKind::Disabled);
        let entry = slots.get_mut(&slot).unwrap();
        entry.observation = RuntimeProviderState::Fresh(collection);
        entry.completed_at = Some(Duration::ZERO);
        assert!(!claim_due_slots(&mut slots, Duration::from_secs(300), 2).contains(&slot));
    }

    #[test]
    fn timeout_retains_sanitized_evidence_and_never_claims_fresh() {
        let snapshot = mock_snapshot();
        let mut slots = slots();
        let slot = ProviderSlot::NetworkInfrastructure;
        let mut collection = ProviderCollection::default();
        collection.set_state(slot, ProviderStateKind::Fresh);
        slots.get_mut(&slot).unwrap().observation =
            RuntimeProviderState::TimedOut(Some(collection));
        let map =
            runtime_map_for_snapshot(&snapshot, &RuntimeMode::Docker, &slots, "test-observation");
        assert!(map
            .provider_states
            .iter()
            .any(|item| item.slot == slot && item.state == ProviderStateKind::TimedOut));
        assert!(map
            .diagnostics
            .iter()
            .any(|item| item.message.contains("timed out")));
    }

    #[test]
    fn timed_out_unwinding_workers_consume_the_global_two_worker_budget() {
        let mut slots = slots();
        for slot in [
            ProviderSlot::NetworkInfrastructure,
            ProviderSlot::HostScoped,
        ] {
            slots.get_mut(&slot).unwrap().observation = RuntimeProviderState::TimedOut(None);
        }
        assert!(
            claim_due_slots_with_active_workers(
                &mut slots,
                Duration::from_secs(120),
                MAX_CONCURRENT_PROVIDER_SLOTS,
                2,
            )
            .is_empty(),
            "timed-out workers still unwinding cannot be replaced"
        );
    }

    #[tokio::test]
    async fn changed_sanitized_docker_evidence_stales_only_network_observations() {
        let mut previous = docker_cache(mock_snapshot());
        let mut network = ProviderCollection::default();
        network.set_state(
            ProviderSlot::NetworkInfrastructure,
            ProviderStateKind::Fresh,
        );
        previous
            .runtime_providers
            .get_mut(&ProviderSlot::NetworkInfrastructure)
            .unwrap()
            .observation = RuntimeProviderState::Fresh(network);
        let mut python = ProviderCollection::default();
        python.set_state(ProviderSlot::PythonProcesses, ProviderStateKind::Fresh);
        previous
            .runtime_providers
            .get_mut(&ProviderSlot::PythonProcesses)
            .unwrap()
            .observation = RuntimeProviderState::Fresh(python);
        let state = AppState {
            cache: Arc::new(RwLock::new(previous)),
            docker: Arc::new(RwLock::new(None)),
            provider_slot_in_flight: Arc::new(ProviderSlotFlights::default()),
        };
        let mut changed = mock_snapshot();
        changed.containers[0].name = "sanitized-docker-change".into();
        publish_docker_snapshot_cache(&state, docker_cache(changed)).await;
        let cache = state.cache.read().await;
        assert!(matches!(
            cache.runtime_providers[&ProviderSlot::NetworkInfrastructure].observation,
            RuntimeProviderState::Degraded(Some(_))
        ));
        assert!(matches!(
            cache.runtime_providers[&ProviderSlot::PythonProcesses].observation,
            RuntimeProviderState::Fresh(_)
        ));
        assert!(cache
            .runtime_map
            .provider_states
            .iter()
            .any(|state| state.slot == ProviderSlot::NetworkInfrastructure
                && state.state == ProviderStateKind::Stale));
    }

    #[tokio::test]
    async fn old_docker_generation_cannot_complete_after_mock_round_trip() {
        let state = AppState {
            cache: Arc::new(RwLock::new(docker_cache(mock_snapshot()))),
            docker: Arc::new(RwLock::new(None)),
            provider_slot_in_flight: Arc::new(ProviderSlotFlights::default()),
        };
        let (observed, mode, generation) =
            publish_docker_snapshot_cache(&state, docker_cache(mock_snapshot())).await;
        publish_docker_snapshot_cache(&state, DaemonCache::mock()).await;
        publish_docker_snapshot_cache(&state, docker_cache(mock_snapshot())).await;
        let mut late = ProviderCollection::default();
        late.push_diagnostic(ProviderDiagnostic::new(
            RuntimeProviderKind::Network,
            DiagnosticSeverity::Info,
            "late old generation",
        ));
        late.set_state(
            ProviderSlot::NetworkInfrastructure,
            ProviderStateKind::Fresh,
        );
        apply_provider_slot_outcome(
            &state,
            ProviderSlot::NetworkInfrastructure,
            observed,
            mode,
            generation,
            ProviderCollectionOutcome::Collected(late),
            Duration::from_secs(1),
        )
        .await;
        let cache = state.cache.read().await;
        assert_eq!(cache.source_generation, generation + 2);
        assert!(!cache
            .runtime_map
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.message.contains("late old generation")));
    }

    #[test]
    fn stale_slot_does_not_relabel_fresh_docker_topology() {
        let snapshot = mock_snapshot();
        let mut slots = slots();
        let slot = ProviderSlot::ProjectNpm;
        let mut collection = ProviderCollection::default();
        collection.set_state(slot, ProviderStateKind::Fresh);
        slots.get_mut(&slot).unwrap().observation =
            RuntimeProviderState::Degraded(Some(collection));
        let map =
            runtime_map_for_snapshot(&snapshot, &RuntimeMode::Docker, &slots, "test-observation");
        assert!(map
            .nodes
            .iter()
            .any(|node| node.provider == RuntimeProviderKind::Docker));
        assert!(map
            .provider_states
            .iter()
            .any(|item| item.slot == slot && item.state == ProviderStateKind::Stale));
    }

    #[test]
    fn revision_ignores_only_observation_markers_without_mutating_responses() {
        let mut revision = PublicationRevision::new();
        let mut snapshot = mock_snapshot();
        snapshot.last_updated = 10;
        let mut health = HealthResponse {
            status: HealthState::Ok,
            mode: RuntimeMode::Docker,
            docker_reachable: true,
            last_updated: 10,
            snapshot_version: "10".into(),
            model_revision: String::new(),
            message: Some("controlled Docker cache".into()),
        };
        let mut runtime_map = empty_runtime_map(10);
        revision.assign(&mut snapshot, &mut health, &mut runtime_map);
        let first = snapshot.model_revision.clone();

        snapshot.last_updated = 11;
        health.last_updated = 11;
        health.snapshot_version = "11".into();
        runtime_map.last_updated = 11;
        revision.assign(&mut snapshot, &mut health, &mut runtime_map);

        assert_eq!(snapshot.model_revision, first);
        assert_eq!(health.model_revision, first);
        assert_eq!(runtime_map.model_revision, first);
        assert_eq!(snapshot.last_updated, 11);
        assert_eq!(health.last_updated, 11);
        assert_eq!(health.snapshot_version, "11");
        assert_eq!(runtime_map.last_updated, 11);
    }

    #[test]
    fn provider_freshness_projection_is_safe_and_retains_good_evidence_on_failure() {
        let snapshot = mock_snapshot();
        let slot = ProviderSlot::Systemd;
        let mut slots = slots();
        let entry = slots.get_mut(&slot).unwrap();
        let mut collection = ProviderCollection::default();
        collection.set_state(slot, ProviderStateKind::Fresh);
        let collection = collection.sanitized_for_retention();
        update_slot_data_revision(&mut entry.freshness, &collection);
        entry.observation = RuntimeProviderState::Fresh(collection);
        entry.freshness.last_attempt_ms = Some(100);
        entry.freshness.last_success_ms = Some(110);
        entry.freshness.last_duration_ms = Some(10);
        entry.freshness.status_reason = None;

        let before = provider_states_for(&slots)
            .into_iter()
            .find(|state| state.slot == slot)
            .unwrap();
        assert_eq!(
            before.data_revision.as_deref().map(str::is_empty),
            Some(false)
        );
        assert_eq!(before.status_reason, None);
        assert_eq!(before.consecutive_failure_count, 0);

        let retained = {
            let entry = slots.get_mut(&slot).unwrap();
            let retained = retained_collection(&entry.observation);
            // A retained collection continues to report its original success and
            // duration while a later attempt is in flight. Its new attempt must
            // not be mistaken for the historical successful attempt.
            entry.observation = RuntimeProviderState::Collecting(retained.clone());
            entry.freshness.last_attempt_ms = Some(120);
            entry.freshness.status_reason = Some(ProviderStatusReason::Refreshing);
            retained
        };
        let refreshing =
            runtime_map_for_snapshot(&snapshot, &RuntimeMode::Docker, &slots, "test-observation")
                .provider_states
                .into_iter()
                .find(|state| state.slot == slot)
                .unwrap();
        assert_eq!(refreshing.state, ProviderStateKind::Stale);
        assert_eq!(refreshing.last_attempt_ms, Some(120));
        assert_eq!(refreshing.last_success_ms, Some(110));
        assert_eq!(refreshing.last_duration_ms, Some(10));
        assert_eq!(
            refreshing.status_reason,
            Some(ProviderStatusReason::Refreshing)
        );

        let entry = slots.get_mut(&slot).unwrap();
        entry.observation = RuntimeProviderState::TimedOut(retained);
        entry.freshness.consecutive_failure_count = 1;
        entry.freshness.status_reason = Some(ProviderStatusReason::CollectionTimedOut);
        let timed_out =
            runtime_map_for_snapshot(&snapshot, &RuntimeMode::Docker, &slots, "test-observation")
                .provider_states
                .into_iter()
                .find(|state| state.slot == slot)
                .unwrap();
        assert_eq!(timed_out.state, ProviderStateKind::TimedOut);
        assert_eq!(timed_out.last_attempt_ms, Some(120));
        assert_eq!(timed_out.last_success_ms, Some(110));
        assert_eq!(timed_out.last_duration_ms, Some(10));
        assert_eq!(timed_out.data_revision, before.data_revision);
        assert_eq!(timed_out.consecutive_failure_count, 1);
        assert_eq!(
            timed_out.status_reason,
            Some(ProviderStatusReason::CollectionTimedOut)
        );
    }

    #[test]
    fn source_reset_clears_provider_freshness_without_exposing_private_state() {
        let slot = ProviderSlot::Systemd;
        let mut slots = source_reset_provider_slots();
        let state = provider_states_for(&slots)
            .into_iter()
            .find(|state| state.slot == slot)
            .unwrap();
        assert_eq!(state.state, ProviderStateKind::Unavailable);
        assert_eq!(state.last_attempt_ms, None);
        assert_eq!(state.last_success_ms, None);
        assert_eq!(state.last_duration_ms, None);
        assert_eq!(state.consecutive_failure_count, 0);
        assert_eq!(state.data_revision, None);
        assert_eq!(state.status_reason, Some(ProviderStatusReason::SourceReset));

        // Source reset state is data-free and resettable rather than a hidden
        // source-generation or error disclosure.
        slots.get_mut(&slot).unwrap().freshness.status_reason = None;
        assert_eq!(
            provider_states_for(&slots)
                .into_iter()
                .find(|state| state.slot == slot)
                .unwrap()
                .status_reason,
            None
        );
    }

    #[test]
    fn opaque_data_revision_changes_only_for_sanitized_observable_data() {
        let slot = ProviderSlot::Systemd;
        let mut freshness = SlotFreshness::default();
        let mut first = ProviderCollection::default();
        first.set_state(slot, ProviderStateKind::Fresh);
        let first = first.sanitized_for_retention();
        update_slot_data_revision(&mut freshness, &first);
        let revision = freshness.data_revision.as_ref().unwrap().public();
        update_slot_data_revision(&mut freshness, &first);
        assert_eq!(freshness.data_revision.as_ref().unwrap().public(), revision);

        let mut changed = first.clone();
        changed.push_diagnostic(ProviderDiagnostic::new(
            RuntimeProviderKind::Process,
            DiagnosticSeverity::Info,
            "token=DOCKERMAP_TEST_PROVIDER_METADATA_SECRET",
        ));
        let changed = changed.sanitized_for_retention();
        update_slot_data_revision(&mut freshness, &changed);
        let changed_revision = freshness.data_revision.as_ref().unwrap().public();
        assert_ne!(changed_revision, revision);
        assert!(!changed_revision.contains("DOCKERMAP_TEST_PROVIDER_METADATA_SECRET"));
    }

    #[tokio::test]
    async fn source_transition_discards_slot_observations_and_claims_advance_revision() {
        let mut previous = docker_cache(mock_snapshot());
        let slot = ProviderSlot::NetworkInfrastructure;
        let mut collection = ProviderCollection::default();
        collection.push_diagnostic(ProviderDiagnostic::new(
            RuntimeProviderKind::Network,
            DiagnosticSeverity::Info,
            "controlled live slot observation",
        ));
        collection.set_state(slot, ProviderStateKind::Fresh);
        previous
            .runtime_providers
            .get_mut(&slot)
            .unwrap()
            .observation = RuntimeProviderState::Fresh(collection);
        let state = AppState {
            cache: Arc::new(RwLock::new(previous)),
            docker: Arc::new(RwLock::new(None)),
            provider_slot_in_flight: Arc::new(ProviderSlotFlights::default()),
        };
        let before = state.cache.read().await.snapshot.model_revision.clone();
        let claimed = claim_due_provider_slots(&state, Duration::ZERO).await;
        assert_eq!(claimed.len(), MAX_CONCURRENT_PROVIDER_SLOTS);
        assert_ne!(before, state.cache.read().await.snapshot.model_revision);

        publish_docker_snapshot_cache(&state, DaemonCache::mock()).await;
        let cache = state.cache.read().await;
        assert_eq!(cache.health.mode, RuntimeMode::Mock);
        assert!(cache
            .runtime_providers
            .values()
            .all(|slot| matches!(slot.observation, RuntimeProviderState::Unavailable)));
        assert!(!cache
            .runtime_map
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic
                .message
                .contains("controlled live slot observation")));
        assert!(cache.runtime_map.nodes.iter().any(|node| {
            node.provider == RuntimeProviderKind::Docker && node.kind == RuntimeNodeKind::Container
        }));
        assert!(
            !cache.runtime_map.edges.is_empty(),
            "mock topology remains useful"
        );
        assert!(cache
            .runtime_map
            .edges
            .iter()
            .all(|edge| edge.evidence_refs.is_empty()));
        assert!(cache.findings.findings.is_empty());
    }

    #[tokio::test]
    async fn forced_mock_mode_preserves_sample_topology_without_runtime_evidence() {
        // The collector checks this flag before it can connect to the Docker
        // gateway. This regression therefore proves the explicit forced-mock
        // path, rather than merely constructing a sample cache by hand.
        std::env::set_var("DOCKERMAP_FORCE_MOCK", "true");
        let collected = collect_snapshot(&AppState::new()).await;
        std::env::remove_var("DOCKERMAP_FORCE_MOCK");
        assert_eq!(collected.health.mode, RuntimeMode::Mock);

        let state = AppState::new();
        publish_docker_snapshot_cache(&state, collected).await;
        let cache = state.cache.read().await;
        assert!(cache.runtime_map.nodes.iter().any(|node| {
            node.provider == RuntimeProviderKind::Docker && node.kind == RuntimeNodeKind::Container
        }));
        assert!(
            !cache.runtime_map.edges.is_empty(),
            "sample edges remain visible"
        );
        assert!(cache
            .runtime_map
            .edges
            .iter()
            .all(|edge| edge.evidence_refs.is_empty()));
        assert!(cache.findings.findings.is_empty());
    }

    #[tokio::test]
    async fn older_snapshot_completion_is_retained_only_as_stale_network_evidence() {
        let state = AppState {
            cache: Arc::new(RwLock::new(docker_cache(mock_snapshot()))),
            docker: Arc::new(RwLock::new(None)),
            provider_slot_in_flight: Arc::new(ProviderSlotFlights::default()),
        };
        let mut old = mock_snapshot();
        old.last_updated = 10;
        let (observed, mode, generation) =
            publish_docker_snapshot_cache(&state, docker_cache(old)).await;
        let mut newer = mock_snapshot();
        newer.last_updated = 11;
        publish_docker_snapshot_cache(&state, docker_cache(newer)).await;
        let mut collection = ProviderCollection::default();
        collection.set_state(
            ProviderSlot::NetworkInfrastructure,
            ProviderStateKind::Fresh,
        );
        apply_provider_slot_outcome(
            &state,
            ProviderSlot::NetworkInfrastructure,
            observed,
            mode,
            generation,
            ProviderCollectionOutcome::Collected(collection),
            Duration::from_secs(1),
        )
        .await;
        assert!(matches!(
            state.cache.read().await.runtime_providers[&ProviderSlot::NetworkInfrastructure]
                .observation,
            RuntimeProviderState::Degraded(Some(_))
        ));
    }

    #[tokio::test]
    async fn secret_only_docker_change_keeps_network_observation_and_revision_stable() {
        let mut first = mock_snapshot();
        first.containers[0].role = "token=DOCKERMAP_TEST_SCHEDULER_SECRET_A".into();
        let mut second = first.clone();
        second.containers[0].role = "token=DOCKERMAP_TEST_SCHEDULER_SECRET_B".into();
        let mut previous = docker_cache(first.clone());
        let mut collection = ProviderCollection::default();
        collection.set_state(
            ProviderSlot::NetworkInfrastructure,
            ProviderStateKind::Fresh,
        );
        previous
            .runtime_providers
            .get_mut(&ProviderSlot::NetworkInfrastructure)
            .unwrap()
            .observation = RuntimeProviderState::Fresh(collection);
        let state = AppState {
            cache: Arc::new(RwLock::new(previous)),
            docker: Arc::new(RwLock::new(None)),
            provider_slot_in_flight: Arc::new(ProviderSlotFlights::default()),
        };
        publish_docker_snapshot_cache(&state, docker_cache(first)).await;
        let revision = state.cache.read().await.snapshot.model_revision.clone();
        publish_docker_snapshot_cache(&state, docker_cache(second)).await;
        let cache = state.cache.read().await;
        assert_eq!(cache.snapshot.model_revision, revision);
        assert!(matches!(
            cache.runtime_providers[&ProviderSlot::NetworkInfrastructure].observation,
            RuntimeProviderState::Fresh(_)
        ));
    }

    #[tokio::test]
    async fn docker_evidence_token_tracks_sanitized_source_semantics_not_refresh_ticks() {
        let mut first = mock_snapshot();
        first.last_updated = 10;
        let state = AppState {
            cache: Arc::new(RwLock::new(docker_cache(first.clone()))),
            docker: Arc::new(RwLock::new(None)),
            provider_slot_in_flight: Arc::new(ProviderSlotFlights::default()),
        };

        publish_docker_snapshot_cache(&state, docker_cache(first.clone())).await;
        let first_cache = state.cache.read().await;
        let first_token = first_docker_evidence_revision(&first_cache);
        let first_model_revision = first_cache.snapshot.model_revision.clone();
        assert_ne!(first_token, first.last_updated.to_string());
        drop(first_cache);

        let mut ticker_only = first.clone();
        ticker_only.last_updated = 12;
        publish_docker_snapshot_cache(&state, docker_cache(ticker_only.clone())).await;
        let ticker_cache = state.cache.read().await;
        assert_eq!(first_docker_evidence_revision(&ticker_cache), first_token);
        assert_eq!(ticker_cache.snapshot.model_revision, first_model_revision);
        drop(ticker_cache);

        let mut changed = ticker_only.clone();
        changed.containers[0].name = "semantic-container-change".into();
        changed.last_updated = 14;
        publish_docker_snapshot_cache(&state, docker_cache(changed.clone())).await;
        let changed_cache = state.cache.read().await;
        let changed_token = first_docker_evidence_revision(&changed_cache);
        assert_ne!(changed_token, first_token);
        assert_ne!(changed_token, changed.last_updated.to_string());
        drop(changed_cache);

        // A Docker/mock source transition is semantic evidence even when the
        // bounded inventory happens to have the same visible entities.
        publish_docker_snapshot_cache(&state, DaemonCache::mock()).await;
        let mock_cache = state.cache.read().await;
        assert!(mock_cache
            .runtime_map
            .edges
            .iter()
            .all(|edge| edge.evidence_refs.is_empty()));
        assert!(mock_cache.findings.findings.is_empty());
    }
}
