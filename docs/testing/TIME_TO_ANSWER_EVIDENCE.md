# Time-to-answer evidence

## Methodology-8 Baseline-4 conditioning (authoritative)

For every ordinary warmed end-to-end fixture/run, Baseline-4 performs **exactly
60 fixed burn-in observations**, retains all 60 in harness evidence, then records
**exactly 15 measured observations**. Observation **61** is always the first
measured sample. Burn-in is excluded completely from timing summaries and
promotion comparisons. It is a deterministic, equal conditioning workload for a
baseline and candidate; it makes no claim that 60 guarantees steady state.

No observed value may infer stationarity, adaptively trim samples, select a
per-metric warm-up, or extend the burn-in. Stationarity/drift calculations remain
historical informational diagnostics only and never alter or invalidate an
otherwise structurally valid ordinary run.

The final 60-observation calibration is retained as **REJECTED,
NON-AUTHORITATIVE** audit evidence for Baseline-4. It disproved a common sustained
stationarity validity rule: several metrics stabilized in 2–3 observations,
`findingsDerivationMs` near 13, `legacyTopologyLayoutMs` near 26,
`commandQueryMs` near 43, and `buildModelMs` never met the criterion within 60.
Consequently Baseline-4 does not require calibration PASS, frozen per-metric
counts, the former +2 margin, or the 0.5–1.5x band.

Controlled evidence is distinct: Stage 5 is `controlled-poll-phase`; Stage-6/7
seam isolation is `controlled-stage6-stage7-seam-isolation`. Neither contributes
artificial samples to the normal end-to-end dataset. The normal Stage-6 and
Stage-7 timings remain ordinary end-to-end 60+15 measurements. A composite is
incomplete when required Stage-5 controlled evidence is missing; seam-isolation
evidence is supporting validation rather than a prerequisite for normal timing.

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
- the **stage-6/7 seam-isolation control** (`assertStageSixSevenIndependence`): a
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
- `composeEnrichmentMs` measures asynchronous Compose filesystem correlation
  separately from Docker publication. Compose enrichment no longer consumes the
  Docker publication budget; it is measured as a later enrichment path.
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
separately. The Baseline-4 capture measured them while Compose still executed
inside the Docker publication budget. #336 moves Compose onto an asynchronous
enrichment path, so it no longer consumes that publication budget; the baseline
methodology and its recorded numbers remain unchanged comparison authority.

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

### Diagnostics-only layer capture

The benchmark-mode application also keeps a bounded, in-page diagnostic record
for every coherent model it accepts. The capture harness drains those records to
`layers.jsonl`, alongside `lifecycle.jsonl` for browser, context, page,
navigation, teardown, exception, and closure events. Set
`DOCKERMAP_BENCH_DIAG_DIR` to choose the directory; otherwise they are written
to the capture raw directory (or beside the raw capture output). These JSONL
files are observational only: they are not artifact fields, inputs to timing,
warm-up, stationarity, independence, or promotion rules, and an append failure
cannot change a measurement result. Both the diagnostic identifiers and the
in-page sink are compiled out of the ordinary production web bundle.

## Stage 6/7 controlled seam isolation

Seam isolation is its own dedicated supporting protocol (`npm run perf:independence`,
`tests/perf/captureIndependence.ts`) and is not part of the general end-to-end capture.
For each fixture that declares both stages it runs the normal three controlled runs of
15 measured samples, then `TIME_TO_ANSWER_INDEPENDENCE_SAMPLES` (3) control samples in
which `__dockermapBenchRenderDelayMs = TIME_TO_ANSWER_INDEPENDENCE_DELAY_MS` (250 ms)
withholds a *newly accepted* publication from the render tree — an artificial
presentation delay injected **after** acceptance. It creates and tears down its own
private fixture, daemon, API, benchmark build and browser contexts and refuses partial
output. The rule enforced before validation:

- **stage 6 must not move** by more than `max(30 ms, 25% of its median)`;
- **stage 7 must absorb** at least 70% of the injected delay;
- no control stage-7 sample may be shorter than the injected delay (which would
  mean the delay never reached the page).

The verdict, the per-run sample sets and the per-sample audit trail are written to the
protocol's own `--output` artifact and its `--raw-dir` raw record (the raw record is
retained even when the control fails), and the assembled composite records the verdict in
`<composite>.supporting-evidence.json`. The closed Baseline-4 evidence schema is
unchanged: the control never becomes artifact timing content and its samples are never
Baseline-4 timing rows. At this checkpoint the control's status is **FAIL**
(`[independence] FAIL: Error: control delay did not begin after the acceptance
timestamp`). The same rule is unit-tested (`timeToAnswerIndependence.test.ts`), including
the RED cases "the delayed render does not move stage 7" and "stage 6 moves with the
delayed presentation".

Each control sample arms the browser probe and its one-shot delay before advancing
the fixture generation. The delay is consumed only after the real
`useSystemModel` acceptance timestamp, and the accepted snapshot/runtime-map pair
must have one non-empty matching revision. **Limitation:** the current architecture
cannot reliably observe publication-level causal identity from the benchmark
trigger to that accepted pair. This protocol therefore makes no daemon-publication
attribution claim and does not validate daemon-to-browser attribution; it does not
replace that limitation with timing proximity, sequence proximity, or matching
visible content.

## Running the benchmark

```
# 1. pin the environment from the runner itself
npm run perf:metadata -- --output /tmp/time-to-answer-metadata.json
# 2. end-to-end capture of stages 1-4 and 6-12 (3 controlled runs x 15 measured
# samples per declared cell, after the fixed 60-observation burn-in)
npm run perf:time-to-answer -- \
  --metadata /tmp/time-to-answer-metadata.json \
  --output /tmp/time-to-answer-general.json \
  --raw-dir /tmp/time-to-answer-raw \
  --checkpoint <commit>
# 3. dedicated controlled Stage-5 capture; the only owner of the poll-phase protocol
npm run perf:stage-five -- \
  --metadata /tmp/time-to-answer-metadata.json \
  --output   /tmp/time-to-answer-stage5.json \
  --raw-dir  /tmp/time-to-answer-stage5-raw
# 4. dedicated Stage-6/7 seam-isolation control: supporting evidence only, never a
# Baseline-4 timing row (the companion record states its verdict)
npm run perf:independence -- \
  --metadata /tmp/time-to-answer-metadata.json \
  --output /tmp/stage6-7-seam-isolation.json \
  --raw-dir /tmp/stage6-7-seam-isolation-raw \
  --checkpoint <commit>
# 5. assemble the composite authority from the two raw sections
npx tsx tests/perf/assembleCompositeEvidence.ts \
  --general /tmp/time-to-answer-general.json \
  --stageFive /tmp/time-to-answer-stage5.json \
  --output /tmp/time-to-answer-baseline.json
# 6. recompute summaries from the raw samples (never trust supplied aggregates)
npm run perf:summarize -- --artifact /tmp/time-to-answer-baseline.json
# 7. assemble the candidate's end-to-end and Stage-5 captures into its composite
npx tsx tests/perf/assembleCompositeEvidence.ts \
  --general /tmp/time-to-answer-candidate-general.json \
  --output   /tmp/time-to-answer-candidate.json \
  --stageFive /tmp/time-to-answer-candidate-stage5.json \
  --output /tmp/time-to-answer-candidate.json
# 8. compare the two composite artifacts (fails closed)
npm run perf:promote -- \
  --baseline /tmp/time-to-answer-baseline.json \
  --candidate /tmp/time-to-answer-candidate.json
```

Prerequisites: a release daemon (`cargo build --release -p dockermap-daemon`),
Chromium for Playwright, and a built web app — the capture performs the contract,
production web, benchmark-mode application and module-probe builds itself, and
pins the artifacts it serves before measuring anything. Each benchmark entrypoint
owns every process it starts: the general capture owns the fixture Docker daemon,
the real daemon and API, the production and benchmark builds and real Chromium,
and the dedicated protocols own their own private fixture, daemon, API, server
and browser contexts.

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

### Warm-up calibration protocol (REJECTED — retained as audit evidence only)

This collector is retained as audit evidence. Per-metric stationarity calibration is
**retired**: it does not gate Baseline-4, it supplies no warm-up count, and it is not a
step in the sequence above. The procedure below is recorded so that the retirement is
auditable, not because it is current.

Calibration is an independent, bounded conditioning collector. It never calls the
frozen-count lookup, never enters baseline assembly or normal capture's frozen-count
preflight, and never emits or merges baseline raw evidence. For every
`warmed-repeated` end-to-end metric and each declared reference fixture
(`reference-25`, `reference-100`, `reference-250`), it retains exactly **60 ordered
finite observations** beginning at call zero. This includes daemon-attribution
metrics, browser/API-path metrics, and the module-probe metrics; the probe's ordinary
hidden two-call warm-up is disabled for calibration.

For each fixture trace, candidates `w=2..45` compare the median of observations
`[w-2,w)` with the median of the following 15 observations `[w,w+15)`. A candidate is
stable only if the ratio is within the frozen **0.5–1.5x** band at that candidate and
every later eligible candidate. The fixture value is the earliest sustained `w`; the
metric value is the maximum fixture value plus the frozen safety margin **2**. The
result must have a complete following 15-observation window within the retained 60.
A failure is a calibration conflict:
the collector does not extrapolate, expand the window, retry toward a preferred point,
or select a fixture-specific baseline count.

### Calibration capacity and superseded evidence

Methodology-8 adopts fixed 60+15 conditioning after the final 60-observation
calibration disproved the premise that every metric supports one common sustained
stationarity gate. The calibration capacity, band, and margin are historical
diagnostic details; they are not a Baseline-4 prerequisite.

The rejected 40-observation calibration remains retained evidence, not Baseline-4
authority: `buildModelMs: stable w=25 -> frozen warm-up=27 -> requires 42
observations`. That failure demonstrated insufficient protocol capacity; it does not
itself define the new window.

The external calibration artifact stores its raw ordered cells, constants, pinned
environment, daemon-binary provenance, and complete per-metric derivation trace.
It is persisted with SHA-256 even on conflict, but is **REJECTED,
NON-AUTHORITATIVE** for Baseline-4: no result table may block or alter capture.

No per-metric warm-up count is published. The calibration results were rejected and
never supplied a Baseline-4 parameter, so there is no result table to carry forward.

Procedure notes: stages 8 and 10 run against the benchmark-only module probe
(`tests/perf/benchVite.config.mjs`, real production modules, real Chromium);
stages 6 and 7 run against the benchmark-mode application build
(`tests/perf/benchAppVite.config.mjs`); stages 11 and 12 run against the ordinary
production build. `tests/perf/browserProbe.js` is test-only instrumentation loaded
before product code. `.bench-dist` and `.bench-app-dist` are generated and
gitignored. Every capture also writes `<output>.harness-evidence.json`, which is
not part of the closed artifact schema and carries:

- the general capture's own observation records and its retained burn-in windows;
 the dedicated Stage-6/7 seam-isolation control is NOT part of this file — it runs
 as its own protocol with its own raw directory and its own companion record, and
 its samples never become a Baseline-4 timing row;
- burn-in retention: for every ordinary warmed end-to-end cell the **complete**
 `samples + 60` observation window in order, with fixed burn-in at indices 0–59
 and observations 60–74 proven equal to the recorded run;
- the retained `burnInObservations` map.

The capture refuses to emit an artifact when an ordinary warmed window is missing,
shorter than `samples + 60`, retains anything other than the fixed first 60
observations, or does not match the artifact. Browser and probe stages are held to
the same retained 60+15 structural rule.

## Cold-start versus warmed-repeated stages

The distinction is load-bearing, not descriptive, and the contract encodes it in
`TIME_TO_ANSWER_STAGE_KIND`:

- **cold-start** — `daemonStartToListenerMs`, `listenerToFirstDockerModelMs`. The
  first observation *is* the measurement, so nothing is discarded.
- **warmed-repeated** — every other stage. A repeated operation. The
  daemon's first passes through the collection path are cold (its first refresh
  runs before its listener binds). The protocol therefore declares a **FIXED
 `TIME_TO_ANSWER_END_TO_END_BURN_IN_OBSERVATIONS = 60` burn-in observations BEFORE
 the capture and collects `samples + 60` observations, keeping the first 60 for
 audit and the next 15 as the measured window
  (`splitWarmedObservations` refuses a shorter window). With 15 recorded samples,
  nearest-rank p95 *is* the maximum, so a surviving cold observation would
  otherwise become the published number.
- **scenario cells** — a warmed stage measured on a scenario fixture
  (`isScenarioCell`). They are declared in the closed matrix only for the fixtures
  that construct the scenario.

**Why sixty.** The final calibration showed no common sustained-stationarity rule
for all end-to-end metrics. Sixty is fixed before capture, is not chosen or
extended from observed values, and is equal conditioning rather than a claim that
all metrics reach steady state.

**Stationarity is informational only.** Historical diagnostic calculations may be
retained for audit, but never invalidate a structurally valid run, move observation
61, or cause any sample to be dropped.

Every burn-in observation is retained in the raw audit trail
(`burnInObservations`, keyed `fixture|stage|run`) with the whole observation
window, and none enters a recorded sample, summary, or promotion comparison.

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
- the benchmark-only fixture proxy **arms a unique trigger identity before the
measurement window**, witnesses and retains its exact daemon revision, then releases
that revision at the declared offset after an actual API `/daemon/health` poll. The
following real 2000 ms API poll observes it; no predicted daemon grid is used;
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

### Controlled Stage-5 cells

The composite sources all six `publicationToNodeObservationMs` rows from
`time-to-answer-stage5.json` with the `controlled-poll-phase` protocol:
`reference-25`, `reference-100`, `reference-250`,
`provider-only-revision-change`, `docker-topology-change`, and
`unavailable-optional-provider`. Every row has a declared phase and its reviewed
aggregation is the phase-normalized p95 derived by
`derivedTimeToAnswerSummaries`.

`POLL_PHASE_CONTROLLED_FIXTURES` and `isPhaseControlledFixture` select the
reference fixtures plus `docker-topology-change` for the summary's dedicated
per-phase curve table. That table selection does not exempt the two provider-driven
fixtures from their controlled-poll-phase composite rows or phase-normalized
reviewed value.

The provider-driven fixtures derive their new revision from the daemon's fixed
host-provider scheduler while the API SSE poller remains pinned at 2000 ms. This is
structural context, not a phase-ownership exemption; their values are not real-user
latency, random production latency, or network latency.

## Baseline-4 composite capture

Baseline 4 is a composite artifact with three raw evidence sections. The general
capture records only `end-to-end` cells, including the normal Stage-6 and
Stage-7 timing rows. The dedicated Stage-5 sub-benchmark
records every `publicationToNodeObservationMs` cell with
`controlled-poll-phase`; it is the sole owner of the arm → mark → trigger →
identity-ack protocol. The sections are not pooled: every composite record
names its fixture, stage, measurement protocol, source evidence file and
committed checkpoint SHA. The dedicated Stage-6/7 seam-isolation protocol is
`controlled-stage6-stage7-seam-isolation`: it observes acceptance at the real
`useSystemModel` coherent snapshot/runtime-map seam, requires an internally
coherent accepted pair, and applies its 250 ms delay only after that acceptance.
Its supporting-evidence companion is **FAIL** at this checkpoint: `[independence]
FAIL: Error: control delay did not begin after the acceptance timestamp`. It records
the exact limitation `publication-level causal identity unavailable` and
`validatesDaemonToBrowserAttribution: false`; it makes no daemon-publication
attribution claim. Its samples are never Baseline-4 timing
observations and cannot replace or contaminate the normal end-to-end Stage-6/7
rows. Assembly rejects a missing Stage-5 section, duplicate declared cell, wrong
protocol, mismatched methodology/checkpoint, or invalid supplied seam-isolation
evidence; absence of this supporting control does not prevent the normal 60
burn-in + 15 measured Baseline-4 timings from existing. The seam-isolation entrypoint is self-orchestrating under the trusted capture
invocation: it owns a private fixture, real daemon/API/SSE path, benchmark build,
fresh browser contexts, and `finally` teardown. It retains diagnostics only under
the dedicated protocol directory and refuses partial output.

The Stage-5 metric and phase-normalized authority are unchanged. Conditioning is a
fixed 60-observation burn-in followed by 15 measured observations, with every
burn-in retained and no stationarity gate. The phase grid, 90 ms tolerance,
Stage-6/7 semantics and the production 2000 ms poller are also unchanged.

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
  44-cell fixture-by-stage matrix, the environment allowlist (including the
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
- the dedicated controlled Stage-5 protocol, the sole owner of arm → mark →
  trigger → identity-ack; it has no Stage-5 timing cell in the general capture;
- the dedicated, self-orchestrating Stage-6/7 seam-isolation control as supporting
  evidence, unit-tested against its RED cases;
- the fixed 60-observation burn-in plus 15 measured conditioning, with every
  burn-in retained and no stationarity gate;
- the capture's runtime premise assertions, and the documented general capture,
  Stage-5 capture, assembly, and summary commands with their browser probes and
  environment emitter;
- the promotion RED-checks (`timeToAnswerPromotion.test.ts`), the independence
  RED-checks (`timeToAnswerIndependence.test.ts`) and the production isolation
  proof (`productionIsolation.test.mjs`);
- the phase-sweep RED-checks (`timeToAnswerPollPhase.test.ts`) alongside
  `npm run perf:phase-control`, which records intended and observed phase, trigger
  identity, phase error and grid span and fails RED on a substituted or uncontrolled
  publication; and
- `npm run test:perf` wired into `npm run check:js`.

`docs/testing/TIME_TO_ANSWER_BASELINE.md` is the baseline record. Baseline 3 (from
committed revision `cf77e8ba`) was **REJECTED** in round-3 review and is not the
authority for anything: its stage-5 sweep did not sweep, its warm-up policy left a
cold observation inside the measured window, its promotion gate treated the rebuilt
daemon digest as a compatibility key, and it documented a post-run binary
verification the code did not perform.
