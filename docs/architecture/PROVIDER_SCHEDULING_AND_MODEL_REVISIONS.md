# Provider scheduling and model revisions

Status: accepted baseline for #66. This ADR records the implementation before
any scheduler work. It is deliberately a characterization, not a proposal for
a generic job framework.

## Decision

DockerMap currently has one static Docker-inventory refresh loop. Each cycle
publishes the Docker snapshot immediately, then starts at most one bounded
runtime-provider observation pass in the background. There are no separate
provider timers, no persisted telemetry, no conditional browser fetch policy,
and no provider plugin or policy DSL.

The fixed runtime collection stages, in order, are:

1. Docker projection from the snapshot.
2. Network infrastructure (including its fixed opt-in and restricted-PID
   handling).
3. Host-scoped collectors (listeners, systemd, scheduled jobs, PM2, tmux).
4. Python process projection.
5. Native-process projection.
6. Bounded project-root npm discovery.

`STATIC_PROVIDER_SLOTS` and `STATIC_REFRESH_INTERVAL` are code-level baseline
instrumentation. They are not a scheduling API. Changing their order, adding a
slot, or allowing an independent collection cadence requires a new ADR,
focused regressions, and a review of source, redaction, and cache coherence.

## Provider state vocabulary

At this baseline, provider state is represented only by the existing,
publication-sanitized runtime map and diagnostics:

| State | Current meaning | Publication behaviour |
| --- | --- | --- |
| collected | The fixed collector completed against the currently published Docker snapshot. | Its normalized nodes/edges may be published. |
| skipped | The provider is intentionally unavailable (for example restricted PID namespace, missing bounded project root, or disabled tailnet opt-in). | No invented nodes; an informational diagnostic explains the omission. |
| degraded | A bounded provider command or read did not produce complete usable evidence. | Existing severity/message diagnostics state the limitation; no healthy inference is made. |
| failed/timed out | The whole runtime collection task failed or exceeded its 15-second budget. | Fresh Docker topology remains. The last successful provider observations are retained only with an explicit stale/degraded warning; if none exists, host-provider nodes are omitted with a warning. |
| in flight | A prior blocking task has not unwound. | Fresh Docker topology remains. Retained provider observations are explicitly marked stale, or an explicit warning records that no successful observations are available. |

This is not a new browser contract. Diagnostics remain the only public
per-provider state surface. A future explicit provider-state model must define
schema ownership and source stamps before it is emitted.

## Snapshot token and future model-revision semantics

There is **no public cache-model revision at this baseline**.
`HealthResponse.snapshotVersion` is an opaque snapshot-observation token: the
current implementation is the decimal string form of the Docker snapshot's
`lastUpdated`, assigned before runtime collection completes. Consumers must
not parse it, assume clock ordering, compare it to establish same-publication
identity, or use it as independent evidence that every optional provider ran
successfully. Equal tokens have no per-publication uniqueness guarantee.

`lastUpdated` describes the published Docker snapshot observation timestamp;
it is not a promise that each optional provider has fresh evidence. The
snapshot and runtime map remain source-stamped at daemon publication. A Docker
snapshot plus unavailable or retained-stale host providers is therefore Docker
evidence with provider diagnostics, not a complete host claim. Mock fallback
stays mock source-stamped, does not run host-provider collection, and may not
be relabelled as Docker. A live provider result is discarded across a
Docker/mock source transition rather than being relabelled as sample data.

The current implementation publication-sanitizes provider observations before
retaining them behind `DaemonCache` and rebuilds the public runtime map against
each current Docker snapshot. It does not publish a cache identity. Browser SSE emits only health snapshots; each
received health event triggers the existing paired snapshot/runtime refetch.
This ADR does not alter that public behavior.

## Concurrency and bounds

The refresh loop does not await optional collection before publishing Docker
evidence. Runtime collection has a single-flight atomic guard. If a blocking
collection times out, its guard remains held until the task unwinds; no second
host-provider collection starts in the meantime. A provider result completing
after a newer snapshot is retained only as explicitly stale evidence. The
15-second runtime budget and fixed process/filesystem bounds remain unchanged.

No raw provider result bypasses `publication` redaction or source stamping.
No new command, network egress, Docker authority, filesystem root, route, SSE
event, or browser behavior is introduced by this baseline.

## Regression evidence

Rust tests assert the two-second static cadence, exact collection-stage order,
the non-unique snapshot-observation-token behavior, restricted-PID omission
behavior, no-overlap guard, fresh Docker publication with retained stale
provider observations, timeout degradation, and source-transition isolation.
Existing API/SSE and web hook regressions continue to prove that SSE health
events drive the paired browser refetch and that mismatched
generation/provenance pairs are not published as a coherent model.

## Consequences

This supplies a fixed comparison point for #66. Later scheduling work may add
only explicitly reviewed provider policies and revision semantics; it must not
silently convert static collection into background jobs or make freshness
claims stronger than the actual collected evidence.
