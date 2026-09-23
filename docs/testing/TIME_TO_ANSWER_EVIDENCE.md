# Time-to-answer evidence

Status: measurement authority for issue #335 and its parent epic #333. This is
**not** an optimization, a product claim, or permission to cut features for a
number. Nothing here changes what DockerMap collects or publishes.

DockerMap had controlled performance evidence for the Atlas route only. That is
not evidence about the operator path, which starts when the daemon process
starts and ends when a human can act on an answer. This document defines how
that path is measured, what each number proves, and what it deliberately does
not.

## The contract lives in code, not in this document

`apps/web/src/lib/performance/timeToAnswerEvidence.ts` is the closed schema and
the math. It contains no timings. It defines:

- the **12 measured stages**, each with its bucket, a `measures` sentence and a
  `doesNotProve` sentence;
- the **fixtures**: `reference-25`, `reference-100`, `reference-250`, plus the
  scenario fixtures `provider-only-revision-change`, `docker-topology-change`,
  `slow-bounded-compose-projection` and `unavailable-optional-provider`;
- the **exact fixture × stage matrix**, derived from each stage's fixture list;
- the **pinned environment allowlist** (runner class, CPU class, OS image and
  kernel, Node/Rust/Docker revisions, Chromium revision and flags, font
  environment, production build mode, fixture revision, source revision);
- **raw-sample validation**: 15 warmed samples in each of 3 complete controlled
  runs, nearest-rank p95 per run, median of the three run p95 values;
- the **promotion gate** `max(baseline × 1.25, baseline + 2 ms)`, compared only
  between environments that match on every pinned field except `sourceRevision`.

Because summaries are recomputed from the raw samples at review time, a supplied
summary cannot influence a result. An artifact with a fabricated summary field,
a truncated matrix, a wrong sample count, a negative or non-numeric sample, an
unknown stage, a duplicate record, an undeclared fixture, or an extra/unsafe
metadata field is rejected — see `timeToAnswerEvidence.test.ts`.

## Stage buckets

| bucket | stages | what it answers |
| --- | --- | --- |
| backend-collection | daemonStartToListenerMs, listenerToFirstDockerModelMs, dockerObservationMs, composeEnrichmentMs | how long DockerMap takes to have an authoritative answer |
| transport-notification | publicationToNodeObservationMs | how long a published revision takes to become visible |
| browser-model | notificationToCoherentModelMs, buildModelMs, findingsDerivationMs | how long the browser needs to turn it into a model |
| rendering | coherentModelToUsefulRenderMs, legacyTopologyLayoutMs, productionBundleMs | how long the operator waits for something useful on screen |
| search | commandQueryMs | how long a direct question takes to answer |

The buckets exist so the baseline can say **where** the time went — Compose,
notification, model rebuilds, legacy layout or search — instead of only how much
there was.

## What each number does and does not prove

The contract carries a `measures`/`doesNotProve` pair for every stage; two
examples of the distinction that matter most:

- `listenerToFirstDockerModelMs` measures until the first authoritative Docker
  model is observable. It does **not** prove the model is complete — optional
  provider evidence may still be missing, and a fast number here must never be
  read as "the host is fully described".
- `composeEnrichmentMs` measures Compose filesystem correlation separately from
  the Docker observation. While the two remain coupled inside one publication
  budget, this stage is **measured, not removed**; #336 owns moving it off the
  critical path.
- `dockerObservationMs` is measured against a deterministic local fixture
  daemon. It is **not** a claim about a real Docker daemon's latency, host load,
  or image size.
- `productionBundleMs` and `commandQueryMs` are measured against the pinned
  local production build and a fixed representative query set. They are **not**
  claims about a real network or about operator behaviour.

## Controlled run record

Run exactly three times on the same dedicated pinned runner after a clean
production build. Record every field of the pinned environment. A missing field,
a changed fixture/browser/policy/font/runner class, or a runner health failure
**invalidates the record**; it does not justify retrying until a preferred
duration appears.

- Keep **raw timings** in the artifact; derive summaries during review.
- Ordinary unit tests may validate evidence shape and math, and must **not**
  pretend to be the controlled benchmark. `npm run test:perf` is shape/math and
  CPU-only; it never compares elapsed production time.
- Store only sanitized JSON evidence. Never record live host data, raw model or
  evidence values, credentials, container identities or screenshots.
- The baseline artifact is an external reviewed record (the same policy the
  Atlas evidence uses): it is passed to the benchmark job, not committed. The
  baseline identity (`dockermap-v1/time-to-answer-baseline-1`) and the pinned
  environment are what are checked in.

## Fixture source

`tests/perf/dockerFixtureTopology.mjs` generates deterministic, secret-free
Docker inventory for a given container count and scenario, and
`tests/perf/fake-docker-api.mjs` serves it over a unix socket through the same
three read-only endpoints the daemon's collector uses
(`/containers/json`, `/networks`, `/volumes`, plus `/_ping`, `/version`,
`/info`).

The daemon is pointed at that socket with
`DOCKERMAP_DOCKER_GATEWAY_SOCKET=<fixture socket>` — the same env var it already
uses for the read-only gateway — so the benchmark exercises the **real**
collector, projection and publication path. It never contacts a real Docker
daemon, and the fixture daemon never reads the host filesystem or the network.
25/100/250 containers is why a deterministic fixture daemon is required at all:
inventing 250 real containers on a shared host would not be reproducible.

Verified working end to end: the release-built daemon, pointed at the fixture
socket with 25 containers, reports `mode: docker`, `dockerReachable: true`, and
publishes 25 containers / 1 network / 5 volumes with a model revision.

## Promotion rules

A candidate passes only when, in an equivalent controlled environment, **every**
fixture × stage value is at most `max(baseline × 1.25, baseline + 2 ms)`. Limits
are derived from the measured baseline, never invented as aspirational absolute
milliseconds. A candidate that fails the environment check fails closed; it is
not "close enough".

No optimization claim in #336/#337/#338 (or later) may be accepted without
comparing against this baseline under this rule.

## Stage attribution inside the daemon

`dockerObservationMs`, `composeEnrichmentMs` and `findingsDerivationMs` are
measured by a **test-only** hook in the daemon
(`crates/dockermap-daemon/src/bench_timing.rs`). It is inert unless
`DOCKERMAP_BENCH_STAGE_TIMING_PATH` names an absolute path; it then appends
newline-delimited JSON records to that file. There is no route, no response
field, no runtime telemetry, and no behaviour change.

The hook times the Docker inventory read and the Compose filesystem projection
**separately while both still execute inside the same Docker publication
budget**. This baseline is therefore expected to show that Compose projection
currently sits inside the Docker critical path. That is the measurement, not a
fix: **nothing is decoupled here, and #336 owns moving the projection off that
path** — these are the numbers it must improve against.

## Running the benchmark

```
# 1. pin the environment from the runner itself
npm run perf:metadata -- --output /tmp/time-to-answer-metadata.json
# 2. capture (3 controlled runs × 15 warmed samples for every declared cell)
npm run perf:time-to-answer -- \
  --metadata /tmp/time-to-answer-metadata.json \
  --output   /tmp/time-to-answer-baseline.json \
  --raw-dir  /tmp/time-to-answer-raw
# 3. recompute summaries from the raw samples (never trust supplied aggregates)
npm run perf:summarize -- --artifact /tmp/time-to-answer-baseline.json
# 4. compare a candidate against a reviewed baseline (fails closed)
npm run perf:time-to-answer -- \
  --metadata /tmp/time-to-answer-metadata.json \
  --output   /tmp/time-to-answer-candidate.json \
  --baseline /tmp/time-to-answer-baseline.json
```

Prerequisites: a release daemon (`cargo build --release -p dockermap-daemon`),
Chromium for Playwright, and a built web app — the capture performs the contract,
web and probe builds itself. `npm run perf:time-to-answer` is the only command
needed; it owns every process it starts.

**Capture discipline.** The capture refuses to start from a dirty worktree, and
refuses to run if the metadata's `sourceRevision` or `harnessRevision` does not
match the checked-out commits. A baseline is therefore always reproducible from a
committed revision: the artifact names both the product revision and the harness
that measured it. Commit the harness **before** capturing — baseline 1 was
invalidated precisely because its harness existed only as uncommitted changes.
`DOCKERMAP_BENCH_DEBUG=1` relaxes only the run/sample counts (for probing a single
fixture, which can never satisfy the closed matrix and therefore cannot emit an
artifact).

Procedure notes: the benchmark-only Vite build (`tests/perf/benchVite.config.mjs`)
is what stages 8 and 10 run against, and it imports the real production modules;
`tests/perf/browserProbe.js` is test-only instrumentation loaded before product
code. `.bench-dist` is generated and gitignored.

## Current state of this slice

Complete and enforced by tests:

- the closed contract, the 12 stages and their buckets, the fixture set, the
  fixture × stage matrix, the environment allowlist (including the effective SSE
  poll interval), raw-sample validation, the summary math and the promotion gate;
- the deterministic fixture topology and the fixture Docker daemon, proven
  against the real daemon build;
- the inert bench-only stage attribution hook for `dockerObservationMs`,
  `composeEnrichmentMs` and `findingsDerivationMs`;
- the single documented capture command with its benchmark-only browser probes,
  the environment emitter and the summarizer;
- the promotion RED-checks (`timeToAnswerPromotion.test.ts`) and the production
  isolation proof (`productionIsolation.test.mjs`);
- `npm run test:perf` wired into `npm run check:js`.

The first baseline has been captured and interpreted in
`docs/testing/TIME_TO_ANSWER_BASELINE.md`. Baseline 1 identifies the
publication→Node observation floor, cold start and the legacy topology layout as
the dominant costs, and records Composite projection as a measured, currently
coupled cost. No optimization may be claimed until a candidate passes the
promotion gate.
