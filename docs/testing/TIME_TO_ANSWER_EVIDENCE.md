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
- the **exact fixture × stage matrix** — **44 cells** — derived from each stage's
  fixture list, never hand-listed;
- the **pinned environment allowlist** (runner class, CPU class, OS image and
  kernel, Node/Rust/Docker revisions, Chromium revision and flags, font
  environment, production build mode, fixture revision, source revision);
- **raw-sample validation**: 15 warmed samples in each of 3 complete controlled
  runs, nearest-rank p95 per run, median of the three run p95 values except that
  controlled stage 5 is reviewed and promoted by its phase-normalized p95;
- the **stage-6/7 independence control** (`assertStageSixSevenIndependence`): a
  positive artificial presentation delay injected *after* coherent-model
  acceptance must move stage 7 by at least 70% of that delay and must not move
  stage 6 beyond `max(30 ms, 25%)`;
- the **promotion gate** `max(baseline × 1.25, baseline + 2 ms)`, compared only
  between environments that match on every pinned field except `sourceRevision`
  (which differs by design) and `dockerRevision` (recorded but informational: no
  measured stage exercises the host Docker daemon). The other 15 fields must
  match.

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
| browser-model | notificationToCoherentModelMs, buildModelMs | how long the browser needs to turn it into a model |
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

**Generation delta.** The harness can advance a fixture's topology generation
(`POST /__fixture/topology-generation/<n>`), which changes the container
identities/labels and stops the first `n` containers. Generation 0 is the pristine
all-running inventory for every fixture; generation `n` therefore makes the
product render exactly `n` offline/attention services, which is what the stage-7
expected-content check asserts (`expectedExitedCount` derives the expectation from
the same generator the fixture daemon serves). Earlier revisions of this harness
gave `docker-topology-change` a fixed one-in-three exited mix; that mix is gone,
because a constant mix cannot discriminate a stale render from a fresh one.

**Scenario premises are asserted, not named.** The capture fails when
`provider-only-revision-change`'s Docker inventory changes, when the
`unavailable-optional-provider` fixture's optional provider is fresh, and when the
`slow-bounded-compose-projection` project does not actually declare its
`SLOW_COMPOSE_SERVICES = 400` services — an empty or truncated project would
otherwise record a cell and look like a fast projection. The `docker-topology-change`
and reference fixtures need no extra premise: the stage-7 expected-content check
binds them to the generation the harness triggered.

## Promotion rules

A candidate passes only when, in an equivalent controlled environment, **every**
fixture × stage value is at most `max(baseline × 1.25, baseline + 2 ms)`. Limits
are derived from the measured baseline, never invented as aspirational absolute
milliseconds. A candidate that fails the environment check fails closed; it is
not "close enough".

**Provenance is not compatibility.** The environment records 20 pinned fields, and
they are used in three different ways:

| use | fields | how it is treated |
| --- | --- | --- |
| comparison requirements (16) | `runnerClass`, `cpuClass`, `osImage`, `osKernel`, `nodeRevision`, `rustRevision`, `ssePollIntervalMs`, `daemonBinaryBuild`, `cargoRevision`, `browserEngine`, `browserRevision`, `browserFlags`, `fontEnvironment`, `buildMode`, `fixtureRevision`, `methodologyVersion` | must be identical, or the comparison fails closed |
| provenance/identity (3) | `sourceRevision`, `harnessRevision`, `daemonBinarySha256` | recorded so the artifact identifies exactly what was measured; NEVER required to match |
| informational (1) | `dockerRevision` | recorded because it is part of the runner's identity; no measured stage exercises the host Docker daemon |

`daemonBinarySha256` in particular must not gate a comparison: the candidate's
daemon is **rebuilt from the candidate checkout**, so any legitimate change under
`crates/` — exactly what #336 does — produces a different digest, and a
byte-identical digest is not reproducible across a changed `CARGO_HOME`.

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

## Stage 6 and stage 7: two clocks, and why they cannot be one

The two browser stages answer different questions and must not share a clock.

- **Stage 6 — `notificationToCoherentModelMs`.** Starts when the real stream
  notifies the browser of a new model revision. Ends when the **application
  accepts one coherent model** — the instant a fetched snapshot/runtime pair with
  matching generation, provenance and non-empty model revision becomes the model
  the UI renders.
- **Stage 7 — `coherentModelToUsefulRenderMs`.** Starts at the *stage-6
  timestamp*. Ends when the accepted model's **expected Home content is present**,
  in a commit the application stamped with that accepted revision, followed by a
  **bounded render/presentation confirmation**: the probe discovers the commit from
  an animation-frame loop and then awaits a bounded frame after it, so the
  end-of-stage segment is one or two frames rather than a fixed number. No sleeps
  are involved, and the raw audit records the commit→end duration of every sample so
  the mechanism is checkable rather than asserted.

Stage 6 is observed at the **real application seam**: the acceptance point is
inside `useSystemModel`, at the moment the composed model is published. It is
never inferred from a DOM mutation — baseline 2 was rejected precisely because
its stage 7 was element-for-element identical to stage 6 in all 180 samples.

Stage 6 has two measurement modes, and which one applies is decided by the closed
matrix, never by the sample:

- **content mode** — for every fixture that also declares stage 7: the sample ends
  only when the (accepted model, rendered content) pair that carries the expected
  Home content for the triggered change is observed, so an intermediate
  publication that moves no Home metric cannot be mis-attributed to the sample.
- **acceptance-only mode** — for the two provider-state fixtures, whose published
  revision deliberately carries no inventory change: stage 6 ends at the
  acceptance instant, and stage 7 is not declared for them (requiring a Home
  repaint there would be an empty number).

**Expected content, not just any repaint.** The fixture's generation delta stops
the first `g` containers, so generation `g` renders exactly `g` offline/attention
services. Stage 7 requires the Home metric region to repaint with that exact value
for the accepted revision, so a stale render, an unrelated repaint (such as the
topbar clock) or a render belonging to a different revision cannot end it. The
probe records the pre-change metric value as it arms, so "the DOM changed" is
measured rather than assumed.

**The chain of custody is checked.** For every browser sample the harness records
which paired API fetch delivered the accepted revision and which notification
preceded that fetch cycle, so stage 6 starts at a notification that provably caused
the fetch the model came from. It does **not** require the accepted revision to
equal a revision this harness's own stream announced: the daemon is read per
request, so `/daemon/health` (what the stream carries) and `/daemon/snapshot` (what
the accepted pair carries) can hold different revisions while a host is churning,
and every SSE connection polls on its own phase. The overlap with the harness's own
stream is recorded as evidence (`acceptedRevisionInApiStream`), and for every cell
that declares stage 7 the accepted revision is additionally bound to the fixture's
triggered generation by the expected-content check.

## Benchmark-mode application build and production isolation

Stage 6 needs a signal that only exists in application code, so the seam is
**real product source** (`apps/web/src/lib/performance/modelAcceptance.tsx`) and
the build decides whether it exists:

| build | flag | what it contains |
| --- | --- | --- |
| production (`apps/web/vite.config.ts`) | `__DOCKERMAP_BENCH_ACCEPTANCE__ = "false"` | no seam, no event identifier, no probe entry, no delay machinery |
| benchmark mode (`tests/perf/benchAppVite.config.mjs`) | `__DOCKERMAP_BENCH_ACCEPTANCE__ = "true"` | the same real app **with** the acceptance seam |
| benchmark probe (`tests/perf/benchVite.config.mjs`) | — | stages 8 and 10 (real `buildModel`/`layout` modules, in Chromium) |

The application source is never copied or forked: the same files are built twice.
The product build eliminates every benchmark branch by dead-code elimination
before minification, and that is asserted against the built artifact — the
production bundle must not contain `__dockermapBenchAcceptanceSink`,
`__dockermapBenchRenderDelayMs`, `dockermapAcceptedRevision` or any harness
identifier (`tests/perf/productionIsolation.test.mjs`), and the capture refuses to
run at all unless the benchmark-mode build carries the seam and the production
build does not (`assertBuildIsolation`). The production Vite config must define
the flag as the literal `"false"`, which the same suite checks by reading it.

Which build serves which stage: stages **6 and 7** are measured on the
benchmark-mode application build, **stage 11 (Cmd-K)** and **stage 12 (production
bundle/startup)** on the ordinary production build, and **stages 8 and 10** on the
benchmark-only module probe. The seam emits only an opaque timestamp plus the
model revision token, into an in-memory page sink, and stamps the same opaque
token on the document root so a DOM repaint can be attributed to a revision.
There is no product payload, no network call, no telemetry and no analytics, and
the seam adds no route, no API field and no public schema.

## Stage 6/7 independence control

A capture may not produce a baseline unless it can show the two clocks are
independent. After the normal samples for each fixture that declares both stages,
the harness runs `TIME_TO_ANSWER_INDEPENDENCE_SAMPLES` (3) control samples in
which `__dockermapBenchRenderDelayMs = TIME_TO_ANSWER_INDEPENDENCE_DELAY_MS`
(250 ms) withholds a *newly accepted* publication from the render tree — an
artificial presentation delay injected **after** acceptance. The rule enforced
before validation:

- **stage 6 must not move** by more than `max(30 ms, 25% of its median)`;
- **stage 7 must absorb** at least 70% of the injected delay;
- no control stage-7 sample may be shorter than the injected delay (which would
  mean the delay never reached the page).

The verdict, the per-run sample sets and a per-sample audit trail (accepted
revision, notified revision, render commit offset, metric before/after) are
written beside the artifact in `<output>.harness-evidence.json`. The closed
evidence schema is unchanged: the control is harness evidence, not artifact
content. The same rule is unit-tested (`timeToAnswerIndependence.test.ts`),
including the RED cases "the delayed render does not move stage 7" and "stage 6
moves with the delayed presentation".

Each control sample first arms the browser probe, then records an explicit
publication-trigger checkpoint immediately before advancing the fixture
generation. The probe excludes all accepted revisions, notifications and paired
fetches preceding that checkpoint. The harness then uses a bounded observation
of fixture, daemon and API inventory (including counts and revisions) rather
than a fixed sleep; its audit records the trigger checkpoint and publication
observation with the normal acceptance/render evidence.

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
production web, benchmark-mode application and module-probe builds itself, and
pins the artifacts it serves before measuring anything. `npm run
perf:time-to-answer` is the only command needed; it owns every process it starts.

**Capture discipline.** The capture refuses to start from a dirty worktree, and
refuses to run if the metadata's `sourceRevision`, `harnessRevision` or
`methodologyVersion` does not match the checked-out commit and the contract. A
baseline is therefore always reproducible from a committed revision: the artifact
names both the product revision and the harness that measured it, and the design it
was measured under. Commit the harness **before** capturing — baseline 1 was
invalidated precisely because its harness existed only as uncommitted changes — and
run the focused smoke (`DOCKERMAP_BENCH_DEBUG=1` with `--fixtures`, which relaxes
only the run/sample counts for probing and can never emit an artifact) before
spending a full capture.

Procedure notes: stages 8 and 10 run against the benchmark-only module probe
(`tests/perf/benchVite.config.mjs`, real production modules, real Chromium);
stages 6 and 7 run against the benchmark-mode application build
(`tests/perf/benchAppVite.config.mjs`); stages 11 and 12 run against the ordinary
production build. `tests/perf/browserProbe.js` is test-only instrumentation loaded
before product code. `.bench-dist` and `.bench-app-dist` are generated and
gitignored. Every capture also writes `<output>.harness-evidence.json`, which is
not part of the closed artifact schema and carries:

- the stage-6/7 independence control (verdict, per-run sample sets, and a
  per-sample audit of accepted revision, notification, skipped acceptances, render
  commit offset, frame confirmation and metric before/after);
- warm-up retention: for every daemon-side warmed cell the **complete**
  `samples + 5` observation window in the order the daemon produced it, with the
  fixed warm-ups at indices 0–4 and the recorded samples proven equal to the run
  stored in the artifact;
- the retained `warmUpObservations` map.

The capture refuses to emit an artifact when a daemon-side warmed window is missing,
shorter than `samples + 5`, retains anything other than the fixed first five
observations, or does not match the artifact — so a slow warm-up value cannot be
hidden. Browser and probe stages perform their own warm-up inside their test-only
probes and cannot retain daemon observation windows because no daemon bench sink
produces those stages.

## Cold-start versus warmed-repeated stages

The distinction is load-bearing, not descriptive, and the contract encodes it in
`TIME_TO_ANSWER_STAGE_KIND`:

- **cold-start** — `daemonStartToListenerMs`, `listenerToFirstDockerModelMs`. The
  first observation *is* the measurement, so nothing is discarded.
- **warmed-repeated** — every other stage. A repeated steady-state operation. The
  daemon's first passes through the collection path are cold (its first refresh
  runs before its listener binds). The protocol therefore declares a **FIXED
  `TIME_TO_ANSWER_WARM_UP_OBSERVATIONS = 5` warm-up observations BEFORE the capture
  and collects `samples + 5` observations for the warmed daemon stages, keeping the
  first five as warm-up and the next 15 as the measured window
  (`splitWarmedObservations` refuses a shorter window). With 15 recorded samples,
  nearest-rank p95 *is* the maximum, so a surviving cold observation would
  otherwise become the published number.
- **scenario cells** — a warmed stage measured on a scenario fixture
  (`isScenarioCell`). They are declared in the closed matrix only for the fixtures
  that construct the scenario.

**Why five.** The count was fixed from the round-3 raw windows before this
methodology existed, not chosen afterwards to make data look stationary: in those
windows the discarded first observation reached 4.01× the window median and the
SECOND — the first one the old single-discard policy published — still reached
2.15× in 5 of 30 windows, while every observation from index 5 on stayed within
1.29×.

**Stationarity is a validity check, never a repair.** `assertWarmUpStationarity`
compares the median of the final two warm-up observations against the median of the
measured window and requires a ratio inside the declared `0.5×–1.5×` band (the
round-3 windows scored 0.81–1.28 at five warm-ups). A window outside that band
**invalidates the cell/run**; the harness never discards further samples to make a
window pass, because choosing how many samples to drop after seeing the values
would turn conditioning into result selection.

Every warm-up observation is retained in the raw audit trail
(`warmUpObservations`, keyed `fixture|stage|run`) with the whole observation window
and the stationarity ratio, and none of them ever enters a recorded sample, a
summary, or a promotion comparison.

## Capture discipline

The capture refuses to start from a dirty worktree and refuses to run when the
metadata's `sourceRevision` or `harnessRevision` does not match the checked-out
commits, so a baseline is always reproducible from a **committed** revision:

- `sourceRevision` — the product revision the numbers describe.
- `harnessRevision` — the last commit touching `tests/perf` and the performance
  contract, i.e. the harness that produced them.

Reproducing a recorded baseline therefore requires checking out the revision the
artifact names; re-emitting metadata at a different commit produces a different
artifact by design.

## Daemon binary provenance

Stages 1-5 and 9 all come from the release daemon executable, so it is pinned:

```
cargo build --release --locked -p dockermap-daemon --manifest-path crates/Cargo.toml
sha256(crates/target/release/dockermap-daemon)       # daemonBinarySha256
```

`emit-metadata` performs that build and records `daemonBinarySha256`,
`daemonBinaryBuild` and `cargoRevision`. The capture verifies the digest **before**
the run and **again after** it — the daemon is spawned repeatedly during a long
capture, so a mid-run substitution or rebuild would otherwise be invisible — and
fails closed on mismatch or on a substituted executable
(`assertDaemonBinaryProvenance`). Both digests and the build command are recorded in
the harness evidence beside the artifact. This proves which binary *this* capture
executed; it is **provenance, not a promotion compatibility requirement** (see
"Promotion rules").

## Stage 5 — the deterministic poll-phase sweep

The baseline measures today's real publication→observation mechanism **including
its poll wait**, and it *drives* the publication phase instead of hoping for one.

Baseline 3 disproved the earlier hope: it slept a uniform random delay before each
trigger, and reference-25's 45 samples still occupied a **120 ms band of the
2000 ms interval (6.0 %)** with consecutive differences under 19 ms — because both
the daemon's refresh loop and the API's poller run on fixed 2 s cycles, so the
measured gap was their phase offset rather than a sample of any distribution.

The declared design (`timeToAnswerPollPhase.ts`, methodology revision 2):

- the poll interval is divided into **10 equal divisions**; phase `p` places the
  publication at `(p + 0.5) × interval / 10`, so the intended latency is
  `interval − that offset` and no phase sits on a poll tick boundary (where a
  publication is inherently ambiguous);
- each controlled 15-sample run sweeps the phases **ascending** and repeats phases
  0–4. Every raw sample's phase is recoverable from its position in its run; every
  phase is represented at least twice, and repeated phases contribute all their
  observations to that phase's median without giving that phase extra weight in the
  normalized result;
- the harness **controls the phase by choosing when it connects** its observation
  stream: the API emits to each connected client on a `setInterval` anchored to that
  connection, so connecting at `predicted publication − declared phase` puts the
  next poll tick at the intended latency after the publication. The prediction comes
  from the daemon's own observed publication grid;
- each sample then **verifies** itself: the observed publication must match the
  prediction, the observed latency must land on the declared phase within a **90 ms
  tolerance** (the grid step is 200 ms, so adjacent phases stay distinguishable), and
  the observation must have arrived through the real API stream. The capture also
  asserts that the application page never contacted the daemon directly.

Before accepting a capture, `assertPollPhaseSweep` requires that every declared
phase is represented at least twice, that no sample's phase was uncontrolled, that
all observations travelled the real poller path, that the sweep spans at least half
the interval, and that the earliest declared phase is faster than the latest by at
least half an interval. **A sweep confined to a narrow band is rejected** — that is
a RED test, not an aspiration.

The reported figures are:

- the **phase curve** — declared phase → observed latency (min, max, median per
  phase), the most direct statement about the existing mechanism; and
- a **phase-normalized p95**, computed from the predeclared uniform grid by taking
  observed median at each declared phase and then nearest-rank p95 over those
  medians. It is the controlled stage-5 review and promotion authority; ordinary
  per-run p95 remains diagnostic only. It weights the declared phases uniformly to characterise the latency the
  fixed polling mechanism imposes. **It does not claim that real host publications
  occur uniformly across poll phase**, and it is neither an observed user-traffic
  distribution nor network latency.

`publicationToNodeObservationMs` must never be described as network latency, and
the production cadence is deliberately unchanged: removing this floor is #337's
work, not this issue's.

### Free-running provider-driven cells

`provider-only-revision-change` and `unavailable-optional-provider` are the two
**free-running** stage-5 cells. They are deliberately excluded from
`POLL_PHASE_CONTROLLED_FIXTURES`; all reference fixtures and
`docker-topology-change` are phase-controlled.

The exclusion is structural, not a missing harness feature. These fixtures obtain
their new revision from the daemon's fixed host-provider scheduler, while the API
SSE poller has the pinned 2000 ms interval. The scheduler's completion-relative
slots are 10 s, 15 s, or 60 s (`slot_interval` in
`crates/dockermap-daemon/src/runtime_collection.rs`), each an integer multiple of
2000 ms. Their observed publication phase is therefore structurally pinned to the
poller cadence; placing it would require changing production provider polling,
which this read-only measurement work must not do.

For these cells, the harness does claim a real observation through the real
**API-SSE poller path**: it records the new revision and the phase achieved, and
asserts the fixture premise (unchanged Docker inventory for
`provider-only-revision-change`; a non-fresh optional provider for
`unavailable-optional-provider`). Their matrix value is that premise coverage,
together with their stage-6 acceptance and stage-7 applicability boundary.

They do **not** claim a phase sweep or phase coverage, a phase-normalized scalar,
a span or direction guarantee, or p95 authority. They are **excluded from the
phase-normalized scalar** used for #337 comparison. Nor are their values real-user
latency, random production latency, network latency, or a Stage-5
characterisation. `assertFreeRunningPhaseSamples`, rather than
`assertPollPhaseSweep`, enforces this limited contract.

## Superseded captures

Baseline 1, baseline 2 **and baseline 3** are **REJECTED historical attempts** and
are not the authority for anything. Their artifacts are kept outside the repository
in `/srv/jonas/evidence/dockermap/` (baselines 1 and 2) and
`/srv/jonas/evidence/dockermap/time-to-answer/` (baseline 3, with its harness
evidence). Their numbers may be cited only to explain methodology changes, never as
current measurements and never for promotion gating. Baseline 3 was rejected
because its stage-5 samples were a phase-locked sawtooth rather than a sweep of the
poll interval, its single discarded warm-up still left a 2.15×-of-median
observation inside the measured window, it gated promotion on the rebuilt daemon
digest, and it documented a post-run binary verification the code did not perform.

## Current state of this slice

Complete and enforced by tests:

- the closed contract, the 12 stages and their buckets, the fixture set, the
  44-cell fixture × stage matrix, the environment allowlist (including the
  effective SSE poll interval), raw-sample validation, the summary math and the
  promotion gate;
- the deterministic fixture topology (whose generation delta is product-visible,
  so the stage-7 expected-content check is discriminating) and the fixture Docker
  daemon, proven against the real daemon build;
- the inert bench-only stage attribution hook for `dockerObservationMs`,
  `composeEnrichmentMs` and `findingsDerivationMs`;
- the stage-6 coherent-model acceptance seam in real product source, compiled out
  of the production build and compiled into the benchmark-mode application build,
  with the stage-7 expected-content + single-frame end condition and the
  chain-of-custody check from daemon revision to rendered content;
- the stage-6/7 independence control, enforced before any artifact is assembled
  and unit-tested against its RED cases;
- the single documented capture command with its browser probes, the environment
  emitter and the summarizer;
- the promotion RED-checks (`timeToAnswerPromotion.test.ts`), the independence
  RED-checks (`timeToAnswerIndependence.test.ts`) and the production isolation
  proof (`productionIsolation.test.mjs`);
- `npm run test:perf` wired into `npm run check:js`.

`docs/testing/TIME_TO_ANSWER_BASELINE.md` is the baseline record. Baseline 3 (from
committed revision `cf77e8ba`) was **REJECTED** in round-3 review and is not the
authority for anything: its stage-5 sweep did not sweep, its warm-up policy left a
cold observation inside the measured window, its promotion gate treated the rebuilt
daemon digest as a compatibility key, and it documented a post-run binary
verification the code did not perform.

The response is a **methodology revision** (`TIME_TO_ANSWER_METHODOLOGY =
dockermap-v1/time-to-answer-methodology-2`), not a retry: the deterministic
stage-5 poll-phase sweep with its validity guards and phase-normalized summary, a
fixed five-observation warm-up protocol with a declared stationarity check, the
provenance/compatibility split, and the implemented before/after binary
verification. The revised methodology is pinned in the emitted metadata and the
capture refuses to run when the metadata names a different design.

Complete and enforced by tests:

- the closed contract, the 12 stages and their buckets, the fixture set, the
  44-cell fixture × stage matrix, the environment allowlist (including the
  effective SSE poll interval and the methodology version), raw-sample validation,
  the summary math and the promotion gate;
- the deterministic fixture topology (whose generation delta is product-visible,
  so the stage-7 expected-content check is discriminating) and the fixture Docker
  daemon, proven against the real daemon build;
- the inert bench-only stage attribution hook for `dockerObservationMs`,
  `composeEnrichmentMs` and `findingsDerivationMs`;
- the stage-5 poll-phase design: the declared grid, the driven phase, the
  per-sample declaration/observation records and the validity guards
  (`timeToAnswerPollPhase.test.ts`, including the narrow-band RED case);
- the stage-6 coherent-model acceptance seam in real product source, compiled out
  of the production build and compiled into the benchmark-mode application build,
  with the stage-7 expected-content + bounded-presentation end condition and the
  chain-of-custody check from daemon revision to rendered content;
- the stage-6/7 independence control, enforced before any artifact is assembled
  and unit-tested against its RED cases;
- the fixed warm-up protocol and its stationarity guard, with every warm-up
  retained in the raw audit trail;
- the capture's runtime premise assertions (provider-only inventory unchanged,
  optional provider non-fresh, slow-Compose project really declared, and the
  application page never reaching the daemon directly);
- the single documented capture command with its browser probes, the environment
  emitter, the methodology drift guard and the summarizer;
- the promotion RED-checks (`timeToAnswerPromotion.test.ts`), the independence
  RED-checks (`timeToAnswerIndependence.test.ts`), the phase-sweep RED-checks
  (`timeToAnswerPollPhase.test.ts`) and the production isolation proof
  (`productionIsolation.test.mjs`);
- `npm run test:perf` wired into `npm run check:js`.
