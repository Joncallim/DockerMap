# Provider scheduling and model revisions

Status: implemented fixed-slot scheduling policy for #66. This ADR records
the bounded collection boundary and public coherence contract; it is not a
proposal for a generic job framework.

## Decision

DockerMap keeps the two-second Docker-inventory refresh loop. Each cycle
publishes the Docker snapshot immediately, then claims due fixed provider
slots in the background. The private completion-relative policy is: network
infrastructure 10 seconds, host-scoped 15 seconds, Python processes 10
seconds, native processes 10 seconds, and project npm 60 seconds. At most two
slots run at once. There are no user-configurable timers, persisted telemetry,
conditional browser fetch policy, provider plugin, or policy DSL.

The fixed runtime collection stages, in order, are:

1. Docker projection from the snapshot.
2. Network infrastructure (including its fixed opt-in and restricted-PID
   handling).
3. Host-scoped collectors (listeners, systemd, scheduled jobs, PM2, tmux).
4. Python process projection.
5. Native-process projection.
6. Bounded project-root npm discovery.

`STATIC_PROVIDER_SLOTS`, its fixed cadence table, and `STATIC_REFRESH_INTERVAL`
are code-level implementation policy. They are not a scheduling API. Changing
their order, cadence, adding a slot, or allowing a configurable cadence
requires a new ADR, focused regressions, and a review of source, redaction,
and cache coherence.

## Provider state vocabulary

`RuntimeMap.providerStates` is a schema-backed five-item evidence vector for
the fixed slots: `network_infrastructure`, `host_scoped`,
`python_processes`, `native_processes`, and `project_npm`. Each entry contains
only its slot and one of `fresh`, `stale`, `collecting`, `unavailable`,
`timed_out`, or `disabled`. It contains no provider command, path, raw error,
diagnostic, secret, timestamp, or configurable policy. Diagnostics remain the
human-readable, publication-sanitized explanation.

The schema enforces item shape and a five-item bound; the Node daemon-response
boundary additionally rejects a vector unless every fixed slot appears exactly
once. This is a closed, typed contract invariant rather than a configurable
policy.

## Public provider freshness metadata

Each fixed slot also publishes bounded collection evidence: nullable
`lastAttemptMs`, `lastSuccessMs`, and `lastDurationMs`; a non-negative
`consecutiveFailureCount`; nullable opaque `dataRevision`; and nullable closed
`statusReason`. Timestamp values are Unix wall-clock milliseconds and are
schema-bounded to JavaScript's exact integer range. `lastDurationMs` is the
duration of the last successful collection, so a failure or timeout retains
the last known-good success/duration/revision while its attempt and failure
state remain explicit.

`dataRevision` is absent before a successful collection and after a live/mock
source reset. When present it is a non-empty CSPRNG-backed opaque revision,
not a raw-data hash or timestamp. It advances only when sanitized observable
data for that one slot changes; repeated Docker polling and timestamp-only
publication cannot churn it. `statusReason` is null for fresh and ordinary
initial-unavailable slots. The only non-null values are the closed safe terms
`initial`, `refreshing`, `collection_failed`, `collection_timed_out`,
`source_reset`, and `disabled`. No command, path, root, argument, raw or
sanitized error string, diagnostic, hostname, PID, cadence, source generation,
guard state, or raw-data hash is exposed through this metadata.

The scheduler writes it only while claiming a due slot, applying a terminal
outcome, or resetting a source. A source flip clears timestamps, failure
count, retained data identity, and observations before publishing a
`source_reset` reason. These fields express evidence quality only; they never
claim the health of a discovered target service.

| State | Current meaning | Publication behaviour |
| --- | --- | --- |
| fresh | The fixed collector completed against the current published Docker evidence. | Its normalized nodes/edges may be published. |
| disabled | The slot is intentionally unavailable under the selected bounded profile (for example restricted PID or missing project root). | No invented nodes; diagnostics explain the omission. |
| collecting | A first bounded collection is in flight and no earlier observations are retained. | Fresh Docker topology remains; provider observations are unavailable. |
| stale | A new pass is in flight, failed, or completed for older evidence while sanitized observations are retained. | Retained observations carry an explicit stale/degraded diagnostic. |
| unavailable | No usable provider observations are retained after a failure or source transition. | Fresh Docker topology remains with an explicit warning. |
| timed_out | The bounded provider pass exceeded its 15-second budget. | Fresh Docker topology remains; retained observations, if any, remain stale. |

This is a fixed public contract, generated from Rust alongside the daemon
models. It is not a scheduler policy API and does not create independent
provider timers.

## Snapshot token and future model-revision semantics

`DockerSnapshot`, `RuntimeMap`, and `HealthResponse` carry the same required,
opaque non-empty `modelRevision`. It is generated from a CSPRNG boot-instance
component plus a checked monotonic publication sequence. It advances only when
the publication-sanitized observable model or provider-state evidence changes;
identical publication bytes retain it. It is not a timestamp, hash, secret
oracle, or ordering value across daemon restarts. Browser model composition
requires matching non-empty snapshot/runtime revisions, while retaining the
existing paired fetch coherence requirement.

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
each current Docker snapshot. Its semantic comparator uses cloned sanitized
response models and clears only the volatile Docker observation markers
(`lastUpdated` on all three models and health's timestamp-derived
`snapshotVersion`) plus the self-referential revision. It never mutates the
cached or response bytes while comparing them. Consequently, an unchanged
model observed at a new time retains its revision, while source, inventory,
provider state, diagnostics, or any other published field advances it.

The API sends a valid health snapshot immediately to each SSE stream, then
suppresses duplicate non-empty revisions for that stream while retaining its
keepalive comments, auth/session checks, stream caps, logout closure, and
redacted error frames. The browser always accepts valid health updates so its
connection state remains current, but increments its model refresh tick only
for the first or a changed non-empty revision. No ETag, new route,
Last-Event-ID, or SSE payload shape is introduced.

## Concurrency and bounds

The refresh loop does not await optional collection before publishing Docker
evidence. Each slot has a single-flight atomic guard, and the scheduler admits
at most two. If a blocking slot times out, its guard remains held until its
task unwinds; no same-slot overlap starts in the meantime. Due time is measured
from completion, not start, so slow work does not create catch-up bursts.
Disabled profile slots are not re-queued. A provider result completing after a
newer snapshot is retained only as explicitly stale evidence. The 15-second
per-slot runtime budget and fixed process/filesystem bounds remain unchanged.

For a 60-second healthy interval, the old static pass invoked every slot 31
times. The fixed policy has deterministic maximum attempts of 7 network, 5
host-scoped, 7 Python, 7 native, and 2 npm attempts (initial attempt included).
This is a timing/cost comparison only: completed observations still retain
their existing source, redaction, profile, and stale-state semantics.

## Deterministic large-host evidence

The daemon unit suite drives the fixed policy through a 0–60 second virtual
healthy trace with synthetic immediate completions. It records 7, 5, 7, 7,
and 2 provider execution opportunities respectively (28 total), never more
than two concurrently admitted slots. Its explicit former-policy baseline is
31 two-second passes multiplied by five slots: 155 opportunities. This is an
execution-opportunity comparison, not a claim about CPU consumption,
subprocess creation, or wall-clock work on a particular host.

The same deterministic suite publishes generated 500-container Docker
snapshots at all 31 two-second positions, verifies the five-slot runtime
vector remains coherent and renderable, and proves that this larger inventory
does not increase host-provider opportunities. A separate occupied-guard
trace retains both timeout and stale evidence while later Docker snapshots
continue publishing. Measuring physical CPU or process creation requires a
separate controlled runner harness; DockerMap intentionally adds no runtime
telemetry, configuration, route, command, or production benchmark for that
purpose.

No raw provider result bypasses `publication` redaction or source stamping.
No new command, network egress, Docker authority, filesystem root, route, SSE
event, or browser behavior is introduced by this baseline.

## Regression evidence

Rust tests assert the two-second Docker cadence, exact fixed policy intervals,
deterministic due/not-due claims, two-slot concurrency, no overlap,
completion-relative timing, disabled-slot suppression, timeout/stale retention,
and source isolation, alongside
revision monotonicity/stability and sanitized evidence comparison,
restricted-PID omission behavior, no-overlap guard, fresh Docker publication
with retained stale provider observations, timeout degradation, and
source-transition isolation. Generated schema/API tests require non-empty
revisions and a five-item `providerStates` vector; web hook regressions retain
the current fetch cadence while refusing generation-, provenance-, or
revision-mismatched model pairs.

The scheduler evidence additionally exercises the full 60-second fixed-policy
opportunity trace, the explicit 155-opportunity legacy baseline, 31
publications of a generated 500-container snapshot, inventory-independent
provider starts, and occupied timeout/stale slots while Docker publication
continues.

## Consequences

This supplies the coherence comparison point for #66. Later work may consume
the revision through conditional fetching or revise fixed schedules only by
explicit ADR and review; it must not silently convert static collection into a
generic background job framework or make freshness claims stronger than the
actual collected evidence.
