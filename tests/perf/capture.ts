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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  TIME_TO_ANSWER_BASELINE,
  TIME_TO_ANSWER_CONTROLLED_RUNS,
  TIME_TO_ANSWER_MATRIX,
  TIME_TO_ANSWER_REFERENCE_FIXTURES,
  TIME_TO_ANSWER_STAGES,
  TIME_TO_ANSWER_WARMED_SAMPLES,
  assertTimeToAnswerEnvironment,
  assertTimeToAnswerPromotion,
  validateTimeToAnswerEvidence
} from "../../apps/web/src/lib/performance/timeToAnswerEvidence";
import { FIXTURE_REVISION, buildSlowComposeProject } from "./dockerFixtureTopology.mjs";
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
const launchArgs = (environment.browserFlags as string[]).filter(Boolean);

const plans = TIME_TO_ANSWER_REFERENCE_FIXTURES.filter(
  (fixture) => !onlyFixtures || onlyFixtures.includes(fixture.name)
).map((fixture) => ({
  name: fixture.name,
  containers: fixture.containers,
  scenario: fixture.kind === "reference" ? "reference" : fixture.name
}));

const raw: RawSamples = {};
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
 * The publication instant is resolved by an external observer (the harness),
 * not by the product; the observation instant comes from the real API's SSE
 * stream. The API's poll interval is part of the pinned environment.
 */
async function measurePublicationToNodeObservation(
  daemonPort: number,
  apiPort: number,
  webOrigin: string,
  timeoutMs = 45_000
): Promise<number> {
  const healthUrl = `http://127.0.0.1:${daemonPort}/daemon/health`;
  const start = await waitForJson(healthUrl, (value) => Boolean(value.modelRevision), 30_000);
  const startRevision = start.modelRevision as string;

  let observedAt = 0;
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
            if (payload.modelRevision && payload.modelRevision !== startRevision && !observedAt) {
              observedAt = nowMs();
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
  while (Date.now() < deadline) {
    const health = await fetchJson(healthUrl, 1_000);
    const revision = health?.modelRevision as string | undefined;
    if (revision && revision !== startRevision) {
      publishAt = nowMs();
      break;
    }
    await sleep(2);
  }
  while (!observedAt && Date.now() < deadline) await sleep(5);
  controller.abort();
  await reading;
  if (!publishAt || !observedAt) {
    throw new Error("did not observe a new revision through both the daemon and the API stream");
  }
  return Math.max(0, observedAt - publishAt);
}

interface StageSixSeven {
  notificationToCoherentModelMs: number;
  coherentModelToUsefulRenderMs: number | null;
}

async function measureModelAcceptance(
  page: any,
  initialRevision: string,
  needHome: boolean,
  timeoutMs = 60_000
): Promise<StageSixSeven> {
  await page.evaluate(
    `window.__benchInput = ${JSON.stringify({ previous: initialRevision, limit: timeoutMs, needHome })}`
  );
  const measured = await page.evaluate(
    "window.__dockermapBenchHelpers.measureModelAcceptance(window.__benchInput.previous, window.__benchInput.limit, window.__benchInput.needHome)"
  );
  if (!measured) throw new Error("model acceptance probe returned no measurement");
  return measured as StageSixSeven;
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
            const benchSamples = await waitForBenchSamples(benchSink, samples, 300_000);
            for (const key of BENCH_STAGE_KEYS) record(plan.name, key, benchSamples[key]);
          }

          const needsApp =
            hasStage(plan.name, "publicationToNodeObservationMs") ||
            hasStage(plan.name, "notificationToCoherentModelMs") ||
            hasStage(plan.name, "commandQueryMs") ||
            hasStage(plan.name, "productionBundleMs");
          if (!needsApp) continue;
          webServer = await startStaticServer({ directory: join(REPO_ROOT, "apps/web/dist"), port: webPort });
          probeServer = await startStaticServer({
            directory: join(REPO_ROOT, "tests/perf/.bench-dist"),
            port: probePort
          });
          const webOrigin = webServer.url;
          apiChild = spawnOwned(process.execPath, [join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs"), "apps/api/src/index.ts"], {
            PORT: String(apiPort),
            DOCKERMAP_DAEMON_URL: `http://127.0.0.1:${daemonPort}`,
            DOCKERMAP_ALLOWED_ORIGINS: webOrigin,
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
            hasStage(plan.name, "publicationToNodeObservationMs") ||
            hasStage(plan.name, "notificationToCoherentModelMs");
          if (needsRevisionLoop) {
            for (let index = 0; index < samples; index += 1) {
              const initialRevision: string = hasStage(plan.name, "notificationToCoherentModelMs")
                ? await page.evaluate("window.__dockermapBenchHelpers.currentRevision()")
                : "";
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
                await postUnix(fixtureSocket, `/__fixture/topology-generation/${index + 1}`);
              }
              // `provider-only-revision-change` and `unavailable-optional-provider`
              // need no trigger: their revision advance comes from provider state
              // alone, which is exactly what those fixtures characterise.
              if (hasStage(plan.name, "publicationToNodeObservationMs")) {
                observationSamples.push(
                  await measurePublicationToNodeObservation(daemonPort, apiPort, webOrigin)
                );
              }
              if (hasStage(plan.name, "notificationToCoherentModelMs")) {
                const measured = await measureModelAcceptance(
                  page,
                  initialRevision,
                  hasStage(plan.name, "coherentModelToUsefulRenderMs")
                );
                coherentSamples.push(measured.notificationToCoherentModelMs);
                if (typeof measured.coherentModelToUsefulRenderMs === "number") {
                  usefulSamples.push(measured.coherentModelToUsefulRenderMs);
                }
              }
            }
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
