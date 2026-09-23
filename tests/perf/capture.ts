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
  TIME_TO_ANSWER_MATRIX,
  TIME_TO_ANSWER_REFERENCE_FIXTURES,
  TIME_TO_ANSWER_STAGES,
  TIME_TO_ANSWER_WARMED_SAMPLES,
  assertStageSixSevenIndependence,
  assertTimeToAnswerEnvironment,
  assertTimeToAnswerPromotion,
  assertDaemonBinaryProvenance,
  splitWarmedObservations,
  TIME_TO_ANSWER_STAGE_KIND,
  validateTimeToAnswerEvidence
} from "../../apps/web/src/lib/performance/timeToAnswerEvidence";
import { FIXTURE_REVISION, buildSlowComposeProject, expectedExitedCount } from "./dockerFixtureTopology.mjs";
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
 * recorded pin cannot drift from what actually ran, and it sets the trigger
 * jitter that de-correlates stage 5 from the two fixed 2 s cycles.
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
const daemonBinarySha256 = currentDaemonSha256();
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
 * The daemon's first-ever observation runs before its listener binds, so it is a
 * cold start. For warmed stages it is discarded from the recorded samples and
 * kept here instead, so the discard is auditable rather than silent.
 */
const warmUpObservations: Record<string, number> = {};

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
 * Stage 5 — daemon publication committed -> Node observes the new revision
 * through TODAY'S real mechanism, poll wait included.
 *
 * The publication instant is resolved by an external observer (the harness), not
 * by the product; the observation instant comes from the real API's SSE stream.
 * The API's poll interval is part of the pinned environment.
 *
 * The observer is ARMED before the harness triggers the change and stopped after
 * the sample's browser measurement resolves, so every revision belonging to the
 * sample is collected. A single fixture change can publish more than once (the
 * inventory and provider state can both move), and the browser's accepted
 * revision must be one of the revisions this observer actually saw.
 */
interface PublicationObservation {
  /** Milliseconds from the daemon publishing a new revision to the API emitting it. */
  ms: number;
  /** The first new revision the API emitted for this sample. */
  revision: string;
  /** Every distinct revision the API emitted for this sample, in order. */
  revisions: string[];
}

interface PublicationObserver {
  /**
   * Close the observation window. When `expectedRevision` is given, keep listening
   * (bounded by one poll interval plus a margin) until this connection has emitted
   * that revision too: every SSE connection polls on its OWN phase, so the
   * harness's stream can legitimately lag the browser's by up to one interval. The
   * recorded duration is unaffected — it is fixed at the first emission.
   */
  stop(expectedRevision?: string | null): Promise<PublicationObservation>;
}

async function startPublicationObservation(
  daemonPort: number,
  apiPort: number,
  webOrigin: string,
  previousRevision: string,
  timeoutMs = 45_000
): Promise<PublicationObserver> {
  const healthUrl = `http://127.0.0.1:${daemonPort}/daemon/health`;

  let observedAt = 0;
  const observedRevisions: string[] = [];
  const controller = new AbortController();
  const stream = await fetch(`http://127.0.0.1:${apiPort}/api/events/stream`, {
    headers: { accept: "text/event-stream", origin: webOrigin },
    signal: controller.signal
  });
  const reader = stream.body!.getReader();
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
            if (payload.modelRevision && payload.modelRevision !== previousRevision) {
              if (!observedRevisions.includes(payload.modelRevision)) observedRevisions.push(payload.modelRevision);
              if (!observedAt) observedAt = nowMs();
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

  let publishAt = 0;
  const deadline = Date.now() + timeoutMs;
  const publishing = (async () => {
    while (Date.now() < deadline) {
      const health = await fetchJson(healthUrl, 1_000);
      const revision = health?.modelRevision as string | undefined;
      if (revision && revision !== previousRevision) {
        publishAt = nowMs();
        return;
      }
      await sleep(2);
    }
  })();

  return {
    async stop(expectedRevision?: string | null): Promise<PublicationObservation> {
      await publishing;
      // Every SSE connection polls on its own phase, so when the caller names the
      // revision the browser accepted, keep this stream open until it has emitted
      // that revision too — bounded by one poll interval plus a margin. The
      // recorded duration is fixed at the first emission and never moves.
      const collectDeadline = expectedRevision ? Date.now() + pollIntervalMs + 1_500 : deadline;
      const satisfied = () =>
        Boolean(observedAt) && (!expectedRevision || observedRevisions.includes(expectedRevision));
      while (!satisfied() && Date.now() < collectDeadline) await sleep(5);
      controller.abort();
      await reading;
      if (!publishAt || !observedAt) {
        throw new Error("did not observe a new revision through both the daemon and the API stream");
      }
      return {
        ms: Math.max(0, observedAt - publishAt),
        revision: observedRevisions[0]!,
        revisions: observedRevisions
      };
    }
  };
}

interface StageSixSeven {
  /** Stage 6: browser notification -> the APPLICATION accepted a coherent model. */
  notificationToCoherentModelMs: number;
  /** Stage 7: coherent model accepted -> its Home content rendered + one frame. */
  coherentModelToUsefulRenderMs: number | null;
  acceptedRevision: string;
  acceptedSequence: number;
  notifiedRevision: string;
  latestNotifiedRevision: string;
  renderCommitMs: number;
  presentationFrameMs: number;
  metricLabel: string;
  beforeMetricValue: string | null;
  afterMetricValue: string | null;
  expectedMetricValue: string;
  metricChanged: boolean;
}

/**
 * Arm stages 6/7 BEFORE the publication change is triggered. Arming records the
 * pre-change Home metric value (so "the DOM changed" is measured rather than
 * assumed) and lets the probe wait for the NEXT accepted revision, identified by
 * its monotonic sequence number rather than by "any revision other than the last
 * one", so a publication that lands between arming and the trigger cannot be
 * mistaken for the sample's own.
 */
async function armStageSixSeven(page: any, input: { expectedMetricValue: string }): Promise<void> {
  const previousSeq = await page.evaluate("window.__dockermapBenchHelpers.currentAcceptedSeq()");
  await page.evaluate(
    `window.__benchInput = ${JSON.stringify({
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
        const daemonPort = await reservePort();
        const webPort = await reservePort();
        const probePort = await reservePort();
        const benchAppPort = await reservePort();
        const workdir = join(workRoot, `${plan.name}-${runIndex}`);
        mkdirSync(workdir, { recursive: true });
        const projectRoot = join(workdir, "compose-project");
        writeComposeProject(projectRoot, plan.scenario);
        const benchSink = join(workdir, "bench.jsonl");
        const fixtureSocket = join(workdir, "fixture.sock");
        const fixtureReady = join(workdir, "fixture.ready");

        let fixtureChild: any = null;
        let daemonChild: any = null;
        let apiChild: any = null;
        let webServer: any = null;
        let probeServer: any = null;
        let benchAppServer: any = null;
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
            DOCKERMAP_DAEMON_PORT: String(daemonPort),
            DOCKERMAP_DAEMON_HOST: "127.0.0.1",
            DOCKERMAP_PROJECT_ROOT: projectRoot,
            ...(plan.name === "unavailable-optional-provider" ? { PATH: emptyPath } : {})
          };
          const healthUrl = (port: number) => `http://127.0.0.1:${port}/daemon/health`;
          daemonChild = spawnOwned(daemonBinary, [], daemonEnv);
          await waitForJson(healthUrl(daemonPort), () => true, 60_000);

          // Stages 1 and 2 need a CLEAN start per warmed sample, so they are
          // measured by restarting the daemon `samples` times on private ports
          // rather than by reusing the resident benchmark daemon.
          const needsStartup = hasStage(plan.name, "daemonStartToListenerMs");
          if (needsStartup) {
            const starts: number[] = [];
            const models: number[] = [];
            for (let index = 0; index < samples; index += 1) {
              const probePort = await reservePort();
              const startAt = nowMs();
              const probeChild = spawnOwned(daemonBinary, [], {
                ...daemonEnv,
                // These transient cold-start probes must never write into the
                // warmed attribution sink: their first observation is a
                // cold-start sample, and mixing it into a stage documented as
                // "warmed" would be a provenance defect.
                DOCKERMAP_BENCH_STAGE_TIMING_PATH: join(workdir, "probe-bench.jsonl"),
                DOCKERMAP_DAEMON_PORT: String(probePort)
              });
              try {
                await waitForJson(healthUrl(probePort), () => true, 60_000);
                starts.push(nowMs() - startAt);
                const readyAt = nowMs();
                await waitForJson(
                  healthUrl(probePort),
                  (value) => value.mode === "docker" && Boolean(value.modelRevision),
                  60_000
                );
                models.push(nowMs() - readyAt);
              } finally {
                stopOwned(probeChild);
              }
            }
            record(plan.name, "daemonStartToListenerMs", starts);
            record(plan.name, "listenerToFirstDockerModelMs", models);
          }

          // Stages 3, 4, 9: bench attribution from the current implementation.
          const needsBench = BENCH_STAGE_KEYS.some((key) => hasStage(plan.name, key));
          if (needsBench) {
            const benchSamples = await waitForBenchSamples(benchSink, samples + 1, 300_000);
            for (const key of BENCH_STAGE_KEYS) {
              if (!hasStage(plan.name, key)) continue;
              if (TIME_TO_ANSWER_STAGE_KIND[key] !== "warmed-repeated") {
                record(plan.name, key, benchSamples[key]);
                continue;
              }
              // Exactly one warm-up observation is discarded per warmed daemon
              // stage — never an arbitrary slow sample — and is retained for the
              // raw audit trail.
              const { warmUp, recorded } = splitWarmedObservations(benchSamples[key], samples);
              warmUpObservations[`${plan.name}|${key}`] = warmUp;
              warmedObservationWindows[`${plan.name}|${key}|run${runIndex}`] =
                benchSamples[key].slice(0, samples + 1);
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
          webServer = await startStaticServer({ directory: join(REPO_ROOT, "apps/web/dist"), port: webPort });
          probeServer = await startStaticServer({
            directory: join(REPO_ROOT, "tests/perf/.bench-dist"),
            port: probePort
          });
          const webOrigin = webServer.url;
          if (needsStageSix) {
            benchAppServer = await startStaticServer({
              directory: join(REPO_ROOT, "tests/perf/.bench-app-dist"),
              port: benchAppPort
            });
          }
          apiChild = spawnOwned(process.execPath, [join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs"), "apps/api/src/index.ts"], {
            PORT: String(apiPort),
            DOCKERMAP_DAEMON_URL: `http://127.0.0.1:${daemonPort}`,
            // The API must accept both browser origins: the production build for
            // Cmd-K and the cold production load, the benchmark-mode build for
            // coherent-model acceptance.
            DOCKERMAP_ALLOWED_ORIGINS: [webOrigin, benchAppServer?.url].filter(Boolean).join(","),
            // Pinned explicitly so the recorded interval and the interval that
            // actually ran cannot diverge; this is the API's own default.
            DOCKERMAP_SSE_INTERVAL_MS: String(pollIntervalMs)
          });
          await waitForJson(`http://127.0.0.1:${apiPort}/api/health`, () => true, 60_000);

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
            for (let index = 0; index < samples; index += 1) {
              // Generation `g` stops the fixture's first `g` containers, so the
              // expected Home metric for the publication this sample triggers is
              // derived from the fixture rather than assumed.
              const generation = index + 1;
              const expectedMetricValue = String(expectedExitedCount(plan.containers, plan.scenario, generation));
              // The revision the daemon has already published: the observation
              // window starts from it, so the harness can neither miss the change
              // nor wait for a second one.
              const beforeTrigger = await fetchJson(healthUrl(daemonPort), 5_000);
              const previousRevision = (beforeTrigger?.modelRevision as string | undefined) ?? "";
              // Arm BOTH sample-scoped observers before the trigger: the API
              // observation (stage 5) and the browser acceptance/render measurement
              // (stages 6/7). Nothing is attributed to a sample it does not belong
              // to, and no publication can be missed between arming and the trigger.
              const publication = hasStage(plan.name, "publicationToNodeObservationMs")
                ? await startPublicationObservation(daemonPort, apiPort, webOrigin, previousRevision)
                : null;
              if (needsStageSix) {
                await armStageSixSeven(benchPage, { expectedMetricValue });
              }
              // De-correlate the trigger from the two fixed 2 s cycles (the
              // daemon's refresh loop and the API's poller). Without this the
              // observed gap is one fixed phase offset between them — a number
              // that moves by hundreds of ms if the harness simply starts the
              // daemon a second earlier — instead of a sample of the real
              // poll-wait distribution.
              await sleep(Math.random() * pollIntervalMs);
              if (plan.name === "docker-topology-change" || plan.name.startsWith("reference-")) {
                // A real published inventory change: the fixture daemon serves a
                // new generation, so the daemon must publish a new revision.
                await postUnix(fixtureSocket, `/__fixture/topology-generation/${generation}`);
              }
              // `provider-only-revision-change` and `unavailable-optional-provider`
              // need no trigger: their revision advance comes from provider state
              // alone, which is exactly what those fixtures characterise.
              let observed: PublicationObservation | null = null;
              if (publication && !needsStageSix) {
                // Nothing else consumes this sample, so the observation can be
                // closed as soon as the change has propagated through the API.
                observed = await publication.stop();
              }
              if (needsStageSix) {
                let measured: StageSixSeven | null = null;
                try {
                  measured = await awaitModelAcceptance(benchPage);
                } finally {
                  // Closed after the browser measurement resolves, and held open
                  // until this stream has seen the revision the browser accepted.
                  if (publication) observed = await publication.stop(measured?.acceptedRevision ?? null);
                }
                if (!measured) throw new Error("model acceptance probe returned no measurement");
                coherentSamples.push(measured.notificationToCoherentModelMs);
                if (typeof measured.coherentModelToUsefulRenderMs === "number") {
                  usefulSamples.push(measured.coherentModelToUsefulRenderMs);
                }
                const seen: PublicationObservation | null = observed;
                // Chain of custody: the revision the browser accepted must be one
                // the harness independently observed through the live API stream for
                // THIS sample. A mismatch fails the capture rather than recording a
                // number whose origin is unknown.
                if (seen && !seen.revisions.includes(measured.acceptedRevision)) {
                  throw new Error(
                    `the browser accepted revision ${measured.acceptedRevision}, which the API never observed for this sample ` +
                      `(observed: ${seen.revisions.join(", ") || "none"})`
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
                  apiObservedRevisions: seen?.revisions ?? []
                });
              }
              const recorded: PublicationObservation | null = observed;
              if (recorded) observationSamples.push(recorded.ms);
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
              await armStageSixSeven(benchPage, {
                previous: await benchPage.evaluate("window.__dockermapBenchHelpers.currentAcceptedRevision()"),
                expectedMetricValue
              });
              await sleep(Math.random() * pollIntervalMs);
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
   *    (`samples + 1`) in the order the daemon produced it, with the discarded
   *    warm-up at index 0 and the recorded samples proven equal to the artifact's
   *    stored run. A hidden slow warm-up value cannot survive this.
   *
   * A seam that cannot demonstrate independence, or a warmed window that does not
   * match the artifact, invalidates the capture: no baseline is produced.
   */
  const harnessEvidencePath = `${outputPath}.harness-evidence.json`;
  const warmUpRetention = TIME_TO_ANSWER_MATRIX.flatMap(({ fixture, stage }) => {
    const runs = raw[fixture]?.[stage];
    if (!runs || runs.length === 0) return [];
    const kind = TIME_TO_ANSWER_STAGE_KIND[stage] ?? "warmed-repeated";
    return runs.map((recorded, run) => {
      const window = warmedObservationWindows[`${fixture}|${stage}|run${run}`] ?? null;
      return {
        fixture,
        stage,
        run,
        kind,
        recordedSampleCount: recorded.length,
        observationWindow: window,
        observationCount: window ? window.length : recorded.length,
        warmUpIndex: window ? 0 : null,
        warmUpObservationMs: window ? window[0] : null,
        warmUpInRecordedWindow: window ? window.slice(1, recorded.length + 1) : null,
        recordedMatchesArtifact: window
          ? JSON.stringify(window.slice(1, recorded.length + 1)) === JSON.stringify(recorded)
          : true
      };
    });
  });
  const harnessEvidence: {
    stageSeam: {
      delayMs: number;
      samplesPerFixture: number;
      fixtures: Record<string, unknown>;
      audit: Array<Record<string, unknown>>;
      error?: string;
    };
    warmUpObservations: Record<string, number>;
    warmUpRetention: typeof warmUpRetention;
  } = {
    stageSeam: {
      delayMs: TIME_TO_ANSWER_INDEPENDENCE_DELAY_MS,
      samplesPerFixture: TIME_TO_ANSWER_INDEPENDENCE_SAMPLES,
      fixtures: {},
      audit: stageSixSevenAudit
    },
    warmUpObservations,
    warmUpRetention
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
    // retained, index 0 must be the discarded warm-up, and the recorded samples
    // must be exactly that window minus the warm-up. Stages measured elsewhere
    // (browser and probe stages) keep their own warm-up inside the probe.
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
      if (entry.observationCount !== samples + 1) {
        throw new Error(
          `warmed stage ${entry.fixture}|${entry.stage} run ${entry.run} kept ${entry.observationCount} observations, expected ${samples + 1}`
        );
      }
      if (entry.warmUpIndex !== 0) {
        throw new Error(
          `warmed stage ${entry.fixture}|${entry.stage} run ${entry.run} discarded observation ${entry.warmUpIndex}, expected the first`
        );
      }
      if (!entry.recordedMatchesArtifact) {
        throw new Error(
          `warmed stage ${entry.fixture}|${entry.stage} run ${entry.run}: the recorded samples are not the window minus the discarded warm-up`
        );
      }
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
