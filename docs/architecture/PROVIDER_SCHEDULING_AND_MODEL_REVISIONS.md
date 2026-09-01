# Provider scheduling and model revisions

Status: implemented coherence baseline for #66. This ADR records the fixed
collection boundary and its public coherence contract; it is not a proposal
for a generic job framework.

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

`RuntimeMap.providerStates` is a schema-backed five-item evidence vector for
the fixed slots: `network_infrastructure`, `host_scoped`,
`python_processes`, `native_processes`, and `project_npm`. Each entry contains
only its slot and one of `fresh`, `stale`, `collecting`, `unavailable`,
`timed_out`, or `disabled`. It contains no provider command, path, raw error,
diagnostic, secret, timestamp, or configurable policy. Diagnostics remain the
human-readable, publication-sanitized explanation.

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
existing paired fetch and SSE cadence.

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
each current Docker snapshot. It emits the coherence revision but does not add
conditional HTTP fetching or revision-driven SSE behavior: each received
health event still triggers the existing paired browser refetch.

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
revision monotonicity/stability and sanitized evidence comparison,
restricted-PID omission behavior, no-overlap guard, fresh Docker publication
with retained stale provider observations, timeout degradation, and
source-transition isolation. Generated schema/API tests require non-empty
revisions and a five-item `providerStates` vector; web hook regressions retain
the current fetch cadence while refusing generation-, provenance-, or
revision-mismatched model pairs.

## Consequences

This supplies the coherence comparison point for #66. Later work may consume
the revision through conditional fetching or revise fixed schedules only by
explicit ADR and review; it must not silently convert static collection into a
generic background job framework or make freshness claims stronger than the
actual collected evidence.
