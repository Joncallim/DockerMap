#!/usr/bin/env node
/**
 * DockerMap time-to-answer capture (#335) — the single documented command.
 *
 *   npm run perf:time-to-answer -- \
 *     --metadata /controlled/time-to-answer-metadata.json \
 *     --output   /controlled/time-to-answer-baseline.json \
 *     [--baseline /controlled/previous-baseline.json] [--raw-dir /controlled/raw]
 *
 * It owns every test process: the deterministic fixture Docker daemon, the real
 * daemon (with bench attribution), the real API, the production web build, the
 * benchmark-only probe build, and real Chromium.
 *
 * It fails closed. A missing environment field, a failed process, a missing
 * stage or an incomplete sample set aborts the capture instead of emitting a
 * partial artifact; whatever raw samples were gathered are preserved next to
 * the output for diagnosis.
 *
 * It never touches the live DockerMap deployment: all ports are reserved from
 * the OS, every socket and directory is private to the run, and children are
 * torn down by process group — never by pattern matching.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  TIME_TO_ANSWER_BASELINE,
  TIME_TO_ANSWER_CONTROLLED_RUNS,
  TIME_TO_ANSWER_INDEPENDENCE_DELAY_MS,
  TIME_TO_ANSWER_INDEPENDENCE_SAMPLES,
  TIME_TO_ANSWER_INDEPENDENCE_SETTLE_MS,
  TIME_TO_ANSWER_MATRIX,
  TIME_TO_ANSWER_METHODOLOGY,
  TIME_TO_ANSWER_REFERENCE_FIXTURES,
  TIME_TO_ANSWER_STAGES,
  TIME_TO_ANSWER_STAGE_KIND,
  TIME_TO_ANSWER_WARMED_SAMPLES,
  TIME_TO_ANSWER_WARM_UP_OBSERVATIONS,
  assertDaemonBinaryProvenance,
  assertStageSixSevenIndependence,
  assertTimeToAnswerEnvironment,
  assertTimeToAnswerPromotion,
  assertWarmUpStationarity,
  derivedTimeToAnswerPhaseNormalized,
  splitWarmedObservations,
  validateTimeToAnswerEvidence
} from "../../apps/web/src/lib/performance/timeToAnswerEvidence";
import {
  POLL_PHASE_CONTROL_TOLERANCE_MS,
  POLL_PHASE_DIVISIONS,
  POLL_PHASE_MIN_SAMPLES_PER_PHASE,
  assertPollPhaseSweep,
  declaredPhaseForSample,
  intendedLatencyMs,
  observedPhaseBucketMs,
  phaseMediansMs,
  pollPhaseGridMs,
  type PollPhaseSweep
} from "../../apps/web/src/lib/performance/timeToAnswerPollPhase";
import { FIXTURE_REVISION, SLOW_COMPOSE_SERVICES, buildSlowComposeProject, expectedExitedCount } from "./dockerFixtureTopology.mjs";
import { reservePort, startStaticServer } from "./staticServer.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const nowMs = () => Number(process.hrtime.bigint()) / 1e6;

type RawSamples = Record<string, Record<string, number[][]>>;
type ProbeMeasurement = { buildModelMs: number[]; legacyTopologyLayoutMs: number[] };

function parseArgs(argv: string[]): Record<string, string> {
  return Object.fromEntries(
    argv.flatMap((value, index, all) =>
      value.startsWith("--") ? [[value.slice(2), all[index + 1] ?? ""]] : []
    )
  );
}

const args = parseArgs(process.argv.slice(2));
const metadataPath = args.metadata;
const outputPath = args.output;
const baselinePath = args.baseline;
const rawDir = args["raw-dir"];
const runs = Number(args.runs ?? TIME_TO_ANSWER_CONTROLLED_RUNS);
const samples = Number(args.samples ?? TIME_TO_ANSWER_WARMED_SAMPLES);
const onlyFixtures = args.fixtures ? args.fixtures.split(",").map((name) => name.trim()) : null;
if (onlyFixtures && process.env.DOCKERMAP_BENCH_DEBUG !== "1") {
  throw new Error(
    "--fixtures only exists for probing individual fixtures during development; a partial run can never satisfy the closed matrix, so gate it behind DOCKERMAP_BENCH_DEBUG=1."
  );
}
/**
 * Fixture-derived Cmd-K query token: container 0 always carries this name.
 * The poll interval is derived after the environment is parsed, below.
 */
const FixtureTopologyQueryToken = "fixture-service-0";

/**
 * The Home metric the stage-7 "expected content" check asserts. The fixture's
 * generation delta changes exactly this metric (generation `g` stops the first
 * `g` containers), so the check is discriminating: a stale render — or a render
 * that belongs to a different revision — cannot satisfy it.
 */
const HomeMetricLabel = "Offline";

if (!metadataPath || !outputPath) {
  throw new Error(
    "Usage: npm run perf:time-to-answer -- --metadata <pinned-environment.json> --output <artifact.json>"
  );
}
if (
  (runs !== TIME_TO_ANSWER_CONTROLLED_RUNS || samples !== TIME_TO_ANSWER_WARMED_SAMPLES) &&
  process.env.DOCKERMAP_BENCH_DEBUG !== "1"
) {
  throw new Error(
    `The contract requires exactly ${TIME_TO_ANSWER_CONTROLLED_RUNS} controlled runs and ${TIME_TO_ANSWER_WARMED_SAMPLES} warmed samples per cell.`
  );
}

const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
  environment: unknown;
  daemonBinary?: string;
};
assertTimeToAnswerEnvironment(metadata.environment);
const environment = metadata.environment;

/**
 * The effective SSE poll interval. It is passed to the API explicitly so the
 * recorded pin cannot drift from the interval that ran, and it defines the stage-5
 * phase grid the harness drives: the publication phase relative to the observation
 * stream's poll ticks is chosen from a declared grid over this interval, never left
 * to a random trigger delay.
 */
const pollIntervalMs = Number(environment.ssePollIntervalMs);
if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
  throw new Error("the pinned ssePollIntervalMs must be a positive number");
}

// A baseline is only reproducible if the code that measured it is committed.
// The refusal is deliberate: an uncommitted harness produces numbers nobody can
// re-derive, which is exactly how baseline 1 was invalidated in review.
function gitOutput(gitArgs: string[]): string {
  return run("git", gitArgs).trim();
}
const dirtyTree = gitOutput(["status", "--porcelain"]);
if (dirtyTree !== "") {
  throw new Error(
    `refusing to capture from a dirty worktree — commit the harness first so the baseline is reproducible:\n${dirtyTree}`
  );
}
const productRevision = gitOutput(["rev-parse", "HEAD"]);
if (environment.sourceRevision !== productRevision) {
  throw new Error(
    `metadata sourceRevision (${environment.sourceRevision}) is not the checked-out commit (${productRevision}); re-emit the metadata so the artifact names the revision it actually measured`
  );
}
const harnessRevision = gitOutput(["log", "-1", "--format=%H", "--", "tests/perf", "apps/web/src/lib/performance"]);
if (environment.harnessRevision !== harnessRevision) {
  throw new Error(
    `metadata harnessRevision (${environment.harnessRevision}) is not the harness commit (${harnessRevision})`
  );
}
// The methodology is part of the measurement, not metadata trivia: a candidate is
// only comparable against a baseline captured under the same design (stage-5 phase
// control, fixed warm-up protocol, stationarity guard, provenance/compatibility
// split). A stale metadata file must not silently capture under the old design.
if (environment.methodologyVersion !== TIME_TO_ANSWER_METHODOLOGY) {
  throw new Error(
    `metadata methodologyVersion (${environment.methodologyVersion}) is not the contract's ` +
      `(${TIME_TO_ANSWER_METHODOLOGY}); re-emit the metadata so the artifact names the design it measured`
  );
}
const daemonBinary = metadata.daemonBinary ?? join(REPO_ROOT, "crates/target/release/dockermap-daemon");
// Bind the executed binary to the recorded revision before and after the run:
// stages 1/2/3/4/5/9 all come from this executable, so a stale or substituted
// binary would misattribute every daemon-side number.
function currentDaemonSha256(): string {
  return createHash("sha256").update(readFileSync(daemonBinary)).digest("hex");
}
assertDaemonBinaryProvenance({
  expectedSha256: environment.daemonBinarySha256,
  observedSha256: currentDaemonSha256(),
  phase: "before capture"
});
const daemonBinarySha256Before = currentDaemonSha256();
const launchArgs = (environment.browserFlags as string[]).filter(Boolean);

const plans = TIME_TO_ANSWER_REFERENCE_FIXTURES.filter(
  (fixture) => !onlyFixtures || onlyFixtures.includes(fixture.name)
).map((fixture) => ({
  name: fixture.name,
  containers: fixture.containers,
  scenario: fixture.kind === "reference" ? "reference" : fixture.name
}));

const raw: RawSamples = {};
/**
 * Stage 6/7 independence-control evidence. Harness-only: it is written beside the
 * artifact (never inside it), so the closed evidence schema is unchanged.
 */
const independencePairs: Array<{
  fixture: string;
  run: number;
  normalStageSixMs: number[];
  normalStageSevenMs: number[];
  controlStageSixMs: number[];
  controlStageSevenMs: number[];
}> = [];
/** Per-sample stage 6/7 audit trail: accepted revision, notification, commits. */
const stageSixSevenAudit: Array<Record<string, unknown>> = [];
/**
 * Stage-5 poll-phase sweep records (methodology revision 2). Harness-only: they
 * carry the declared and observed phase of every recorded stage-5 sample, and are
 * written beside the artifact rather than inside it, so the closed evidence
 * schema stays raw numbers only.
 */
const stageFiveSweep: Array<PollPhaseSweep & { fixture: string }> = [];
/** Per-fixture result of the declared phase-sweep validity guards. */
const stageFiveValidity: Record<string, unknown> = {};
/**
 * The complete warmed observation window per `fixture|stage`, in the order the
 * daemon produced it (`samples + 1` values). The discarded warm-up is index 0, so
 * the retention rule is verifiable from the raw series instead of being asserted
 * only by the code that applied it.
 */
const warmedObservationWindows: Record<string, number[]> = {};
const MATRIX = new Set(TIME_TO_ANSWER_MATRIX.map((cell) => `${cell.fixture}|${cell.stage}`));
/** A cell only exists if the closed contract declares it for this fixture. */
const hasStage = (fixture: string, stage: string) => MATRIX.has(`${fixture}|${stage}`);
function record(fixture: string, stage: string, values: number[]): void {
  if (!hasStage(fixture, stage)) return;
  // Fail at the measurement site, naming the cell, rather than at artifact
  // validation where the origin is no longer recoverable.
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`non-numeric ${stage} sample for ${fixture}: ${JSON.stringify(value)}`);
    }
  }
  if (values.length === 0) {
    throw new Error(`no samples were measured for ${stage} on ${fixture}`);
  }
  // `values` is one complete controlled run: its samples, in order.
  raw[fixture]![stage]!.push(values);
}
for (const plan of plans) {
  raw[plan.name] = {};
  for (const stage of TIME_TO_ANSWER_STAGES) {
    if (hasStage(plan.name, stage.id)) raw[plan.name]![stage.id] = [];
  }
}

function preserveRaw(reason: string): void {
  const destination = rawDir
    ? join(rawDir, "time-to-answer-raw.json")
    : `${outputPath}.raw.json`;
  try {
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, JSON.stringify({ reason, raw }, null, 2));
    process.stderr.write(`[capture] preserved raw samples at ${destination}\n`);
  } catch (error) {
    process.stderr.write(`[capture] could not preserve raw samples: ${String(error)}\n`);
  }
}

function run(command: string, commandArgs: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function spawnOwned(command: string, commandArgs: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(command, commandArgs, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true // own process group: teardown kills the whole tree
  });
  child.stdout?.resume();
  child.stderr?.resume();
  return child;
}

/**
 * Start a child that binds a reserved TCP port and waits until it answers.
 *
 * reservePort() cannot be race-free (it binds, closes, and the port is handed
 * back to the pool), so an unrelated process — or one of our own children not yet
 * reaped — can take the port before the child binds. A collision used to abort an
 * expensive capture; here it is retried on a fresh port, bounded, and a genuinely
 * broken child still fails the capture after the attempts are exhausted.
 */
async function startChildOnFreePort(input: {
  name: string;
  attempts?: number;
  /** Keep the same port across attempts (required when the port is baked elsewhere). */
  fixedPort?: number;
  spawnOn: (port: number) => any;
  ping: (port: number) => Promise<boolean>;
}): Promise<{ child: any; port: number }> {
  const attempts = input.attempts ?? 4;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const port = input.fixedPort ?? (await reservePort());
    const child = input.spawnOn(port);
    const deadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      if (child.exitCode !== null || child.signalCode) break;
      ready = await input.ping(port);
      if (!ready) await sleep(25);
    }
    if (ready) return { child, port };
    stopOwned(child);
    lastError = new Error(`${input.name} did not become ready on port ${port}`);
    process.stderr.write(
      `[capture] ${input.name} failed to bind port ${port}; retrying (attempt ${attempt}/${attempts})\n`
    );
    await sleep(250);
  }
  throw lastError ?? new Error(`${input.name} never started`);
}

function stopOwned(child: { pid?: number; exitCode: number | null; signalCode?: NodeJS.Signals | null } | null) {
  if (!child?.pid) return;
  if (child.exitCode !== null || child.signalCode) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

async function fetchJson(url: string, timeoutMs = 5_000): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForJson(url: string, predicate: (value: any) => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fetchJson(url, 2_000);
    if (value && predicate(value)) return value;
    await sleep(4);
  }
  throw new Error(`timed out waiting for ${url}`);
}

/**
 * The seam's in-page sink identifier. Its presence is what proves an artifact
 * carries the acceptance seam; its absence is what proves the shipped product
 * does not.
 */
const SEAM_SINK_IDENTIFIER = "__dockermapBenchAcceptanceSink";

function containsSeamIdentifier(directory: string): boolean {
  let found = false;
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (
        /\.(js|mjs|html)$/.test(entry.name) &&
        readFileSync(full, "utf8").includes(SEAM_SINK_IDENTIFIER)
      ) {
        found = true;
      }
    }
  };
  visit(directory);
  return found;
}

/**
 * Bind THIS capture to the artifacts it will serve, before anything is measured:
 * the benchmark-mode application build must carry the acceptance seam (otherwise
 * stage 6 would be measuring something other than the application's acceptance)
 * and the shipped production build must not. The same property is checked in CI
 * by tests/perf/productionIsolation.test.mjs; here it guards the running capture.
 */
function assertBuildIsolation(): void {
  const product = join(REPO_ROOT, "apps/web/dist");
  const benchmark = join(REPO_ROOT, "tests/perf/.bench-app-dist");
  if (containsSeamIdentifier(product)) {
    throw new Error(
      "the production web build contains the benchmark acceptance seam: refusing to capture from a build whose numbers would not describe the shipped product"
    );
  }
  if (!containsSeamIdentifier(benchmark)) {
    throw new Error(
      "the benchmark-mode application build does not contain the acceptance seam: stage 6 would not be the application's coherent-model acceptance"
    );
  }
}

/** POST to a unix-socket HTTP endpoint (fixture daemon control route). */
function postUnix(socketPath: string, path: string): Promise<string> {
  return new Promise((done, fail) => {
    const call = request({ socketPath, path, method: "POST", headers: { "content-length": 0 } }, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => (response.statusCode === 200 ? done(body) : fail(new Error(`fixture control ${response.statusCode}`))));
    });
    call.on("error", fail);
    call.end();
  });
}

function writeComposeProject(root: string, scenario: string): void {
  mkdirSync(root, { recursive: true });
  if (scenario === "slow-bounded-compose-projection") {
    writeFileSync(join(root, "compose.yaml"), buildSlowComposeProject());
    return;
  }
  const lines = ["name: dockermap-fixture", "services:"];
  for (let index = 0; index < 40; index += 1) {
    lines.push(`  fixture-service-${index}:`);
    lines.push("    image: dockermap/fixture:1");
    lines.push("    volumes:");
    lines.push(`      - ./fixture-data-${index}:/data`);
  }
  writeFileSync(join(root, "compose.yaml"), `${lines.join("\n")}\n`);
}

const BENCH_STAGE_KEYS = ["dockerObservationMs", "composeEnrichmentMs", "findingsDerivationMs"] as const;
/**
 * The daemon's first-ever observation runs before its listener binds, so its first
 * passes are a cold start. For warmed stages a FIXED number of warm-up
 * observations (`TIME_TO_ANSWER_WARM_UP_OBSERVATIONS`, declared before the capture)
 * is discarded from the recorded samples and kept here instead, so the discard is
 * auditable rather than silent and never chosen from the data.
 */
const warmUpObservations: Record<string, number[]> = {};
/** The declared-stationarity ratio of each warmed window, per `fixture|stage|run`. */
const warmUpStationarity: Record<string, number> = {};

function readBenchSink(path: string): Record<(typeof BENCH_STAGE_KEYS)[number], number[]> {
  const stages = { dockerObservationMs: [], composeEnrichmentMs: [], findingsDerivationMs: [] } as Record<
    (typeof BENCH_STAGE_KEYS)[number],
    number[]
  >;
  if (!existsSync(path)) return stages;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as { stage?: string; ms?: number };
      const key = record.stage as (typeof BENCH_STAGE_KEYS)[number];
      if (key && stages[key] && Number.isFinite(record.ms)) stages[key].push(record.ms as number);
    } catch {
      // ignore a partially written trailing line
    }
  }
  return stages;
}

async function waitForBenchSamples(path: string, count: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stages = readBenchSink(path);
    if (BENCH_STAGE_KEYS.every((key) => stages[key].length >= count)) {
      return {
        dockerObservationMs: stages.dockerObservationMs.slice(0, count),
        composeEnrichmentMs: stages.composeEnrichmentMs.slice(0, count),
        findingsDerivationMs: stages.findingsDerivationMs.slice(0, count)
      };
    }
    await sleep(50);
  }
  throw new Error("daemon bench attribution did not accumulate the required warmed samples");
}

/**
 * Stage 5 — daemon publication committed -> the Node/SSE layer observes the new
 * revision through TODAY'S real polling mechanism, poll wait included.
 *
 * Methodology revision 2 drives the phase DETERMINISTICALLY instead of sleeping a
 * uniform random delay and hoping the samples land across the interval. Baseline 3
 * disproved that hope: reference-25's 45 samples sat in a 120 ms band (6.0 % of the
 * interval) because both the daemon's refresh loop and the API's poller are fixed
 * 2 s loops, so the measured gap was their phase offset, not a sample of any
 * distribution. The design is declared in `timeToAnswerPollPhase.ts`: a fixed grid
 * of phases spanning the interval, one declared phase per recorded sample, each
 * run sweeping the grid ascending, so each phase has exactly three samples per
 * cell and every sample's phase is recoverable from its position in its run.
 *
 * The harness controls the phase by choosing WHEN IT CONNECTS its observation
 * stream: the API emits to each connected client on a `setInterval` anchored to
 * that connection, so connecting at `predictedPublication - declaredPhase` puts the
 * next poll tick at the intended latency after the publication. The prediction
 * comes from the daemon's own observed publication grid. Each sample then verifies
 * the result: the observed publication must match the prediction, the observed
 * latency must land on the declared phase within tolerance, and the observation
 * must have arrived through the real API stream.
 */
const PHASE_CONNECT_MARGIN_MS = 30;

interface PublicationTracker {
  /** Every instant a revision change was detected, in order. */
  readonly publications: number[];
  /** Instants of the refresh CYCLES that carried a revision change. */
  cycles(): number[];
  /** The revision the daemon currently publishes. */
  revision(): string;
  waitForPublications(count: number, timeoutMs: number): Promise<void>;
  /** Mean observed gap between recent publication cycles: the daemon's grid period. */
  periodMs(): number;
  lastCycleAtMs(): number;
  stop(): Promise<void>;
}

/**
 * A refresh cycle can publish more than one revision (the inventory publication and
 * a provider-state publication follow each other), and those intra-cycle changes are
 * milliseconds apart. The phase grid must be fitted over CYCLE instants: fitting it
 * over every revision change would fold extra publications into the grid and skew
 * the period, which stage 5's deepest declared phases amplify one-for-one.
 */
function cycleLeaders(publications: readonly number[], intervalMs: number): number[] {
  const leaders: number[] = [];
  const separationMs = intervalMs / 4;
  for (const instant of publications) {
    const previous = leaders[leaders.length - 1];
    if (previous === undefined || instant - previous > separationMs) leaders.push(instant);
  }
  return leaders;
}

async function startPublicationTracker(
  daemonPort: number,
  initialRevision: string,
  intervalMs: number
): Promise<PublicationTracker> {
  const url = `http://127.0.0.1:${daemonPort}/daemon/health`;
  const publications: number[] = [];
  let revision = initialRevision;
  let stopped = false;
  const running = (async () => {
    while (!stopped) {
      const health = await fetchJson(url, 1_000);
      const next = (health?.modelRevision as string | undefined) ?? "";
      if (next && next !== revision) {
        revision = next;
        publications.push(nowMs());
      }
      // 5 ms: the detection instant is the publication instant plus at most this,
      // and the grid fit below averages that jitter across several cycles.
      await sleep(5);
    }
  })();
  const leaders = () => cycleLeaders(publications, intervalMs);
  return {
    publications,
    cycles: leaders,
    revision: () => revision,
    async waitForPublications(count: number, timeoutMs: number) {
      const deadline = Date.now() + timeoutMs;
      while (leaders().length < count && Date.now() < deadline) await sleep(10);
      if (leaders().length < count) {
        throw new Error(
          `the daemon published only ${leaders().length} refresh cycles; stage 5 needs ${count} to know its publication grid`
        );
      }
    },
    periodMs() {
      const recent = leaders().slice(-8);
      if (recent.length < 2) {
        throw new Error("stage 5 needs at least two observed publication cycles before it can predict the next one");
      }
      // Least-squares fit of cycle index against instant. A single gap is a poor
      // estimate — it carries one cycle's refresh work plus the tracker's own start
      // transient — and stage 5's deepest declared phases amplify a period error
      // one-for-one into phase error, so the estimate has to be tight.
      const count = recent.length;
      const meanIndex = (count - 1) / 2;
      const meanAt = recent.reduce((sum, value) => sum + value, 0) / count;
      let numerator = 0;
      let denominator = 0;
      recent.forEach((at, index) => {
        numerator += (index - meanIndex) * (at - meanAt);
        denominator += (index - meanIndex) ** 2;
      });
      return numerator / denominator;
    },
    lastCycleAtMs() {
      const last = leaders()[leaders().length - 1];
      if (last === undefined) throw new Error("stage 5 has observed no publication cycle yet");
      return last;
    },
    async stop() {
      stopped = true;
      await running;
    }
  };
}

interface PhaseSamplePlan {
  declaredPhaseMs: number;
  intendedLatencyMs: number;
  predictedPublicationAtMs: number;
  connectedAtMs: number;
}

/**
 * Measure one stage-5 sample at its declared phase. `onConnected` runs after the
 * observation stream is connected and before the publication is awaited, which is
 * where the caller arms the browser measurement and triggers the fixture change:
 * both must happen after the connection (so the poll tick carries the change) and
 * before the publication (so the change is in it).
 */
async function observeStageFiveSample(input: {
  tracker: PublicationTracker;
  daemonPort: number;
  apiPort: number;
  webOrigin: string;
  intervalMs: number;
  runIndex: number;
  sampleIndex: number;
  onConnected: (plan: PhaseSamplePlan) => Promise<void>;
  timeoutMs?: number;
}): Promise<{ sample: PollPhaseSweep; revisions: string[] }> {
  const declaredPhaseMs = declaredPhaseForSample(input.runIndex, input.sampleIndex, input.intervalMs);
  const intended = intendedLatencyMs(declaredPhaseMs, input.intervalMs);
  // Four publications give the grid fit three intervals to work with before the
  // first sample is placed; the tracker usually satisfies this long before the
  // browser stages begin.
  await input.tracker.waitForPublications(4, 60_000);
  const period = input.tracker.periodMs();

  // Choose the publication cycle to measure: the next one on the daemon's grid whose
  // connection instant is still in the future by a safety margin.
  let predicted = input.tracker.lastCycleAtMs() + period;
  while (predicted - declaredPhaseMs < nowMs() + PHASE_CONNECT_MARGIN_MS) predicted += period;

  const connectAt = predicted - declaredPhaseMs;
  await sleep(Math.max(0, connectAt - nowMs()));
  const previousRevision = input.tracker.revision();
  const connectedAtMs = nowMs();

  // The observation stream is opened at the computed instant. Ticks occur every
  // `intervalMs` from connection, so the first tick after `predicted` lands at
  // `predicted + intended` — the declared phase's latency.
  const controller = new AbortController();
  const observed = { at: 0, revisions: [] as string[] };
  const response = await fetch(`http://127.0.0.1:${input.apiPort}/api/events/stream`, {
    headers: { accept: "text/event-stream", origin: input.webOrigin },
    signal: controller.signal
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const reading = (async () => {
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
          if (!dataLine) continue;
          try {
            const payload = JSON.parse(dataLine.slice(5).trim()) as { modelRevision?: string };
            const revision = payload.modelRevision;
            if (revision && revision !== previousRevision) {
              if (!observed.revisions.includes(revision)) observed.revisions.push(revision);
              if (!observed.at) observed.at = nowMs();
            }
          } catch {
            // keepalive or non-JSON frame
          }
        }
      }
    } catch {
      // stream closed by teardown
    }
  })();

  await input.onConnected({
    declaredPhaseMs,
    intendedLatencyMs: intended,
    predictedPublicationAtMs: predicted,
    connectedAtMs
  });

  // The publication instant is resolved by the tracker's own health polling, which
  // runs continuously and independently of the API stream.
  const deadline = Date.now() + (input.timeoutMs ?? 45_000);
  while (Date.now() < deadline && !observed.at) await sleep(2);
  controller.abort();
  await reading;
  if (!observed.at) {
    throw new Error(
      `stage 5 did not observe a new revision at declared phase ${declaredPhaseMs.toFixed(1)} ms ` +
        `(predicted publication ${(predicted - connectedAtMs).toFixed(1)} ms after connection)`
    );
  }
  const publicationAt = nearestPublication(input.tracker.publications, predicted);
  if (publicationAt === null) {
    throw new Error("stage 5 lost the publication instant for this sample");
  }
  const observedLatencyMs = Math.max(0, observed.at - publicationAt);
  return {
    revisions: observed.revisions,
    sample: {
      runIndex: input.runIndex,
      sampleIndex: input.sampleIndex,
      declaredPhaseMs,
      intendedLatencyMs: intended,
      connectedAtMs,
      predictedPublicationAtMs: predicted,
      observedPublicationAtMs: publicationAt,
      observedObservationAtMs: observed.at,
      observedLatencyMs,
      observedPhaseBucketMs: observedPhaseBucketMs(observedLatencyMs, input.intervalMs),
      phaseErrorMs: observedLatencyMs - intended,
      observedVia: "api-sse",
      observedRevision: observed.revisions[0] ?? "",
      previousRevision
    }
  };
}

/**
 * The detected revision change that carries this sample: the one nearest the
 * predicted cycle instant. Selecting the nearest (rather than, say, the earliest
 * after some threshold) keeps a second publication from being attributed to the
 * sample it does not belong to, and any misplacement shows up as the declared-phase
 * error the guards already enforce.
 */
function nearestPublication(publications: readonly number[], predicted: number): number | null {
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const instant of publications) {
    const distance = Math.abs(instant - predicted);
    if (distance < bestDistance) {
      best = instant;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Superseded by `observeStageFiveSample`: the jitter-based observer is gone, and
 * with it any claim that random trigger delays sample the poll interval.
 */
function medianOf(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

interface StageSixSeven {
  /** Stage 6: browser notification -> the APPLICATION accepted a coherent model. */
  notificationToCoherentModelMs: number;
  /** Stage 7: coherent model accepted -> its Home content rendered + presentation. */
  coherentModelToUsefulRenderMs: number | null;
  acceptedRevision: string;
  acceptedSequence: number;
  /** The browser notification that caused the fetch cycle delivering the model. */
  notifiedRevision: string;
  latestNotifiedRevision: string;
  /** Which paired API fetch delivered the accepted revision ("snapshot"/"runtime-map"). */
  fetchDeliveredBy: string;
  fetchStartedAt: number;
  /** Null for acceptance-only cells (no Home repaint is declared for them). */
  renderCommitMs: number | null;
  presentationFrameMs: number | null;
  metricLabel: string;
  beforeMetricValue: string | null;
  afterMetricValue: string | null;
  expectedMetricValue: string | null;
  metricChanged: boolean | null;
}

/**
 * Arm stages 6/7 BEFORE the publication change is triggered. Arming records the
 * pre-change Home metric value (so "the DOM changed" is measured rather than
 * assumed) and lets the probe wait for the NEXT accepted revision, identified by
 * its monotonic sequence number rather than by "any revision other than the last
 * one", so a publication that lands between arming and the trigger cannot be
 * mistaken for the sample's own.
 */
async function armStageSixSeven(
  page: any,
  input: { mode: "content" | "acceptance-only"; expectedMetricValue: string }
): Promise<void> {
  const previousSeq = await page.evaluate("window.__dockermapBenchHelpers.currentAcceptedSeq()");
  await page.evaluate(
    `window.__benchInput = ${JSON.stringify({
      mode: input.mode,
      previousSeq,
      limit: 60_000,
      metricLabel: HomeMetricLabel,
      expectedMetricValue: input.expectedMetricValue
    })}`
  );
  await page.evaluate("window.__dockermapBenchHelpers.armModelAcceptance(window.__benchInput)");
  await page.waitForFunction("window.__dockermapBenchHelpers.armed()", undefined, { timeout: 10_000 });
}

async function awaitModelAcceptance(page: any): Promise<StageSixSeven> {
  const measured = (await page.evaluate(
    "window.__dockermapBenchHelpers.awaitModelAcceptance()"
  )) as StageSixSeven | undefined;
  if (!measured) throw new Error("model acceptance probe returned no measurement");
  return measured;
}

async function measureCommandQuery(page: any, preferredToken: string, timeoutMs = 20_000): Promise<number> {
  await page.evaluate(`window.__benchInput = ${JSON.stringify({ limit: timeoutMs, preferredToken })}`);
  const measured = await page.evaluate(
    "window.__dockermapBenchHelpers.commandQuery(window.__benchInput.limit, window.__benchInput.preferredToken)"
  );
  if (!measured) throw new Error("command query probe returned no measurement");
  return measured as number;
}

async function measureProductionBundle(browser: any, webOrigin: string): Promise<number> {
  // Cold context: no cache, fresh navigation, production build.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${webOrigin}/`, { waitUntil: "load" });
  // The cold context deliberately has no instrumentation: this stage measures
  // the production load itself, so it reads the Navigation Timing entry only.
  const duration = await page.evaluate(
    "(() => { const entry = performance.getEntriesByType('navigation')[0]; return entry ? entry.duration : 0; })()"
  );
  await context.close();
  if (!duration) throw new Error("could not read the production navigation duration");
  return duration;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  // One private API port for the whole capture: the production web build bakes
  // its API origin at build time. It is reserved from the OS, not fixed.
  const apiPort = await reservePort();
  process.stdout.write(`[capture] preflight builds (api origin http://127.0.0.1:${apiPort})\n`);
  run("npm", ["run", "build", "--workspace", "@dockermap/contracts"]);
  run("npm", ["run", "build", "--workspace", "@dockermap/web"], {
    VITE_API_BASE_URL: `http://127.0.0.1:${apiPort}`
  });
  run("npx", ["vite", "build", "--config", "tests/perf/benchVite.config.mjs"]);
  // Benchmark-MODE application build: the same real app with the acceptance seam
  // compiled in (see tests/perf/benchAppVite.config.mjs). It is served only to the
  // page that measures coherent-model acceptance and its independence control.
  run("npx", ["vite", "build", "--config", "tests/perf/benchAppVite.config.mjs"], {
    VITE_API_BASE_URL: `http://127.0.0.1:${apiPort}`
  });
  assertBuildIsolation();

  const browser = await chromium.launch({ args: launchArgs });
  const workRoot = mkdtempSync(join(tmpdir(), "dockermap-bench-"));

  try {
    for (let runIndex = 0; runIndex < runs; runIndex += 1) {
      for (const plan of plans) {
        process.stdout.write(
          `[capture] run ${runIndex + 1}/${runs} fixture ${plan.name} (${plan.containers} containers)\n`
        );
        // Only the daemon port is chosen here; every other listener either takes an
        // atomic OS-assigned port (static servers) or retries on a fresh one.
        let daemonPort = 0;
        const workdir = join(workRoot, `${plan.name}-${runIndex}`);
        mkdirSync(workdir, { recursive: true });
        const projectRoot = join(workdir, "compose-project");
        writeComposeProject(projectRoot, plan.scenario);
        // Scenario premise, asserted rather than named: the slow-but-bounded Compose
        // fixture must actually present the declared project. Without this an empty or
        // truncated tree would still record a cell and look like a fast projection.
        if (plan.scenario === "slow-bounded-compose-projection") {
          const declaredProject = readFileSync(join(projectRoot, "compose.yaml"), "utf8");
          const serviceCount = declaredProject
            .split("\n")
            .filter((line) => /^ {2}[A-Za-z0-9._-]+:$/.test(line)).length;
          if (serviceCount !== SLOW_COMPOSE_SERVICES) {
            throw new Error(
              `the slow-Compose premise failed: the project declares ${serviceCount} services, expected ${SLOW_COMPOSE_SERVICES}`
            );
          }
        }
        const benchSink = join(workdir, "bench.jsonl");
        const fixtureSocket = join(workdir, "fixture.sock");
        const fixtureReady = join(workdir, "fixture.ready");

        let fixtureChild: any = null;
        let daemonChild: any = null;
        let apiChild: any = null;
        let webServer: any = null;
        let probeServer: any = null;
        let benchAppServer: any = null;
        let publicationTracker: PublicationTracker | null = null;
        try {
          fixtureChild = spawnOwned(process.execPath, [
            "tests/perf/fake-docker-api.mjs",
            "--socket",
            fixtureSocket,
            "--containers",
            String(plan.containers),
            "--scenario",
            plan.scenario,
            "--project-root",
            projectRoot,
            "--ready-file",
            fixtureReady
          ]);
          const fixtureDeadline = Date.now() + 15_000;
          while (!existsSync(fixtureReady) && Date.now() < fixtureDeadline) await sleep(50);
          if (!existsSync(fixtureReady)) throw new Error("fixture Docker daemon did not become ready");

          // Stage 1: process start -> listener ready.
          const emptyPath = join(workdir, "empty-path");
          if (plan.name === "unavailable-optional-provider") mkdirSync(emptyPath, { recursive: true });
          const daemonEnv = {
            DOCKERMAP_DOCKER_GATEWAY_SOCKET: fixtureSocket,
            DOCKERMAP_BENCH_STAGE_TIMING_PATH: benchSink,
            DOCKERMAP_DAEMON_HOST: "127.0.0.1",
            DOCKERMAP_PROJECT_ROOT: projectRoot,
            ...(plan.name === "unavailable-optional-provider" ? { PATH: emptyPath } : {})
          };
          const healthUrl = (port: number) => `http://127.0.0.1:${port}/daemon/health`;
          const daemonReady = async (port: number) => Boolean(await fetchJson(healthUrl(port), 1_000));
          const startedDaemon = await startChildOnFreePort({
            name: "daemon",
            spawnOn: (port) => spawnOwned(daemonBinary, [], { ...daemonEnv, DOCKERMAP_DAEMON_PORT: String(port) }),
            ping: daemonReady
          });
          daemonChild = startedDaemon.child;
          daemonPort = startedDaemon.port;
          // Stage 5's phase control needs the daemon's publication grid, and the
          // tracker needs several publications to fit it. Start it here, with the
          // daemon, so the grid is known long before the browser stages begin.
          if (hasStage(plan.name, "publicationToNodeObservationMs")) {
            publicationTracker = await startPublicationTracker(
              daemonPort,
              ((await fetchJson(healthUrl(daemonPort), 5_000))?.modelRevision as string | undefined) ?? "",
              pollIntervalMs
            );
          }

          // Stages 1 and 2 need a CLEAN start per warmed sample, so they are
          // measured by restarting the daemon `samples` times on private ports
          // rather than by reusing the resident benchmark daemon.
          const needsStartup = hasStage(plan.name, "daemonStartToListenerMs");
          if (needsStartup) {
            const starts: number[] = [];
            const models: number[] = [];
            for (let index = 0; index < samples; index += 1) {
              let startAt = 0;
              const probe = await startChildOnFreePort({
                name: "daemon startup probe",
                spawnOn: (port) => {
                  // The start instant is taken at the successful spawn: a retried
                  // attempt never contributes a sample.
                  startAt = nowMs();
                  return spawnOwned(daemonBinary, [], {
                    ...daemonEnv,
                    // These transient cold-start probes must never write into the
                    // warmed attribution sink: their first observation is a
                    // cold-start sample, and mixing it into a stage documented as
                    // "warmed" would be a provenance defect.
                    DOCKERMAP_BENCH_STAGE_TIMING_PATH: join(workdir, "probe-bench.jsonl"),
                    DOCKERMAP_DAEMON_PORT: String(port)
                  });
                },
                ping: daemonReady
              });
              try {
                starts.push(nowMs() - startAt);
                const readyAt = nowMs();
                await waitForJson(
                  healthUrl(probe.port),
                  (value) => value.mode === "docker" && Boolean(value.modelRevision),
                  60_000
                );
                models.push(nowMs() - readyAt);
              } finally {
                stopOwned(probe.child);
              }
            }
            record(plan.name, "daemonStartToListenerMs", starts);
            record(plan.name, "listenerToFirstDockerModelMs", models);
          }

          // Stages 3, 4, 9: bench attribution from the current implementation.
          const needsBench = BENCH_STAGE_KEYS.some((key) => hasStage(plan.name, key));
          if (needsBench) {
            const required = samples + TIME_TO_ANSWER_WARM_UP_OBSERVATIONS;
            const benchSamples = await waitForBenchSamples(benchSink, required, 300_000);
            for (const key of BENCH_STAGE_KEYS) {
              if (!hasStage(plan.name, key)) continue;
              if (TIME_TO_ANSWER_STAGE_KIND[key] !== "warmed-repeated") {
                record(plan.name, key, benchSamples[key].slice(0, samples));
                continue;
              }
              // The warm-up count is FIXED by protocol — never chosen from the data
              // — and the whole window is retained, so the discarded observations
              // stay auditable. The stationarity guard then decides whether the
              // window is usable at all: a window whose warm-ups have not settled is
              // INVALID, never trimmed.
              const { warmUps, recorded } = splitWarmedObservations(benchSamples[key], samples);
              const label = `${plan.name}|${key}|run${runIndex}`;
              warmUpStationarity[label] = assertWarmUpStationarity({ label, warmUps, recorded });
              warmUpObservations[label] = warmUps;
              warmedObservationWindows[label] = benchSamples[key].slice(0, required);
              record(plan.name, key, recorded);
            }
          }

          const needsApp =
            hasStage(plan.name, "publicationToNodeObservationMs") ||
            hasStage(plan.name, "notificationToCoherentModelMs") ||
            hasStage(plan.name, "commandQueryMs") ||
            hasStage(plan.name, "productionBundleMs");
          if (!needsApp) continue;
          // Stage 6/7 observe the application's coherent-model acceptance, which
          // only exists in the benchmark-MODE build of the real app. Every other
          // browser stage is measured on the ordinary production build.
          const needsStageSix = hasStage(plan.name, "notificationToCoherentModelMs");
          const tracksIndependence = needsStageSix && hasStage(plan.name, "coherentModelToUsefulRenderMs");
          const independencePair = tracksIndependence
            ? {
                fixture: plan.name,
                run: runIndex,
                normalStageSixMs: [] as number[],
                normalStageSevenMs: [] as number[],
                controlStageSixMs: [] as number[],
                controlStageSevenMs: [] as number[]
              }
            : null;
          webServer = await startStaticServer({ directory: join(REPO_ROOT, "apps/web/dist"), port: 0 });
          probeServer = await startStaticServer({
            directory: join(REPO_ROOT, "tests/perf/.bench-dist"),
            port: 0
          });
          const webOrigin = webServer.url;
          if (needsStageSix) {
            benchAppServer = await startStaticServer({
              directory: join(REPO_ROOT, "tests/perf/.bench-app-dist"),
              port: 0
            });
          }
          // The API port is baked into the production build, so it must stay fixed
          // for the whole capture; the retry therefore re-spawns on the SAME port
          // (bounded) instead of moving to a new one.
          const apiHealth = async () =>
            Boolean(await fetchJson(`http://127.0.0.1:${apiPort}/api/health`, 1_000));
          const startedApi = await startChildOnFreePort({
            name: "api",
            fixedPort: apiPort,
            spawnOn: () =>
              spawnOwned(process.execPath, [join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs"), "apps/api/src/index.ts"], {
                PORT: String(apiPort),
                DOCKERMAP_DAEMON_URL: `http://127.0.0.1:${daemonPort}`,
                // The API must accept both browser origins: the production build for
                // Cmd-K and the cold production load, the benchmark-mode build for
                // coherent-model acceptance.
                DOCKERMAP_ALLOWED_ORIGINS: [webOrigin, benchAppServer?.url].filter(Boolean).join(","),
                // Pinned explicitly so the recorded interval and the interval that
                // actually ran cannot diverge; this is the API's own default.
                DOCKERMAP_SSE_INTERVAL_MS: String(pollIntervalMs)
              }),
            ping: apiHealth
          });
          apiChild = startedApi.child;

          // Browser stages. Every browser stage needs `samples` warmed
          // observations per controlled run, so revision-driven stages loop over
          // real published revision changes instead of being measured once.
          const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
          const page = await context.newPage();
          if (process.env.DOCKERMAP_BENCH_DEBUG === "1") {
            page.on("console", (message) => process.stdout.write(`[browser:${message.type()}] ${message.text()}\n`));
            page.on("requestfailed", (failed) =>
              process.stdout.write(`[browser:requestfailed] ${failed.url()} ${failed.failure()?.errorText ?? ""}\n`)
            );
          }
          await page.addInitScript({ path: join(REPO_ROOT, "tests/perf/browserProbe.js") });
          await page.goto(`${webOrigin}/`, { waitUntil: "domcontentloaded" });
          await page.waitForFunction("window.__dockermapBenchHelpers.homeReady()", undefined, {
            timeout: 90_000
          });

          // The benchmark-mode application page, used only for stages 6 and 7.
          let benchPage: any = null;
          let benchContext: any = null;
          if (needsStageSix) {
            benchContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
            benchPage = await benchContext.newPage();
            if (process.env.DOCKERMAP_BENCH_DEBUG === "1") {
              benchPage.on("console", (message: any) =>
                process.stdout.write(`[bench:${message.type()}] ${message.text()}\n`)
              );
              benchPage.on("requestfailed", (failed: any) =>
                process.stdout.write(`[bench:requestfailed] ${failed.url()} ${failed.failure()?.errorText ?? ""}\n`)
              );
            }
            await benchPage.addInitScript({ path: join(REPO_ROOT, "tests/perf/browserProbe.js") });
            await benchPage.goto(`${benchAppServer.url}/`, { waitUntil: "domcontentloaded" });
            await benchPage.waitForFunction("window.__dockermapBenchHelpers.homeReady()", undefined, {
              timeout: 90_000
            });
          }

          const observationSamples: number[] = [];
          // Scenario premises must be asserted: a fixture that silently stops
          // exercising its premise would still record samples and pass the gate.
          const dockerIds = (snapshot: any) =>
            (snapshot?.containers ?? [])
              .map((container: any) => container.id ?? container.name)
              .sort()
              .join(",");
          const premiseDockerIds =
            plan.name === "provider-only-revision-change"
              ? dockerIds(await fetchJson(`http://127.0.0.1:${daemonPort}/daemon/snapshot`, 30_000))
              : "";
          const premiseProviderStates =
            plan.name === "unavailable-optional-provider"
              ? JSON.stringify(await fetchJson(`http://127.0.0.1:${daemonPort}/daemon/runtime/map`, 30_000) ?? {})
              : "";
          const coherentSamples: number[] = [];
          const usefulSamples: number[] = [];
          const querySamples: number[] = [];
          const bundleSamples: number[] = [];
          const needsRevisionLoop =
            hasStage(plan.name, "publicationToNodeObservationMs") || needsStageSix;
          if (needsRevisionLoop) {
            if (!hasStage(plan.name, "publicationToNodeObservationMs")) {
              throw new Error(
                `${plan.name} declares a browser stage without the stage-5 poll-phase sweep; the closed matrix ` +
                  "does not contain that shape and an uncontrolled phase must not be measured"
              );
            }
            const tracker = publicationTracker;
            if (!tracker) {
              throw new Error(`${plan.name} declares stage 5 but its publication tracker was never started`);
            }
            for (let index = 0; index < samples; index += 1) {
              // Generation `g` stops the fixture's first `g` containers, so the
              // expected Home metric for the publication this sample triggers is
              // derived from the fixture rather than assumed.
              const generation = index + 1;
              const expectedMetricValue = String(expectedExitedCount(plan.containers, plan.scenario, generation));
              const { sample, revisions } = await observeStageFiveSample({
                tracker,
                daemonPort,
                apiPort,
                webOrigin,
                intervalMs: pollIntervalMs,
                runIndex,
                sampleIndex: index,
                // Runs after the observation stream is connected and before the
                // publication: arming the browser here means the acceptance this
                // sample measures is caused by THIS publication, and the generation
                // trigger is guaranteed to be inside it.
                onConnected: async () => {
                  if (needsStageSix) {
                    await armStageSixSeven(benchPage, {
                      // Provider-only fixtures publish a revision with no inventory
                      // change: stage 6 ends at acceptance (no Home repaint exists to
                      // wait for) and stage 7 is not declared for them.
                      mode: tracksIndependence ? "content" : "acceptance-only",
                      expectedMetricValue: tracksIndependence ? expectedMetricValue : ""
                    });
                  }
                  if (plan.name === "docker-topology-change" || plan.name.startsWith("reference-")) {
                    // A real published inventory change: the fixture daemon serves a
                    // new generation, so the daemon must publish a new revision.
                    await postUnix(fixtureSocket, `/__fixture/topology-generation/${generation}`);
                  }
                  // `provider-only-revision-change` and `unavailable-optional-provider`
                  // need no trigger: their revision advance comes from provider state
                  // alone, which is exactly what those fixtures characterise.
                }
              });
              stageFiveSweep.push({ ...sample, fixture: plan.name });
              observationSamples.push(sample.observedLatencyMs);
              // Fail fast on a control failure: the phase the harness drove did not
              // produce the latency the design predicted, so this sample is not a
              // measurement of the declared phase.
              if (Math.abs(sample.phaseErrorMs) > POLL_PHASE_CONTROL_TOLERANCE_MS) {
                throw new Error(
                  `stage 5 declared phase ${sample.declaredPhaseMs.toFixed(1)} ms produced ` +
                    `${sample.observedLatencyMs.toFixed(1)} ms instead of the intended ` +
                    `${sample.intendedLatencyMs.toFixed(1)} ms (error ${sample.phaseErrorMs.toFixed(1)} ms): ` +
                    "the publication phase was not controlled " +
                    `[connected at ${sample.connectedAtMs.toFixed(1)}, predicted publication ` +
                    `${sample.predictedPublicationAtMs.toFixed(1)} (${(sample.predictedPublicationAtMs - sample.connectedAtMs).toFixed(1)} ms after connect), ` +
                    `observed publication ${sample.observedPublicationAtMs.toFixed(1)} ` +
                    `(${(sample.observedPublicationAtMs - sample.predictedPublicationAtMs).toFixed(1)} ms from the prediction), ` +
                    `observed poll tick ${sample.observedObservationAtMs.toFixed(1)}]`
                );
              }
              if (needsStageSix) {
                const measured = await awaitModelAcceptance(benchPage);
                coherentSamples.push(measured.notificationToCoherentModelMs);
                if (typeof measured.coherentModelToUsefulRenderMs === "number") {
                  usefulSamples.push(measured.coherentModelToUsefulRenderMs);
                }
                // Cross-layer attribution. Stage 5 observes revisions as the API's
                // own poller announced them on this connection; the app accepts the
                // revision its paired fetches returned, and the daemon is read per
                // request — so the accepted revision need not appear in this
                // connection's stream while the host is churning (each SSE
                // connection also polls on its own phase). The binding provenance
                // for stage 6 is the browser-side one the probe records: an API
                // fetch delivered that revision to the app, and a browser
                // notification preceded that fetch cycle. The overlap is therefore
                // recorded as evidence, not enforced as a gate.
                const acceptedInApiStream = revisions.includes(measured.acceptedRevision);
                if (!acceptedInApiStream) {
                  process.stdout.write(
                    `[capture] note: accepted revision ${measured.acceptedRevision} was not on this harness stream's own phase ` +
                      `(api: ${revisions.join(", ") || "none"}; browser fetched it via ${measured.fetchDeliveredBy})\n`
                  );
                }
                if (independencePair) {
                  independencePair.normalStageSixMs.push(measured.notificationToCoherentModelMs);
                  independencePair.normalStageSevenMs.push(measured.coherentModelToUsefulRenderMs as number);
                }
                stageSixSevenAudit.push({
                  ...measured,
                  fixture: plan.name,
                  run: runIndex,
                  sample: index,
                  generation,
                  delayMs: 0,
                  apiObservedRevisions: revisions,
                  acceptedRevisionInApiStream: acceptedInApiStream,
                  stageFiveDeclaredPhaseMs: sample.declaredPhaseMs,
                  stageFiveObservedLatencyMs: sample.observedLatencyMs,
                  stageFivePhaseErrorMs: sample.phaseErrorMs
                });
              }
            }
            await tracker.stop();
            if (benchPage) {
              // No shortcut: the application must reach the daemon only through the
              // API, and the notifications feeding stages 6/7 must come from the
              // API's real SSE endpoint — not from a harness-injected channel.
              const origins: string[] = await benchPage.evaluate(
                "window.__dockermapBenchHelpers.requestOrigins()"
              );
              const stream: string = await benchPage.evaluate("window.__dockermapBenchHelpers.streamUrl()");
              const daemonOrigin = `http://127.0.0.1:${daemonPort}`;
              const apiOrigin = `http://127.0.0.1:${apiPort}`;
              if (origins.includes(daemonOrigin)) {
                throw new Error(
                  `the benchmark-mode page fetched the daemon directly (${daemonOrigin}): the measured path ` +
                    "is not the real API polling path"
                );
              }
              if (!origins.includes(apiOrigin) || !stream.startsWith(`${apiOrigin}/api/events/stream`)) {
                throw new Error(
                  `the page's notification path is not the API's real stream (origins: ${origins.join(", ") || "none"}; ` +
                    `stream: ${stream || "none"})`
                );
              }
            }
          }
          if (independencePair) {
            // Stage 6/7 independence control. The artificial presentation delay is
            // injected AFTER coherent-model acceptance, so a stage-6 number that
            // moves under it would prove the two stages share a clock, and a
            // stage-7 number that does not move would prove stage 7 is not
            // measuring presentation of the accepted model.
            for (let index = 0; index < TIME_TO_ANSWER_INDEPENDENCE_SAMPLES; index += 1) {
              const generation = samples + index + 1;
              const expectedMetricValue = String(expectedExitedCount(plan.containers, plan.scenario, generation));
              await benchPage.evaluate(`window.__dockermapBenchRenderDelayMs = ${TIME_TO_ANSWER_INDEPENDENCE_DELAY_MS}`);
              await armStageSixSeven(benchPage, { mode: "content", expectedMetricValue });
              // Deterministic settle delay before the control trigger. These samples
              // measure stages 6/7 only — no poll phase is involved — so the delay
              // exists solely to keep the arming and the fixture change from being
              // simultaneous, and it is fixed rather than random so the control is
              // reproducible too.
              await sleep(TIME_TO_ANSWER_INDEPENDENCE_SETTLE_MS);
              if (plan.name === "docker-topology-change" || plan.name.startsWith("reference-")) {
                await postUnix(fixtureSocket, `/__fixture/topology-generation/${generation}`);
              }
              const measured = await awaitModelAcceptance(benchPage);
              independencePair.controlStageSixMs.push(measured.notificationToCoherentModelMs);
              independencePair.controlStageSevenMs.push(measured.coherentModelToUsefulRenderMs as number);
              stageSixSevenAudit.push({
                ...measured,
                fixture: plan.name,
                run: runIndex,
                sample: `control-${index}`,
                generation,
                delayMs: TIME_TO_ANSWER_INDEPENDENCE_DELAY_MS
              });
              await benchPage.evaluate("window.__dockermapBenchRenderDelayMs = 0");
            }
            independencePairs.push(independencePair);
          }
          if (hasStage(plan.name, "commandQueryMs")) {
            for (let index = 0; index < samples; index += 1) {
              // A fresh page per sample: the measurement must be a real closed
              // palette opening for the first time, not a still-open dialog.
              await page.goto(`${webOrigin}/`, { waitUntil: "domcontentloaded" });
              await page.waitForFunction("window.__dockermapBenchHelpers.homeReady()", undefined, {
                timeout: 90_000
              });
              querySamples.push(await measureCommandQuery(page, FixtureTopologyQueryToken));
            }
          }
          if (hasStage(plan.name, "productionBundleMs")) {
            for (let index = 0; index < samples; index += 1) {
              bundleSamples.push(await measureProductionBundle(browser, webOrigin));
            }
          }
          await context.close();
          if (benchContext) await benchContext.close();
          // Assert the scenario premise actually held for this run.
          if (plan.name === "provider-only-revision-change") {
            const after = dockerIds(await fetchJson(`http://127.0.0.1:${daemonPort}/daemon/snapshot`, 30_000));
            if (after !== premiseDockerIds) {
              throw new Error(
                "provider-only-revision-change measured a Docker-driven revision: the fixture inventory changed during the run"
              );
            }
          }
          if (plan.name === "unavailable-optional-provider") {
            if (!/"state":"(unavailable|disabled|error|stale|collecting)"/.test(premiseProviderStates)) {
              throw new Error(
                "unavailable-optional-provider measured a fully-provided model: no optional provider was non-fresh"
              );
            }
          }
          if (observationSamples.length > 0) record(plan.name, "publicationToNodeObservationMs", observationSamples);
          if (coherentSamples.length > 0) {
            record(plan.name, "notificationToCoherentModelMs", coherentSamples);
            record(plan.name, "coherentModelToUsefulRenderMs", usefulSamples);
          }
          if (querySamples.length > 0) record(plan.name, "commandQueryMs", querySamples);
          if (bundleSamples.length > 0) record(plan.name, "productionBundleMs", bundleSamples);

          // Stages 8, 10: the real production modules measured in real Chromium
          // through the benchmark-only entry.
          if (
            hasStage(plan.name, "buildModelMs") ||
            hasStage(plan.name, "legacyTopologyLayoutMs")
          ) {
            const snapshot = await fetchJson(`http://127.0.0.1:${apiPort}/api/snapshot`, 30_000);
            const runtimeMap = await fetchJson(`http://127.0.0.1:${apiPort}/api/runtime/map`, 30_000);
            if (!snapshot || !runtimeMap) throw new Error("could not read the fixture model from the API");
            const probeContext = await browser.newContext();
            const probePage = await probeContext.newPage();
            await probePage.goto(`${probeServer.url}/index.html`, { waitUntil: "domcontentloaded" });
            await probePage.waitForFunction("Boolean(window.__dockermapProbe)", undefined, {
              timeout: 30_000
            });
            await probePage.evaluate(
              `window.__benchInput = ${JSON.stringify({ snapshot, runtimeMap, samples })}`
            );
            const measured = (await probePage.evaluate(
              "window.__dockermapProbe.measureModel(window.__benchInput.snapshot, window.__benchInput.runtimeMap, window.__benchInput.samples)"
            )) as ProbeMeasurement | undefined;
            if (!measured) throw new Error("module probe returned no measurement");
            record(plan.name, "buildModelMs", measured.buildModelMs);
            record(plan.name, "legacyTopologyLayoutMs", measured.legacyTopologyLayoutMs);
            await probeContext.close();
          }
        } finally {
          if (publicationTracker) await publicationTracker.stop();
          stopOwned(apiChild);
          stopOwned(daemonChild);
          stopOwned(fixtureChild);
          if (webServer) await webServer.close();
          if (probeServer) await probeServer.close();
          if (benchAppServer) await benchAppServer.close();
        }
      }
    }
  } catch (error) {
    preserveRaw(String(error));
    throw error;
  } finally {
    await browser.close();
    rmSync(workRoot, { recursive: true, force: true });
  }

  /* --- Harness evidence ---------------------------------------------------
   * Two things the closed evidence schema deliberately does not carry, written
   * beside the artifact so a reviewer can audit them without trusting a summary:
   *
   * 1. the stage-6/7 independence control (verdict + per-run sample sets +
   *    per-sample acceptance audit);
   * 2. warm-up retention: for every warmed cell, the COMPLETE observation window
   *    in the order the daemon produced it, with the declared warm-up observations
   *    at the front and the recorded samples proven equal to the artifact's stored
   *    run, plus the declared-stationarity ratio of each window. A hidden slow
   *    warm-up value cannot survive this;
   * 3. the stage-5 poll-phase sweep: every sample's declared and observed phase,
   *    the observed phase curve, and the validity verdict of the declared design.
   *
   * A seam that cannot demonstrate independence, a warmed window that does not
   * match the artifact, or a phase sweep that does not cover the interval
   * invalidates the capture: no baseline is produced.
   */
  // After the run, re-hash the SAME executable. The daemon is spawned repeatedly
  // during a long capture (the resident daemon plus every cold-start probe), so a
  // substitution or rebuild mid-run would otherwise be invisible.
  assertDaemonBinaryProvenance({
    expectedSha256: environment.daemonBinarySha256,
    observedSha256: currentDaemonSha256(),
    phase: "after capture"
  });
  const daemonBinarySha256After = currentDaemonSha256();
  const daemonBinaryEvidence = {
    beforeCapture: daemonBinarySha256Before,
    afterCapture: daemonBinarySha256After,
    pinnedSha256: environment.daemonBinarySha256,
    build: environment.daemonBinaryBuild,
    cargoRevision: environment.cargoRevision,
    matches: daemonBinarySha256Before === daemonBinarySha256After
  };
  process.stdout.write(
    `[capture] daemon binary verified before and after the capture: ${daemonBinarySha256After.slice(0, 16)}… ` +
      `(matches: ${daemonBinaryEvidence.matches})\n`
  );
  const harnessEvidencePath = `${outputPath}.harness-evidence.json`;
  const warmUpsPerWindow = TIME_TO_ANSWER_WARM_UP_OBSERVATIONS;
  const warmUpRetention = TIME_TO_ANSWER_MATRIX.flatMap(({ fixture, stage }) => {
    const runs = raw[fixture]?.[stage];
    if (!runs || runs.length === 0) return [];
    const kind = TIME_TO_ANSWER_STAGE_KIND[stage] ?? "warmed-repeated";
    return runs.map((recorded, run) => {
      const label = `${fixture}|${stage}|run${run}`;
      const window = warmedObservationWindows[label] ?? null;
      return {
        fixture,
        stage,
        run,
        kind,
        recordedSampleCount: recorded.length,
        observationWindow: window,
        observationCount: window ? window.length : recorded.length,
        declaredWarmUpCount: warmUpsPerWindow,
        warmUpIndexRange: window ? [0, warmUpsPerWindow - 1] : null,
        warmUps: warmUpObservations[label] ?? null,
        stationarityRatio: warmUpStationarity[label] ?? null,
        warmUpsMatchWindow: window
          ? JSON.stringify(window.slice(0, warmUpsPerWindow)) === JSON.stringify(warmUpObservations[label] ?? null)
          : true,
        recordedMatchesArtifact: window
          ? JSON.stringify(window.slice(warmUpsPerWindow, warmUpsPerWindow + recorded.length)) ===
            JSON.stringify(recorded)
          : true
      };
    });
  });
  // Stage-5 poll-phase evidence: every sample's declared and observed phase, the
  // observed phase curve, and the per-run arrays the shared math consumes.
  const stageFiveByFixture = new Map<string, Array<PollPhaseSweep & { fixture: string }>>();
  for (const sample of stageFiveSweep) {
    stageFiveByFixture.set(sample.fixture, [...(stageFiveByFixture.get(sample.fixture) ?? []), sample]);
  }
  const stageFiveEvidence: Record<string, unknown> = {};
  for (const [fixture, samplesForFixture] of stageFiveByFixture) {
    const runs = [...new Set(samplesForFixture.map((sample) => sample.runIndex))]
      .sort((left, right) => left - right)
      .map((runIndex) =>
        samplesForFixture
          .filter((sample) => sample.runIndex === runIndex)
          .sort((left, right) => left.sampleIndex - right.sampleIndex)
          .map((sample) => sample.observedLatencyMs)
      );
    stageFiveEvidence[fixture] = {
      changes: POLL_PHASE_DIVISIONS,
      samples: samplesForFixture,
      phaseMediansMs: phaseMediansMs(runs, Number(environment.ssePollIntervalMs)),
      validity: stageFiveValidity[fixture] ?? null
    };
  }
  const harnessEvidence: {
    stageSeam: {
      delayMs: number;
      samplesPerFixture: number;
      fixtures: Record<string, unknown>;
      audit: Array<Record<string, unknown>>;
      error?: string;
    };
    warmUpObservations: Record<string, number[]>;
    warmUpStationarity: Record<string, number>;
    warmUpRetention: typeof warmUpRetention;
    stageFive: Record<string, unknown>;
    daemonBinary: typeof daemonBinaryEvidence;
  } = {
    stageSeam: {
      delayMs: TIME_TO_ANSWER_INDEPENDENCE_DELAY_MS,
      samplesPerFixture: TIME_TO_ANSWER_INDEPENDENCE_SAMPLES,
      fixtures: {},
      audit: stageSixSevenAudit
    },
    warmUpObservations,
    warmUpStationarity,
    warmUpRetention,
    stageFive: stageFiveEvidence,
    daemonBinary: daemonBinaryEvidence
  };
  const writeHarnessEvidence = (): void => {
    writeFileSync(harnessEvidencePath, `${JSON.stringify(harnessEvidence, null, 2)}\n`);
  };
  const stageSeamByFixture = new Map<string, typeof independencePairs>();
  for (const pair of independencePairs) {
    stageSeamByFixture.set(pair.fixture, [...(stageSeamByFixture.get(pair.fixture) ?? []), pair]);
  }
  try {
    // Warm-up retention, audited structurally rather than by value coincidence:
    // for every daemon-side warmed stage the complete observation window must be
    // retained, its first `declaredWarmUpCount` observations must BE the retained
    // warm-ups, and the recorded samples must be exactly the window minus those
    // warm-ups. Stages measured elsewhere (browser and probe stages) keep their own
    // warm-up inside the probe.
    for (const entry of warmUpRetention) {
      if (entry.recordedSampleCount !== samples) {
        throw new Error(
          `stage ${entry.fixture}|${entry.stage} run ${entry.run} recorded ${entry.recordedSampleCount} samples, expected ${samples}`
        );
      }
      const isDaemonStage = (BENCH_STAGE_KEYS as readonly string[]).includes(entry.stage);
      if (!isDaemonStage) continue;
      if (entry.observationWindow === null) {
        throw new Error(`no observation window was retained for ${entry.fixture}|${entry.stage} run ${entry.run}`);
      }
      if (entry.observationCount !== samples + TIME_TO_ANSWER_WARM_UP_OBSERVATIONS) {
        throw new Error(
          `warmed stage ${entry.fixture}|${entry.stage} run ${entry.run} kept ${entry.observationCount} observations, ` +
            `expected ${samples + TIME_TO_ANSWER_WARM_UP_OBSERVATIONS}`
        );
      }
      if (entry.declaredWarmUpCount !== TIME_TO_ANSWER_WARM_UP_OBSERVATIONS) {
        throw new Error(
          `warmed stage ${entry.fixture}|${entry.stage} run ${entry.run} declares ${entry.declaredWarmUpCount} warm-ups, ` +
            `expected the protocol's ${TIME_TO_ANSWER_WARM_UP_OBSERVATIONS}`
        );
      }
      if (!entry.warmUpsMatchWindow) {
        throw new Error(
          `warmed stage ${entry.fixture}|${entry.stage} run ${entry.run}: the retained warm-ups are not the window's first observations`
        );
      }
      if (!entry.recordedMatchesArtifact) {
        throw new Error(
          `warmed stage ${entry.fixture}|${entry.stage} run ${entry.run}: the recorded samples are not the window minus the declared warm-ups`
        );
      }
      if (entry.stationarityRatio === null) {
        throw new Error(
          `warmed stage ${entry.fixture}|${entry.stage} run ${entry.run} has no declared-stationarity verdict`
        );
      }
    }
    // Stage-5 poll-phase design: every declared phase represented, the publication
    // phase actually driven to its declared offset, the observation arriving through
    // the real API poller path, and an observed spread that spans the interval. A
    // sweep confined to a narrow band fails here.
    const stageFiveRequired = TIME_TO_ANSWER_REFERENCE_FIXTURES.filter((fixture) =>
      hasStage(fixture.name, "publicationToNodeObservationMs")
    )
      .map((fixture) => fixture.name)
      .filter((name) => !onlyFixtures || onlyFixtures.includes(name));
    const stageFiveMissing = stageFiveRequired.filter((name) => !stageFiveByFixture.has(name));
    if (stageFiveMissing.length > 0) {
      throw new Error(`the stage-5 poll-phase sweep did not run for ${stageFiveMissing.join(", ")}`);
    }
    for (const fixture of stageFiveRequired) {
      const verdict = assertPollPhaseSweep(
        stageFiveByFixture.get(fixture)!,
        Number(environment.ssePollIntervalMs),
        // Debug runs may declare a single controlled run, which cannot reach the
        // three-samples-per-phase the full protocol requires. The declared minimum is
        // therefore relaxed ONLY for probing runs, which can never emit an artifact
        // (the closed matrix requires three runs); every other guard still applies.
        runs >= TIME_TO_ANSWER_CONTROLLED_RUNS ? POLL_PHASE_MIN_SAMPLES_PER_PHASE : 1
      );
      stageFiveValidity[fixture] = verdict;
      stageFiveEvidence[fixture] = {
        ...(stageFiveEvidence[fixture] as Record<string, unknown>),
        validity: verdict
      };
      process.stdout.write(
        `[capture] stage 5 sweep ${fixture}: ${verdict.samples} samples over ${verdict.divisions} declared phases, ` +
          `span ${verdict.spanMs.toFixed(1)} ms (${(verdict.spanShare * 100).toFixed(1)} % of the interval), ` +
          `worst phase error ${verdict.worstPhaseErrorMs.toFixed(1)} ms, phase medians ` +
          `${verdict.fastestPhaseMedianMs.toFixed(1)}–${verdict.slowestPhaseMedianMs.toFixed(1)} ms\n`
      );
    }
    const required = TIME_TO_ANSWER_REFERENCE_FIXTURES.filter(
      (fixture) =>
        hasStage(fixture.name, "notificationToCoherentModelMs") &&
        hasStage(fixture.name, "coherentModelToUsefulRenderMs")
    )
      .map((fixture) => fixture.name)
      .filter((name) => !onlyFixtures || onlyFixtures.includes(name));
    const missing = required.filter((name) => !stageSeamByFixture.has(name));
    if (missing.length > 0) {
      throw new Error(`the stage-6/7 independence control did not run for ${missing.join(", ")}`);
    }
    for (const fixture of required) {
      const pairs = stageSeamByFixture.get(fixture)!;
      const verdict = assertStageSixSevenIndependence({
        fixture,
        delayMs: TIME_TO_ANSWER_INDEPENDENCE_DELAY_MS,
        normalStageSixMs: pairs.flatMap((pair) => pair.normalStageSixMs),
        normalStageSevenMs: pairs.flatMap((pair) => pair.normalStageSevenMs),
        controlStageSixMs: pairs.flatMap((pair) => pair.controlStageSixMs),
        controlStageSevenMs: pairs.flatMap((pair) => pair.controlStageSevenMs)
      });
      harnessEvidence.stageSeam.fixtures[fixture] = { runs: pairs, verdict };
      process.stdout.write(
        `[capture] stage 6/7 control ${fixture}: stage 6 ${verdict.stageSixMedianMs.toFixed(1)} -> ` +
          `${verdict.stageSixControlMedianMs.toFixed(1)} ms; stage 7 ${verdict.stageSevenMedianMs.toFixed(1)} -> ` +
          `${verdict.stageSevenControlMedianMs.toFixed(1)} ms for a ${verdict.delayMs} ms injected delay\n`
      );
    }
  } catch (error) {
    harnessEvidence.stageSeam.error = String(error);
    writeHarnessEvidence();
    preserveRaw(harnessEvidence.stageSeam.error);
    throw error;
  }
  writeHarnessEvidence();
  process.stdout.write(`[capture] harness evidence at ${harnessEvidencePath}\n`);

  try {
    const records = TIME_TO_ANSWER_MATRIX.map(({ fixture, stage }) => ({
      fixture,
      stage,
      runs: raw[fixture]?.[stage] ?? []
    }));
    const validated = validateTimeToAnswerEvidence({
      baseline: TIME_TO_ANSWER_BASELINE,
      environment,
      records
    });
    if (baselinePath) {
      assertTimeToAnswerPromotion(JSON.parse(readFileSync(baselinePath, "utf8")), validated);
    }
    writeFileSync(outputPath, JSON.stringify(validated, null, 2));
    process.stdout.write(
      `[capture] wrote ${outputPath} in ${((Date.now() - startedAt) / 60_000).toFixed(1)} min (fixture revision ${FIXTURE_REVISION})\n`
    );
  } catch (error) {
    // Assembly or validation failed: the measurement pass is expensive, so the
    // raw samples are preserved even though no artifact can be emitted.
    preserveRaw(String(error));
    throw error;
  }
}

await main();
