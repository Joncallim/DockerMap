//! Bounded Docker event-stream collection.
//!
//! This is deliberately private daemon state. Raw Docker event messages are
//! reduced immediately to a closed vocabulary and digest-only identities;
//! actor attributes, names, exit text, and other metadata are never retained.
//! The public observed-history route continues to expose only independently
//! derived snapshot deltas until a later contract/API review wires this source.

use crate::{
    cache_refresh::{
        docker_event_source_context, retain_docker_event, set_docker_event_collection_state,
        DockerEventApply, DockerEventSourceContext,
    },
    docker_collector::DockerCollector,
    AppState,
};
use bollard::models::{EventMessage, EventMessageTypeEnum};
use dockermap_core::{
    observed_container_identity, opaque_sha256_hex, ObservedDockerEvent,
    ObservedDockerEventCollectionState, ObservedDockerEventEvidenceSource, ObservedDockerEventKind,
    MAX_OBSERVED_CHANGE_EVENTS,
};
use futures_util::{Stream, StreamExt};
use std::{
    collections::{BTreeSet, VecDeque},
    pin::Pin,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::time::{interval, sleep, MissedTickBehavior};

/// Must remain identical to the gateway's closed event policy. The collector
/// owns no general event-filter interface and never accepts caller input.
pub(crate) const DOCKER_EVENT_ACTIONS: [&str; 7] = [
    "create",
    "start",
    "stop",
    "die",
    "restart",
    "destroy",
    "health_status",
];
pub(crate) const DOCKER_EVENT_REPLAY_SECONDS: u64 = 300;
const MAX_EVENT_CLOCK_SKEW_SECONDS: u64 = 5;
const MAX_RAW_CONTAINER_ID_BYTES: usize = 64;
const MAX_DOCKER_EVENT_DEDUPE_IDS: usize = 4_096;
const SOURCE_POLL_INTERVAL: Duration = Duration::from_millis(250);
const INITIAL_RECONNECT_BACKOFF: Duration = Duration::from_millis(250);
const MAX_RECONNECT_BACKOFF: Duration = Duration::from_secs(8);
const STABLE_STREAM_RESET_AFTER: Duration = Duration::from_secs(5);
const MAX_STREAM_ITEMS_BEFORE_YIELD: usize = 64;

pub(crate) type DockerEventStream =
    Pin<Box<dyn Stream<Item = Result<EventMessage, ()>> + Send + 'static>>;

/// Narrow injectable seam for lifecycle tests. Production has exactly one
/// implementation, and that implementation can only build the fixed gateway
/// collector; this is not a plugin or caller-controlled policy surface.
pub(crate) trait DockerEventConnector: Send + Sync + 'static {
    fn connect(&self, since_seconds: u64) -> Result<DockerEventStream, ()>;
}

struct GatewayDockerEventConnector;

impl DockerEventConnector for GatewayDockerEventConnector {
    fn connect(&self, since_seconds: u64) -> Result<DockerEventStream, ()> {
        let collector = DockerCollector::connect().map_err(|_| ())?;
        Ok(collector.event_stream_since(since_seconds))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DockerHealthState {
    Starting,
    Healthy,
    Unhealthy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DockerEventKind {
    Created,
    Started,
    Stopped,
    Died,
    Restarted,
    Destroyed,
    HealthChanged(DockerHealthState),
}

impl DockerEventKind {
    fn stable_discriminator(self) -> &'static str {
        match self {
            Self::Created => "container_created",
            Self::Started => "container_started",
            Self::Stopped => "container_stopped",
            Self::Died => "container_died",
            Self::Restarted => "container_restarted",
            Self::Destroyed => "container_destroyed",
            Self::HealthChanged(DockerHealthState::Starting) => "container_health_starting",
            Self::HealthChanged(DockerHealthState::Healthy) => "container_health_healthy",
            Self::HealthChanged(DockerHealthState::Unhealthy) => "container_health_unhealthy",
        }
    }

    fn public_kind(self) -> ObservedDockerEventKind {
        match self {
            Self::Created => ObservedDockerEventKind::ContainerCreated,
            Self::Started => ObservedDockerEventKind::ContainerStarted,
            Self::Stopped => ObservedDockerEventKind::ContainerStopped,
            Self::Died => ObservedDockerEventKind::ContainerDied,
            Self::Restarted => ObservedDockerEventKind::ContainerRestarted,
            Self::Destroyed => ObservedDockerEventKind::ContainerDestroyed,
            Self::HealthChanged(DockerHealthState::Starting) => {
                ObservedDockerEventKind::ContainerHealthStarting
            }
            Self::HealthChanged(DockerHealthState::Healthy) => {
                ObservedDockerEventKind::ContainerHealthHealthy
            }
            Self::HealthChanged(DockerHealthState::Unhealthy) => {
                ObservedDockerEventKind::ContainerHealthUnhealthy
            }
        }
    }
}

/// Safe reduction of a raw Bollard message. Every retained string is either a
/// fixed vocabulary value or a digest; no actor-supplied display text survives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedDockerEvent {
    pub(crate) id: String,
    pub(crate) kind: DockerEventKind,
    pub(crate) observed_at_ms: u64,
    pub(crate) source_timestamp_ms: u64,
    source_timestamp_nanos: u64,
    pub(crate) container_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DockerEventEvidenceSource {
    DockerEventStream,
}

/// Internal retention shape. `anchor_*` names are intentional: an event can
/// arrive before the next inventory refresh, so these fields identify the
/// coherent model that existed when it was received without claiming the
/// event was already reflected by that model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RetainedDockerEvent {
    pub(crate) id: String,
    pub(crate) kind: DockerEventKind,
    pub(crate) source: DockerEventEvidenceSource,
    pub(crate) observed_at_ms: u64,
    pub(crate) source_timestamp_ms: u64,
    pub(crate) container_id: String,
    pub(crate) source_generation: u64,
    pub(crate) anchor_model_revision: String,
    pub(crate) anchor_observation_revision: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DockerEventRetention {
    Retained,
    Duplicate,
    Rejected,
}

/// A separate stream-event journal lives beside the snapshot-delta ring. The
/// two evidence sources are never relabelled or merged implicitly. Both use
/// the same 64-row product retention boundary, while the larger but still
/// fixed dedupe horizon prevents replay from turning an evicted row into a
/// fresh event after a normal reconnect.
#[derive(Clone)]
pub(crate) struct DockerEventJournal {
    events: VecDeque<RetainedDockerEvent>,
    dedupe_order: VecDeque<String>,
    dedupe_ids: BTreeSet<String>,
    last_source_timestamp_nanos: Option<u64>,
    collection_state: ObservedDockerEventCollectionState,
}

impl Default for DockerEventJournal {
    fn default() -> Self {
        Self {
            events: VecDeque::new(),
            dedupe_order: VecDeque::new(),
            dedupe_ids: BTreeSet::new(),
            last_source_timestamp_nanos: None,
            collection_state: ObservedDockerEventCollectionState::Unavailable,
        }
    }
}

impl DockerEventJournal {
    pub(crate) fn retain(
        &mut self,
        event: ParsedDockerEvent,
        source_generation: u64,
        anchor_model_revision: &str,
        anchor_observation_revision: &str,
    ) -> DockerEventRetention {
        if anchor_model_revision.is_empty() || anchor_observation_revision.is_empty() {
            return DockerEventRetention::Rejected;
        }
        self.last_source_timestamp_nanos = Some(
            self.last_source_timestamp_nanos
                .unwrap_or_default()
                .max(event.source_timestamp_nanos),
        );
        if self.dedupe_ids.contains(&event.id) {
            return DockerEventRetention::Duplicate;
        }

        self.dedupe_ids.insert(event.id.clone());
        self.dedupe_order.push_back(event.id.clone());
        while self.dedupe_order.len() > MAX_DOCKER_EVENT_DEDUPE_IDS {
            if let Some(expired) = self.dedupe_order.pop_front() {
                self.dedupe_ids.remove(&expired);
            }
        }

        self.events.push_back(RetainedDockerEvent {
            id: event.id,
            kind: event.kind,
            source: DockerEventEvidenceSource::DockerEventStream,
            observed_at_ms: event.observed_at_ms,
            source_timestamp_ms: event.source_timestamp_ms,
            container_id: event.container_id,
            source_generation,
            anchor_model_revision: anchor_model_revision.to_owned(),
            anchor_observation_revision: anchor_observation_revision.to_owned(),
        });
        while self.events.len() > MAX_OBSERVED_CHANGE_EVENTS {
            self.events.pop_front();
        }
        DockerEventRetention::Retained
    }

    pub(crate) fn replay_since_seconds(&self, now_seconds: u64) -> u64 {
        let oldest_allowed = now_seconds.saturating_sub(DOCKER_EVENT_REPLAY_SECONDS);
        self.last_source_timestamp_nanos
            .map(|nanos| nanos / 1_000_000_000)
            .unwrap_or(oldest_allowed)
            .clamp(oldest_allowed, now_seconds)
    }

    /// The daemon supervisor owns this state and can move it only after
    /// proving the stream generation is still current. It carries no gateway
    /// error text or other provider-controlled display data.
    pub(crate) fn set_collection_state(&mut self, state: ObservedDockerEventCollectionState) {
        self.collection_state = state;
    }

    pub(crate) fn collection_state(&self) -> ObservedDockerEventCollectionState {
        self.collection_state
    }

    /// Public projection is intentionally separate from the retained shape so
    /// private source-generation bookkeeping cannot become an API field.
    pub(crate) fn public_events_newest_first(&self) -> Vec<ObservedDockerEvent> {
        self.events
            .iter()
            .rev()
            .map(|event| ObservedDockerEvent {
                id: event.id.clone(),
                kind: event.kind.public_kind(),
                evidence_source: ObservedDockerEventEvidenceSource::DockerEventStream,
                observed_at_ms: event.observed_at_ms,
                source_occurred_at_ms: event.source_timestamp_ms,
                container_id: event.container_id.clone(),
                anchor_model_revision: event.anchor_model_revision.clone(),
                anchor_observation_revision: event.anchor_observation_revision.clone(),
            })
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn retained(&self) -> &VecDeque<RetainedDockerEvent> {
        &self.events
    }
}

pub(crate) fn parse_docker_event(
    message: EventMessage,
    observed_at_ms: u64,
) -> Option<ParsedDockerEvent> {
    const MAX_SAFE_JS_INTEGER: u64 = 9_007_199_254_740_991;
    if observed_at_ms > MAX_SAFE_JS_INTEGER || message.typ != Some(EventMessageTypeEnum::CONTAINER)
    {
        return None;
    }

    let kind = parse_event_kind(message.action.as_deref()?)?;
    let raw_container_id = message.actor?.id?;
    if !is_full_docker_container_id(&raw_container_id) {
        return None;
    }
    let source_timestamp_nanos = normalized_source_timestamp(message.time, message.time_nano)?;
    let source_seconds = source_timestamp_nanos / 1_000_000_000;
    let observed_seconds = observed_at_ms / 1_000;
    if source_seconds > observed_seconds.saturating_add(MAX_EVENT_CLOCK_SKEW_SECONDS)
        || observed_seconds.saturating_sub(source_seconds) > DOCKER_EVENT_REPLAY_SECONDS
    {
        return None;
    }

    let container_id = observed_container_identity(&raw_container_id);
    let identity_material = format!(
        "{}\u{1f}{}\u{1f}{source_timestamp_nanos}",
        container_id,
        kind.stable_discriminator()
    );
    Some(ParsedDockerEvent {
        id: format!(
            "docker_event_{}",
            opaque_sha256_hex(identity_material.as_bytes())
        ),
        kind,
        observed_at_ms,
        source_timestamp_ms: source_timestamp_nanos / 1_000_000,
        source_timestamp_nanos,
        container_id,
    })
}

fn parse_event_kind(action: &str) -> Option<DockerEventKind> {
    match action {
        "create" => Some(DockerEventKind::Created),
        "start" => Some(DockerEventKind::Started),
        "stop" => Some(DockerEventKind::Stopped),
        "die" => Some(DockerEventKind::Died),
        "restart" => Some(DockerEventKind::Restarted),
        "destroy" => Some(DockerEventKind::Destroyed),
        "health_status: starting" => {
            Some(DockerEventKind::HealthChanged(DockerHealthState::Starting))
        }
        "health_status: healthy" => {
            Some(DockerEventKind::HealthChanged(DockerHealthState::Healthy))
        }
        "health_status: unhealthy" => {
            Some(DockerEventKind::HealthChanged(DockerHealthState::Unhealthy))
        }
        _ => None,
    }
}

fn is_full_docker_container_id(value: &str) -> bool {
    value.len() == MAX_RAW_CONTAINER_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn normalized_source_timestamp(time: Option<i64>, time_nano: Option<i64>) -> Option<u64> {
    let seconds = time.map(u64::try_from).transpose().ok()?;
    let nanos = time_nano.map(u64::try_from).transpose().ok()?;
    match (seconds, nanos) {
        (Some(seconds), Some(nanos)) if nanos / 1_000_000_000 == seconds => Some(nanos),
        (Some(_), Some(_)) => None,
        (Some(seconds), None) => seconds.checked_mul(1_000_000_000),
        (None, Some(nanos)) => Some(nanos),
        (None, None) => None,
    }
}

#[derive(Debug)]
struct ReconnectBackoff {
    next: Duration,
}

impl ReconnectBackoff {
    fn new() -> Self {
        Self {
            next: INITIAL_RECONNECT_BACKOFF,
        }
    }

    fn failure_delay(&mut self) -> Duration {
        let delay = self.next;
        self.next = self.next.saturating_mul(2).min(MAX_RECONNECT_BACKOFF);
        delay
    }

    fn reset(&mut self) {
        self.next = INITIAL_RECONNECT_BACKOFF;
    }
}

enum StreamExit {
    Disconnected,
    SourceChanged,
}

/// One task owns the stream for the daemon lifetime. It never occupies a host
/// provider slot, never overlaps another event stream, and reconnects only
/// through the configured filtered gateway.
pub(crate) async fn docker_event_loop(state: AppState) {
    docker_event_loop_with_connector(state, GatewayDockerEventConnector).await;
}

pub(crate) async fn docker_event_loop_with_connector<C>(state: AppState, connector: C)
where
    C: DockerEventConnector,
{
    let mut backoff = ReconnectBackoff::new();
    loop {
        let now_seconds = wall_clock_seconds();
        let Some(context) = docker_event_source_context(&state, now_seconds).await else {
            backoff.reset();
            sleep(SOURCE_POLL_INTERVAL).await;
            continue;
        };

        if !set_docker_event_collection_state(
            &state,
            &context,
            ObservedDockerEventCollectionState::Connecting,
        )
        .await
        {
            backoff.reset();
            continue;
        }

        let mut stream = match connector.connect(context.since_seconds) {
            Ok(stream) => stream,
            Err(_) => {
                if !set_docker_event_collection_state(
                    &state,
                    &context,
                    ObservedDockerEventCollectionState::Reconnecting,
                )
                .await
                {
                    backoff.reset();
                    continue;
                }
                sleep(backoff.failure_delay()).await;
                continue;
            }
        };
        if !set_docker_event_collection_state(
            &state,
            &context,
            ObservedDockerEventCollectionState::Collecting,
        )
        .await
        {
            drop(stream);
            backoff.reset();
            continue;
        }
        let connected_at = Instant::now();
        let mut source_poll = interval(SOURCE_POLL_INTERVAL);
        source_poll.set_missed_tick_behavior(MissedTickBehavior::Skip);
        // Tokio intervals tick immediately. Consume that setup tick so the
        // select below owns one persistent 250ms deadline which cannot be
        // recreated/postponed by a continuously ready stream.
        source_poll.tick().await;
        let mut items_since_yield = 0;
        let exit = loop {
            tokio::select! {
                biased;
                _ = source_poll.tick() => {
                    if !docker_event_source_is_current(&state, &context).await {
                        break StreamExit::SourceChanged;
                    }
                }
                item = stream.next() => {
                    let Some(item) = item else {
                        break StreamExit::Disconnected;
                    };
                    let Ok(message) = item else {
                        break StreamExit::Disconnected;
                    };
                    items_since_yield += 1;
                    if items_since_yield >= MAX_STREAM_ITEMS_BEFORE_YIELD {
                        items_since_yield = 0;
                        // A malicious or malformed always-ready response must
                        // not monopolize the executor before the persistent
                        // source-generation deadline becomes runnable.
                        tokio::task::yield_now().await;
                    }
                    let Some(observed_at_ms) = wall_clock_millis() else {
                        continue;
                    };
                    let Some(event) = parse_docker_event(message, observed_at_ms) else {
                        continue;
                    };
                    match retain_docker_event(&state, &context, event).await {
                        DockerEventApply::Retained => backoff.reset(),
                        DockerEventApply::Duplicate => {}
                        DockerEventApply::StaleSource => break StreamExit::SourceChanged,
                    }
                }
            }
        };
        // Close the failed/stale Unix response before any reconnect delay.
        // This makes the single-connection bound physical, not merely a fact
        // of control flow, and makes task cancellation promptly release it.
        drop(stream);

        if matches!(exit, StreamExit::SourceChanged) {
            backoff.reset();
            continue;
        }
        if !set_docker_event_collection_state(
            &state,
            &context,
            ObservedDockerEventCollectionState::Reconnecting,
        )
        .await
        {
            backoff.reset();
            continue;
        }
        if connected_at.elapsed() >= STABLE_STREAM_RESET_AFTER {
            backoff.reset();
        }
        sleep(backoff.failure_delay()).await;
    }
}

async fn docker_event_source_is_current(
    state: &AppState,
    expected: &DockerEventSourceContext,
) -> bool {
    docker_event_source_context(state, wall_clock_seconds())
        .await
        .is_some_and(|current| current.source_generation == expected.source_generation)
}

fn wall_clock_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn wall_clock_millis() -> Option<u64> {
    const MAX_SAFE_JS_INTEGER: u128 = 9_007_199_254_740_991;
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis();
    (millis <= MAX_SAFE_JS_INTEGER).then_some(millis as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bollard::{models::EventActor, Docker, API_DEFAULT_VERSION};
    use std::{collections::HashMap, sync::Arc};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::UnixListener,
        sync::Mutex,
        time::timeout,
    };

    const NOW_SECONDS: u64 = 1_800_000_000;
    const RAW_CONTAINER_ID: &str =
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn raw_event(action: &str, source_nanos: u64) -> EventMessage {
        EventMessage {
            typ: Some(EventMessageTypeEnum::CONTAINER),
            action: Some(action.into()),
            actor: Some(EventActor {
                id: Some(RAW_CONTAINER_ID.into()),
                attributes: Some(HashMap::from([
                    ("name".into(), "/srv/private/name-sentinel".into()),
                    ("exitCode".into(), "secret-exit-text-sentinel".into()),
                    ("token".into(), "raw-actor-token-sentinel".into()),
                ])),
            }),
            time: Some((source_nanos / 1_000_000_000) as i64),
            time_nano: Some(source_nanos as i64),
            ..Default::default()
        }
    }

    fn parsed(action: &str, offset_nanos: u64) -> ParsedDockerEvent {
        parse_docker_event(
            raw_event(action, NOW_SECONDS * 1_000_000_000 + offset_nanos),
            NOW_SECONDS * 1_000,
        )
        .expect("controlled event parses")
    }

    #[test]
    fn parser_accepts_only_the_closed_container_event_vocabulary() {
        let cases = [
            ("create", DockerEventKind::Created),
            ("start", DockerEventKind::Started),
            ("stop", DockerEventKind::Stopped),
            ("die", DockerEventKind::Died),
            ("restart", DockerEventKind::Restarted),
            ("destroy", DockerEventKind::Destroyed),
            (
                "health_status: starting",
                DockerEventKind::HealthChanged(DockerHealthState::Starting),
            ),
            (
                "health_status: healthy",
                DockerEventKind::HealthChanged(DockerHealthState::Healthy),
            ),
            (
                "health_status: unhealthy",
                DockerEventKind::HealthChanged(DockerHealthState::Unhealthy),
            ),
        ];
        for (action, expected) in cases {
            let event = parsed(action, 42);
            assert_eq!(event.kind, expected);
            assert!(event.id.starts_with("docker_event_"));
            assert_eq!(event.id.len(), "docker_event_".len() + 64);
            assert!(event.container_id.starts_with("docker_container_"));
            assert_eq!(event.container_id.len(), "docker_container_".len() + 64);

            let retained_shape = format!("{event:?}");
            for forbidden in [
                RAW_CONTAINER_ID,
                "/srv/private/name-sentinel",
                "secret-exit-text-sentinel",
                "raw-actor-token-sentinel",
            ] {
                assert!(
                    !retained_shape.contains(forbidden),
                    "safe event retained raw actor data: {forbidden}"
                );
            }
        }
    }

    #[test]
    fn parser_fails_closed_for_hostile_identity_kind_type_and_time() {
        for action in [
            "health_status",
            "health_status: private",
            "exec_create",
            "attach",
            "start\0destroy",
            " START ",
        ] {
            assert!(parse_docker_event(
                raw_event(action, NOW_SECONDS * 1_000_000_000),
                NOW_SECONDS * 1_000,
            )
            .is_none());
        }

        let mut wrong_type = raw_event("start", NOW_SECONDS * 1_000_000_000);
        wrong_type.typ = Some(EventMessageTypeEnum::IMAGE);
        assert!(parse_docker_event(wrong_type, NOW_SECONDS * 1_000).is_none());

        for actor_id in [
            "short-id",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg",
            "/srv/private/container-token",
        ] {
            let mut event = raw_event("start", NOW_SECONDS * 1_000_000_000);
            event.actor.as_mut().unwrap().id = Some(actor_id.into());
            assert!(parse_docker_event(event, NOW_SECONDS * 1_000).is_none());
        }

        let stale = raw_event(
            "start",
            (NOW_SECONDS - DOCKER_EVENT_REPLAY_SECONDS - 1) * 1_000_000_000,
        );
        assert!(parse_docker_event(stale, NOW_SECONDS * 1_000).is_none());
        let future = raw_event(
            "start",
            (NOW_SECONDS + MAX_EVENT_CLOCK_SKEW_SECONDS + 1) * 1_000_000_000,
        );
        assert!(parse_docker_event(future, NOW_SECONDS * 1_000).is_none());

        let mut inconsistent = raw_event("start", NOW_SECONDS * 1_000_000_000);
        inconsistent.time = Some(NOW_SECONDS as i64 - 1);
        assert!(parse_docker_event(inconsistent, NOW_SECONDS * 1_000).is_none());
    }

    #[test]
    fn journal_is_bounded_deduplicated_and_revision_anchored() {
        let mut journal = DockerEventJournal::default();
        let duplicate = parsed("start", 64);
        for index in 0..=MAX_OBSERVED_CHANGE_EVENTS {
            let event = parsed("start", index as u64);
            assert_eq!(
                journal.retain(event, 7, "model-revision-7", "docker-observation-4"),
                DockerEventRetention::Retained
            );
        }
        assert_eq!(journal.retained().len(), MAX_OBSERVED_CHANGE_EVENTS);
        assert_eq!(
            journal.retained().front().unwrap().source_timestamp_ms,
            NOW_SECONDS * 1_000
        );
        let newest = journal.retained().back().unwrap();
        assert_eq!(newest.id, duplicate.id);
        assert_eq!(newest.source, DockerEventEvidenceSource::DockerEventStream);
        assert_eq!(newest.source_generation, 7);
        assert_eq!(newest.anchor_model_revision, "model-revision-7");
        assert_eq!(newest.anchor_observation_revision, "docker-observation-4");
        assert_eq!(
            journal.retain(
                duplicate,
                7,
                "different-model-revision",
                "different-observation-revision"
            ),
            DockerEventRetention::Duplicate
        );
        assert_eq!(journal.retained().len(), MAX_OBSERVED_CHANGE_EVENTS);
        assert_eq!(journal.replay_since_seconds(NOW_SECONDS), NOW_SECONDS);
        assert_eq!(
            DockerEventJournal::default().replay_since_seconds(NOW_SECONDS),
            NOW_SECONDS - DOCKER_EVENT_REPLAY_SECONDS
        );
    }

    #[test]
    fn dedupe_horizon_is_exactly_4096_and_evicts_oldest_identity() {
        let mut journal = DockerEventJournal::default();
        let first = parsed("start", 0);
        for index in 0..MAX_DOCKER_EVENT_DEDUPE_IDS {
            assert_eq!(
                journal.retain(
                    parsed("start", index as u64),
                    1,
                    "model-revision",
                    "observation-revision"
                ),
                DockerEventRetention::Retained
            );
        }
        assert_eq!(journal.dedupe_order.len(), MAX_DOCKER_EVENT_DEDUPE_IDS);
        assert_eq!(journal.dedupe_ids.len(), MAX_DOCKER_EVENT_DEDUPE_IDS);
        assert_eq!(
            journal.retain(first.clone(), 1, "model-revision", "observation-revision"),
            DockerEventRetention::Duplicate,
            "the oldest ID remains protected at the exact capacity"
        );

        assert_eq!(
            journal.retain(
                parsed("start", MAX_DOCKER_EVENT_DEDUPE_IDS as u64),
                1,
                "model-revision",
                "observation-revision"
            ),
            DockerEventRetention::Retained
        );
        assert_eq!(journal.dedupe_order.len(), MAX_DOCKER_EVENT_DEDUPE_IDS);
        assert_eq!(journal.dedupe_ids.len(), MAX_DOCKER_EVENT_DEDUPE_IDS);
        assert!(!journal.dedupe_ids.contains(&first.id));
        assert_eq!(
            journal.retain(first, 1, "model-revision", "observation-revision"),
            DockerEventRetention::Retained,
            "an ID is eligible again only after bounded FIFO eviction"
        );
        assert_eq!(journal.dedupe_order.len(), MAX_DOCKER_EVENT_DEDUPE_IDS);
        assert_eq!(journal.dedupe_ids.len(), MAX_DOCKER_EVENT_DEDUPE_IDS);
    }

    #[test]
    fn reconnect_backoff_is_fixed_bounded_and_resettable() {
        let mut backoff = ReconnectBackoff::new();
        assert_eq!(backoff.failure_delay(), Duration::from_millis(250));
        assert_eq!(backoff.failure_delay(), Duration::from_millis(500));
        assert_eq!(backoff.failure_delay(), Duration::from_secs(1));
        assert_eq!(backoff.failure_delay(), Duration::from_secs(2));
        assert_eq!(backoff.failure_delay(), Duration::from_secs(4));
        assert_eq!(backoff.failure_delay(), Duration::from_secs(8));
        assert_eq!(backoff.failure_delay(), Duration::from_secs(8));
        backoff.reset();
        assert_eq!(backoff.failure_delay(), Duration::from_millis(250));
    }

    #[tokio::test]
    async fn collector_emits_only_the_fixed_scoped_bollard_event_request() {
        let directory = tempfile::tempdir().unwrap();
        let socket = directory.path().join("docker-read.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let captured = Arc::new(Mutex::new(String::new()));
        let captured_request = Arc::clone(&captured);
        let server = tokio::spawn(async move {
            let (mut connection, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1_024];
            loop {
                let read = connection.read(&mut chunk).await.unwrap();
                assert!(read > 0, "request ended before headers completed");
                request.extend_from_slice(&chunk[..read]);
                assert!(request.len() <= 16_384, "event request head was unbounded");
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            *captured_request.lock().await = String::from_utf8(request).unwrap();
            let payload = format!(
                "{{\"Type\":\"container\",\"Action\":\"start\",\"Actor\":{{\"ID\":\"{RAW_CONTAINER_ID}\",\"Attributes\":{{\"name\":\"private\"}}}},\"time\":{NOW_SECONDS},\"timeNano\":{}}}\n",
                NOW_SECONDS * 1_000_000_000
            );
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n{:x}\r\n{}\r\n0\r\n\r\n",
                payload.len(),
                payload
            );
            connection.write_all(response.as_bytes()).await.unwrap();
        });

        let docker =
            Docker::connect_with_unix(socket.to_str().unwrap(), 5, API_DEFAULT_VERSION).unwrap();
        let label = "com.dockermap.fixture=trace-123";
        let collector = DockerCollector::with_client(docker, Some(label.into()));
        let mut stream = Box::pin(collector.event_stream_since(NOW_SECONDS - 30));
        let message = timeout(Duration::from_secs(2), stream.next())
            .await
            .expect("fake stream responds")
            .expect("stream contains one event")
            .expect("Bollard parses event");
        assert_eq!(message.action.as_deref(), Some("start"));
        server.await.unwrap();

        let request = captured.lock().await;
        let request_line = request.lines().next().unwrap();
        let target = request_line
            .strip_prefix("GET ")
            .and_then(|value| value.strip_suffix(" HTTP/1.1"))
            .expect("Bollard emits an HTTP GET origin-form target");
        let url = url::Url::parse(&format!("http://docker{target}")).unwrap();
        let query = url.query_pairs().collect::<HashMap<_, _>>();
        assert_eq!(
            query.get("since").map(|value| value.as_ref()),
            Some("1799999970")
        );
        assert!(
            !query.contains_key("until"),
            "live stream must not self-expire"
        );
        assert_eq!(query.len(), 2);
        let filters: serde_json::Value =
            serde_json::from_str(query.get("filters").unwrap()).unwrap();
        assert_eq!(
            filters,
            serde_json::json!({
                "type": ["container"],
                "event": DOCKER_EVENT_ACTIONS,
                "label": [label]
            })
        );
    }
}
