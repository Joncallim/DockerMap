# Time-to-answer baseline 3

Status: **REJECTED historical capture**. Baselines 1, 2, and 3 are not measurement
authority, must not be used for promotion gating, and cannot support product or
optimization claims. This document is retained only as an audit record explaining
why methodology revision 2 exists: its free-running jitter did not sweep polling
phase, it retained only one warm-up, it treated daemon binary provenance as a
compatibility key, and it lacked after-capture binary verification. The numbers below
are historical outputs, not a prospective authority.

- baseline id: `dockermap-v1/time-to-answer-baseline-1` (schema id unchanged; this
  is capture 3)
- **product revision: `cf77e8ba67ea3d180b0a05866df30943be502776`**, which is also the harness
  revision: the harness was committed before the capture and the capture refuses to
  run from a dirty worktree or a mismatched revision
- artifact: `/srv/jonas/evidence/dockermap/time-to-answer/time-to-answer-baseline-3.json`
  — sha256 `ae7a4e913ea29cf1f15dab630080f09e073231f67e88a12ee053491f5fb4f90c`
- harness evidence (independence control + warm-up retention):
  `/srv/jonas/evidence/dockermap/time-to-answer/time-to-answer-baseline-3.json.harness-evidence.json`
  — sha256 `7e4aeebdd47a44dff4f58267dfd659b0e835f36a2762f672678d52d79562e9fb`
- pinned environment:
  `/srv/jonas/evidence/dockermap/time-to-answer/time-to-answer-metadata.json` —
  sha256 `af1397d1a22d42427aa55223ac4a30ed4f418f0ddf64bfb3d16c1f15bb3dc38e`
- recomputed summary:
  `/srv/jonas/evidence/dockermap/time-to-answer/summary.md`
- capture duration: 25.6 minutes; **44 declared cells × 3 controlled runs × 15
  recorded samples = 1980 raw samples**, plus one discarded warm-up
  observation per warmed daemon cell per run
- the artifact is an external reviewed record under the evidence-artifact policy: it
  lives outside the repository, and what is checked in is the baseline identity, the
  pinned environment and this document

Reproduce or audit:

```
npm run build:deploy                                             # pinned daemon build
npm run perf:summarize -- --artifact /srv/jonas/evidence/dockermap/time-to-answer/time-to-answer-baseline-3.json
```

## Pinned environment

| field | value |
| --- | --- |
| runnerClass | linux-x86_64-dedicated |
| cpuClass | cpus-16vcpu |
| osImage | ubuntu-26.04 |
| osKernel | 7.0.0-31-generic |
| nodeRevision | 22.23.2 |
| rustRevision | 1.88.0 |
| dockerRevision | 29.8.1 (informational: no measured stage exercises the host Docker daemon) |
| ssePollIntervalMs | 2000 |
| sourceRevision | cf77e8ba67ea3d180b0a05866df30943be502776 |
| harnessRevision | cf77e8ba67ea3d180b0a05866df30943be502776 |
| daemonBinarySha256 | `5d67fdf26f2c9c5256a20f61f402b6b3b9307a1479d8444126d93ab2eb714ecc` |
| daemonBinaryBuild | cargo-build-release-locked-p-dockermap-daemon-manifest-path-crates-Cargo-toml |
| cargoRevision | cargo-1.88.0-873a06493-2025-05-10 |
| browserEngine / revision | chromium / 1.61.0 |
| browserFlags | --disable-background-networking --disable-sync --no-first-run --no-default-browser-check |
| fontEnvironment | system-default |
| buildMode | production |
| fixtureRevision | dockermap-v1/time-to-answer-fixtures-1 |

The release daemon was built with
`cargo build --release --locked -p dockermap-daemon --manifest-path crates/Cargo.toml`
and its digest verified before **and** after the capture.

## The 44-cell matrix, recomputed from raw

| fixture | stage | run p95 (ms) | median (ms) | min | max |
| --- | --- | --- | --- | --- | --- |
| reference-25 | daemonStartToListenerMs | 41.08 / 41.59 / 39.95 | 41.08 | 33.28 | 41.59 |
| reference-25 | listenerToFirstDockerModelMs | 10.57 / 11.45 / 15.30 | 11.45 | 9.04 | 15.30 |
| reference-25 | dockerObservationMs | 2.64 / 2.22 / 2.44 | 2.44 | 1.36 | 2.64 |
| reference-25 | composeEnrichmentMs | 1.12 / 1.11 / 0.98 | 1.11 | 0.63 | 1.12 |
| reference-25 | publicationToNodeObservationMs | 863.37 / 856.93 / 816.64 | 856.93 | 743.34 | 863.37 |
| reference-25 | notificationToCoherentModelMs | 19.20 / 20.50 / 19.70 | 19.70 | 10.70 | 20.50 |
| reference-25 | coherentModelToUsefulRenderMs | 30.60 / 36.40 / 34.30 | 34.30 | 16.40 | 36.40 |
| reference-25 | buildModelMs | 0.50 / 0.50 / 0.40 | 0.50 | 0.00 | 0.50 |
| reference-25 | findingsDerivationMs | 0.08 / 0.07 / 0.07 | 0.07 | 0.04 | 0.08 |
| reference-25 | legacyTopologyLayoutMs | 2.80 / 2.40 / 2.30 | 2.40 | 1.50 | 2.80 |
| reference-25 | commandQueryMs | 47.30 / 50.10 / 53.30 | 50.10 | 4.60 | 53.30 |
| reference-25 | productionBundleMs | 55.80 / 45.10 / 46.30 | 46.30 | 37.10 | 55.80 |
| reference-100 | daemonStartToListenerMs | 113.37 / 117.34 / 116.75 | 116.75 | 95.79 | 117.34 |
| reference-100 | listenerToFirstDockerModelMs | 19.60 / 40.57 / 21.27 | 21.27 | 14.77 | 40.57 |
| reference-100 | dockerObservationMs | 4.43 / 4.43 / 5.27 | 4.43 | 2.35 | 5.27 |
| reference-100 | composeEnrichmentMs | 1.01 / 0.96 / 1.09 | 1.01 | 0.62 | 1.09 |
| reference-100 | publicationToNodeObservationMs | 960.46 / 940.42 / 941.50 | 941.50 | 410.81 | 960.46 |
| reference-100 | notificationToCoherentModelMs | 36.20 / 47.90 / 46.30 | 46.30 | 27.10 | 47.90 |
| reference-100 | coherentModelToUsefulRenderMs | 61.40 / 61.30 / 64.50 | 61.40 | 27.90 | 64.50 |
| reference-100 | buildModelMs | 0.80 / 0.70 / 1.10 | 0.80 | 0.20 | 1.10 |
| reference-100 | findingsDerivationMs | 0.25 / 0.26 / 0.21 | 0.25 | 0.16 | 0.26 |
| reference-100 | legacyTopologyLayoutMs | 21.10 / 26.80 / 30.00 | 26.80 | 19.10 | 30.00 |
| reference-100 | commandQueryMs | 39.50 / 19.50 / 45.40 | 39.50 | 7.10 | 45.40 |
| reference-100 | productionBundleMs | 54.40 / 53.30 / 48.70 | 53.30 | 37.50 | 54.40 |
| reference-250 | daemonStartToListenerMs | 298.45 / 295.37 / 328.76 | 298.45 | 107.79 | 328.76 |
| reference-250 | listenerToFirstDockerModelMs | 113.05 / 155.82 / 99.19 | 113.05 | 41.23 | 155.82 |
| reference-250 | dockerObservationMs | 11.15 / 11.29 / 10.08 | 11.15 | 4.31 | 11.29 |
| reference-250 | composeEnrichmentMs | 0.94 / 1.08 / 1.09 | 1.08 | 0.60 | 1.09 |
| reference-250 | publicationToNodeObservationMs | 1808.94 / 1810.23 / 1795.50 | 1808.94 | 0.33 | 1810.23 |
| reference-250 | notificationToCoherentModelMs | 92.60 / 94.10 / 114.80 | 94.10 | 66.70 | 114.80 |
| reference-250 | coherentModelToUsefulRenderMs | 214.30 / 235.00 / 204.90 | 214.30 | 139.00 | 235.00 |
| reference-250 | buildModelMs | 1.80 / 1.80 / 1.70 | 1.80 | 0.70 | 1.80 |
| reference-250 | findingsDerivationMs | 0.79 / 0.74 / 0.72 | 0.74 | 0.54 | 0.79 |
| reference-250 | legacyTopologyLayoutMs | 178.40 / 184.30 / 170.00 | 178.40 | 123.30 | 184.30 |
| reference-250 | commandQueryMs | 170.50 / 154.30 / 26.70 | 154.30 | 12.00 | 170.50 |
| reference-250 | productionBundleMs | 49.40 / 49.50 / 49.50 | 49.50 | 38.60 | 49.50 |
| slow-bounded-compose-projection | composeEnrichmentMs | 8.81 / 8.57 / 10.86 | 8.81 | 5.38 | 10.86 |
| provider-only-revision-change | publicationToNodeObservationMs | 1902.28 / 1933.54 / 1934.33 | 1933.54 | 49.60 | 1934.33 |
| provider-only-revision-change | notificationToCoherentModelMs | 44.20 / 43.60 / 53.10 | 44.20 | 25.70 | 53.10 |
| docker-topology-change | publicationToNodeObservationMs | 909.49 / 878.46 / 932.34 | 909.49 | 355.43 | 932.34 |
| docker-topology-change | notificationToCoherentModelMs | 45.30 / 36.50 / 50.50 | 45.30 | 28.70 | 50.50 |
| docker-topology-change | coherentModelToUsefulRenderMs | 63.60 / 60.70 / 91.60 | 63.60 | 30.60 | 91.60 |
| unavailable-optional-provider | publicationToNodeObservationMs | 1886.89 / 1930.69 / 1921.78 | 1921.78 | 102.57 | 1930.69 |
| unavailable-optional-provider | notificationToCoherentModelMs | 51.10 / 38.20 / 45.90 | 45.90 | 27.80 | 51.10 |

## Stage 5 — today's real publication→observation mechanism

This rejected capture's stage-5 rows are historical outputs, not a measurement of
the mechanism DockerMap ships today. Its jitter did not produce a phase sweep, so
neither the table nor any p95 in it has phase coverage, a span/direction guarantee,
or promotion authority. In particular, the provider-only and unavailable-optional
provider rows were provider-driven and free-running: their fixed provider slots
refresh at 10 s, 15 s, or 60 s, integer multiples of the pinned 2000 ms API poll
interval. Their observed phase was structurally pinned, not random; the rows do
not represent real-user latency, random production latency, network latency, or a
Stage-5 characterisation. They are not a phase-normalized scalar and are excluded
from the phase-normalized scalar used for #337 comparison. Under the current
methodology, the two cells measure a new revision through the real API-SSE poller
path, record their achieved phase, and assert their provider premise; their matrix
value is that premise coverage plus the applicable stage-6/stage-7 boundary. This
rejected baseline cannot establish those current, limited claims.

The following historical spread is retained only to explain the rejection:

| fixture | n | min | p50 | p95 | max |
| --- | --- | --- | --- | --- | --- |
| reference-25 | 45 | 743.34 | 801.99 | 846.26 | 863.37 |
| reference-100 | 45 | 410.81 | 705.08 | 941.50 | 960.46 |
| reference-250 | 45 | 0.33 | 971.66 | 1795.50 | 1810.23 |
| provider-only-revision-change | 45 | 49.60 | 605.41 | 1902.28 | 1934.33 |
| docker-topology-change | 45 | 355.43 | 637.91 | 894.82 | 932.34 |
| unavailable-optional-provider | 45 | 102.57 | 673.82 | 1886.89 | 1930.69 |

This is **not** a network-latency figure. Removing the floor is #337's work; the
production cadence was deliberately left unchanged.

## Stage 6 and stage 7

Stage 6 ends when the real application seam accepts one coherent model; stage 7
begins at that instant and ends when the accepted revision's expected Home content
has rendered, confirmed by one bounded frame. Medians of the three run p95s:

| fixture | stage 6 (notification → acceptance) | stage 7 (acceptance → rendered content) |
| --- | --- | --- |
| reference-25 | 19.20 | 30.60 |
| reference-100 | 36.20 | 61.40 |
| reference-250 | 92.60 | 214.30 |
| docker-topology-change | 45.30 | 63.60 |
| provider-only-revision-change | 44.20 | not declared (no inventory change to present) |
| unavailable-optional-provider | 51.10 | not declared |

### Independence control (must hold, or no baseline is emitted)

3 control samples per fixture with a 250 ms presentation delay injected **after**
acceptance: stage 6 must not move beyond `max(30 ms, 25%)`, stage 7 must absorb at
least 70% of the delay.

| fixture | stage 6 normal | stage 6 control | Δ | stage 7 normal | stage 7 control | Δ | control samples |
| --- | --- | --- | --- | --- | --- | --- | --- |
| reference-25 | 13.50 | 14.30 | +0.80 | 26.20 | 280.70 | +254.50 | 9 |
| reference-100 | 31.60 | 31.10 | -0.50 | 35.60 | 282.60 | +247.00 | 9 |
| reference-250 | 76.40 | 72.00 | -4.40 | 160.50 | 406.50 | +246.00 | 9 |
| docker-topology-change | 32.10 | 33.30 | +1.20 | 40.50 | 284.20 | +243.70 | 9 |

Every control stage-7 sample exceeded the injected delay, stage 6 moved by at most
4.4 ms, and each fixture's stage 7 absorbed the delay — the two clocks are
independent, and stage 7 responds to presentation rather than to acceptance.

### Acceptance audit (all 306 samples)

| fixture | samples | accepted revision also on the harness's own stream | intermediate acceptances skipped | content matched the triggered change |
| --- | --- | --- | --- | --- |
| reference-25 | 45 | 45 | 9 | 45 |
| reference-100 | 45 | 45 | 10 | 45 |
| reference-250 | 45 | 45 | 14 | 45 |
| docker-topology-change | 45 | 45 | 4 | 45 |
| provider-only-revision-change | 45 | 45 | 0 | 0 |
| unavailable-optional-provider | 45 | 42 | 0 | 0 |

An "intermediate acceptance skipped" is a published revision whose acceptance moved
no Home metric (for example a provider-state-only publication); the sample is
attributed to the revision the app fetched from the API and to the notification
that preceded that fetch, never to the nearest acceptance by time.

## Bucket shares — where the time actually goes

Sum of the median-of-three stage medians per bucket, per reference fixture:

### reference-25 (1066.40 ms)
- transport-notification: 856.93 ms (80.4%)
- rendering: 83.00 ms (7.8%)
- backend-collection: 56.16 ms (5.3%)
- search: 50.10 ms (4.7%)
- browser-model: 20.20 ms (1.9%)

### reference-100 (1313.31 ms)
- transport-notification: 941.50 ms (71.7%)
- backend-collection: 143.71 ms (10.9%)
- rendering: 141.50 ms (10.8%)
- browser-model: 47.10 ms (3.6%)
- search: 39.50 ms (3.0%)

### reference-250 (2925.82 ms)
- transport-notification: 1808.94 ms (61.8%)
- rendering: 442.20 ms (15.1%)
- backend-collection: 424.48 ms (14.5%)
- search: 154.30 ms (5.3%)
- browser-model: 95.90 ms (3.3%)

### reference fixtures combined (5305.53 ms)
- transport-notification: 3607.37 ms (68.0%)
- rendering: 666.70 ms (12.6%)
- backend-collection: 624.36 ms (11.8%)
- search: 243.90 ms (4.6%)
- browser-model: 163.20 ms (3.1%)

## Top contributors

Largest median-of-three stage medians per reference fixture:

- **reference-25**: publicationToNodeObservation 856.93, commandQuery 50.10,
  productionBundle 46.30, daemonStartToListener 41.08, coherentModelToUsefulRender 34.30
- **reference-100**: publicationToNodeObservation 941.50, daemonStartToListener 116.75,
  coherentModelToUsefulRender 61.40, productionBundle 53.30, notificationToCoherentModel 46.30
- **reference-250**: publicationToNodeObservation 1808.94, daemonStartToListener 298.45,
  coherentModelToUsefulRender 214.30, legacyTopologyLayout 178.40, commandQuery 154.30

**Compose contribution.** `composeEnrichmentMs` is measured separately but still
executes inside the Docker publication budget: 1.11 / 1.01 / 1.08 ms at 25 / 100 /
250 containers, i.e. 31.3% / 18.6% / 8.9% of the measured Docker+Compose collection
block. The slow-but-bounded Compose scenario (`slow-bounded-compose-projection`,
400 declared services) records 8.81 ms for Compose correlation alone. **Nothing is
decoupled in this baseline**: these are the numbers #336 must improve against.

## Warm-up retention (auditable)

Exactly one observation is discarded per warmed daemon cell per run — always the
first — and the complete window is retained in the harness evidence file:

- observation windows retained: **30** run-cells, each with
  `samples + 1 = 16` observations in the order the daemon produced them
- windows whose recorded samples do **not** equal the window minus the discarded
  warm-up: **0**
- discarded index is always the first observation: `True`
- recorded-sample-count distribution across every cell of the artifact:
  [15] (the contract requires exactly 15)
- retained warm-up observations (one per warmed daemon cell, keyed `fixture|stage`):
  `reference-100|composeEnrichmentMs` = 0.7770 ms, `reference-100|dockerObservationMs` = 8.6390 ms, `reference-100|findingsDerivationMs` = 0.0010 ms, `reference-250|composeEnrichmentMs` = 0.8270 ms, `reference-250|dockerObservationMs` = 12.2060 ms, `reference-250|findingsDerivationMs` = 0.0020 ms, `reference-25|composeEnrichmentMs` = 0.7800 ms, `reference-25|dockerObservationMs` = 6.6540 ms, `reference-25|findingsDerivationMs` = 0.0010 ms, `slow-bounded-compose-projection|composeEnrichmentMs` = 6.8630 ms

The capture refuses to emit an artifact when a window is missing, shorter than
`samples + 1`, discards anything other than the first observation, or does not
match the run stored in the artifact, so a slow warm-up value cannot be hidden.

## Rejected attempts (history, not authority)

Baseline 1 (first capture) and baseline 2 (second) were both rejected in
independent review and are **not the authority for anything**. Their artifacts
remain in `/srv/jonas/evidence/dockermap/time-to-answer/` as rejected history, and
none of their numbers appear in this document: baseline 1 measured Cmd-K
palette-open instead of query-to-results, phase-locked its stage-5 samples to its own
startup sequence, mixed cold-start probe daemons into stages documented as warmed,
and was produced by an uncommitted harness; baseline 2 fixed those and was rejected
because a cold first observation survived inside the "warmed" window, the daemon
binary was unpinned, and its stage 7 was element-for-element identical to stage 6 in
all 180 samples — the two stages shared one DOM-derived clock.

## What this baseline is not

- Not a claim about a real Docker daemon's latency: every collection number comes
  from a deterministic local fixture daemon.
- Not a claim about a real network: no measured stage leaves the host.
- Not proof that the model is complete: `listenerToFirstDockerModelMs` and stage 6
  end at coherence, not at completeness.
- Not permission to optimize. Any claim in #336/#337/#338 must be compared against
  this baseline under the promotion rule, in a compatible pinned environment.
