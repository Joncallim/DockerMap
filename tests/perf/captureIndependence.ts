#!/usr/bin/env node
/**
 * Controlled Stage-6/7 independence protocol.  This is deliberately a complete
 * harness rather than a mode of capture.ts: controls must never become
 * Baseline-4 observations.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import {
  TIME_TO_ANSWER_CONTROLLED_RUNS, TIME_TO_ANSWER_INDEPENDENCE_DELAY_MS,
  TIME_TO_ANSWER_INDEPENDENCE_SAMPLES, TIME_TO_ANSWER_METHODOLOGY,
  TIME_TO_ANSWER_WARMED_SAMPLES, assertDaemonBinaryProvenance,
  assertStageSixSevenIndependence, assertTimeToAnswerEnvironment
} from "../../apps/web/src/lib/performance/timeToAnswerEvidence";
import { armStageFivePublication, startStageFivePublicationController } from "./stageFivePublicationControl.mjs";
import { reservePort, startStaticServer } from "./staticServer.mjs";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const fixtures = [{ name: "reference-25", containers: 25 }, { name: "reference-100", containers: 100 }, { name: "reference-250", containers: 250 }, { name: "docker-topology-change", containers: 25, scenario: "docker-topology-change" }];
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const now = () => Number(process.hrtime.bigint()) / 1e6;
function values(argv: string[]) { return Object.fromEntries(argv.flatMap((value, index, all) => value.startsWith("--") ? [[value.slice(2), all[index + 1] ?? ""]] : [])); }
function git(...args: string[]) { const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" }); if (result.status) throw new Error(result.stderr); return result.stdout.trim(); }
function raw(directory: string, value: unknown) { const target = join(directory, "controlled-stage6-stage7-independence"); mkdirSync(target, { recursive: true }); appendFileSync(join(target, "evidence.jsonl"), `${JSON.stringify(value)}\n`); }
function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}) { const result = spawnSync(command, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`); }
function spawnOwned(command: string, args: string[], env: NodeJS.ProcessEnv = {}) { const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env }, detached: true, stdio: "ignore" }); return child; }
function stop(child: any) { if (!child?.pid || child.exitCode !== null || child.signalCode) return; try { process.kill(-child.pid, "SIGKILL"); } catch { try { process.kill(child.pid, "SIGKILL"); } catch {} } }
async function json(url: string, timeout = 2_000): Promise<any | null> { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout); try { const response = await fetch(url, { signal: controller.signal }); return response.ok ? response.json() : null; } catch { return null; } finally { clearTimeout(timer); } }
async function wait(url: string, predicate: (body: any) => boolean, timeout = 60_000): Promise<any> { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const body = await json(url); if (body && predicate(body)) return body; await sleep(25); } throw new Error(`timed out waiting for ${url}`); }
function postUnix(socketPath: string, path: string) { return new Promise<void>((done, fail) => { const call = request({ socketPath, path, method: "POST" }, (response) => response.statusCode === 200 ? done() : fail(new Error(`fixture trigger failed: ${response.statusCode}`))); call.on("error", fail); call.end(); }); }
function contains(directory: string, needle: string): boolean { for (const entry of readdirSync(directory, { withFileTypes: true })) { const file = join(directory, entry.name); if (entry.isDirectory() ? contains(file, needle) : /\.(js|mjs|html)$/.test(entry.name) && readFileSync(file, "utf8").includes(needle)) return true; } return false; }
function assertIsolation() { if (contains(join(ROOT, "apps/web/dist"), "__dockermapBenchAcceptanceSink")) throw new Error("production build contains benchmark acceptance seam"); if (!contains(join(ROOT, "tests/perf/.bench-app-dist"), "__dockermapBenchAcceptanceSink")) throw new Error("benchmark build lacks real acceptance seam"); }

type Sample = { stageSixMs: number; stageSevenMs: number; triggerRevision: string; acceptedRevision: string; acceptanceSeam: "observed"; delayAppliedAfterAcceptance: boolean };
/** A full isolated fixture/API/browser lifecycle for one controlled sample. */
export async function runControlledStageSixSeven(input: { fixture: string; containers: number; scenario?: string; control: boolean; delayMs: number; rawDir: string; generation: number; daemonBinary: string; apiPort: number; pollIntervalMs: number; browserFlags: string[] }): Promise<Sample> {
 if ((!input.control && input.delayMs !== 0) || (input.control && input.delayMs !== TIME_TO_ANSWER_INDEPENDENCE_DELAY_MS)) throw new Error("independence delay contract violated");
 if (!Number.isInteger(input.generation) || input.generation < 1 || input.generation > input.containers) throw new Error("fixture generation must remain within the observable container count");
  const work = mkdtempSync(join(tmpdir(), "dockermap-independence-"));
  const socket = join(work, "fixture.sock"), ready = join(work, "fixture.ready");
  let fixture: any, daemon: any, api: any, controller: any, server: any, browser: any, context: any;
  const lifecycle: string[] = [];
  try {
    fixture = spawnOwned(process.execPath, ["tests/perf/fake-docker-api.mjs", "--socket", socket, "--containers", String(input.containers), "--scenario", input.scenario ?? "reference", "--ready-file", ready]); lifecycle.push("fixture");
    const fixtureDeadline = Date.now() + 15_000; while (!existsSync(ready) && Date.now() < fixtureDeadline) await sleep(25); if (!existsSync(ready)) throw new Error("fixture did not become ready");
    const daemonPort = await reservePort();
    daemon = spawnOwned(input.daemonBinary, [], { DOCKERMAP_DOCKER_GATEWAY_SOCKET: socket, DOCKERMAP_DAEMON_HOST: "127.0.0.1", DOCKERMAP_DAEMON_PORT: String(daemonPort) }); lifecycle.push("daemon");
    const health = await wait(`http://127.0.0.1:${daemonPort}/daemon/health`, (body) => Boolean(body.modelRevision));
    controller = await startStageFivePublicationController({ upstream: `http://127.0.0.1:${daemonPort}` }); lifecycle.push("controller");
    server = await startStaticServer({ directory: join(ROOT, "tests/perf/.bench-app-dist"), port: 0 }); lifecycle.push("static");
    api = spawnOwned(process.execPath, [join(ROOT, "node_modules/tsx/dist/cli.mjs"), "apps/api/src/index.ts"], { PORT: String(input.apiPort), DOCKERMAP_DAEMON_URL: controller.url, DOCKERMAP_ALLOWED_ORIGINS: server.url, DOCKERMAP_SSE_INTERVAL_MS: String(input.pollIntervalMs) }); lifecycle.push("api");
    await wait(`http://127.0.0.1:${input.apiPort}/api/health`, Boolean);
    browser = await chromium.launch({ args: input.browserFlags }); lifecycle.push("browser"); context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage(); await page.addInitScript({ path: join(ROOT, "tests/perf/browserProbe.js") }); await page.goto(`${server.url}/`, { waitUntil: "domcontentloaded" }); await page.waitForFunction("window.__dockermapBenchHelpers.homeReady()", undefined, { timeout: 90_000 });
    const previousSeq = await page.evaluate("window.__dockermapBenchHelpers.currentAcceptedSeq()");
    await page.evaluate(`window.__dockermapBenchRenderDelayMs = ${JSON.stringify(input.delayMs)}`);
    await page.evaluate(`window.__dockermapBenchHelpers.armModelAcceptance(${JSON.stringify({ mode: "content", previousSeq, limit: 60_000, metricLabel: "Offline", expectedMetricValue: String(input.generation), awaitPublicationTrigger: true })})`);
    const triggerId = `${input.fixture}-${input.generation}-${input.control ? "control" : "normal"}`;
    const publication = await armStageFivePublication({ controllerUrl: controller.url, triggerId, requestedPhaseMs: 0, previousRevision: health.modelRevision, timeoutMs: input.pollIntervalMs * 4 });
    await page.evaluate("window.__dockermapBenchHelpers.markModelPublicationTriggered()");
    const ack = await publication.release(async () => { await postUnix(socket, `/__fixture/topology-generation/${input.generation}`); });
    await page.evaluate(`window.__dockermapBenchHelpers.setExpectedModelRevision(${JSON.stringify(ack.revision)})`);
    const measured: any = await page.evaluate("window.__dockermapBenchHelpers.awaitModelAcceptance()");
    if (ack.triggerId !== triggerId || measured.triggerRevision !== String(health.modelRevision) || measured.acceptedRevision !== ack.revision) throw new Error("exact trigger/revision identity was not observed at acceptance");
    const origins: string[] = await page.evaluate("window.__dockermapBenchHelpers.requestOrigins()"); const stream: string = await page.evaluate("window.__dockermapBenchHelpers.streamUrl()");
    if (origins.includes(`http://127.0.0.1:${daemonPort}`) || !origins.includes(`http://127.0.0.1:${input.apiPort}`) || !stream.startsWith(`http://127.0.0.1:${input.apiPort}/api/events/stream`)) throw new Error("benchmark bypassed the real API SSE path");
    // `ack.revision` is the shared controller's exact trigger identity; the
    // browser's `triggerRevision` is intentionally the pre-trigger revision.
    const result = { stageSixMs: measured.notificationToCoherentModelMs, stageSevenMs: measured.coherentModelToUsefulRenderMs, triggerRevision: ack.revision, acceptedRevision: measured.acceptedRevision, acceptanceSeam: "observed" as const, delayAppliedAfterAcceptance: input.delayMs === 0 || measured.coherentModelToUsefulRenderMs >= input.delayMs };
    if (!Number.isFinite(result.stageSixMs) || !Number.isFinite(result.stageSevenMs) || !result.delayAppliedAfterAcceptance) throw new Error("invalid acceptance or post-acceptance delay proof");
    raw(input.rawDir, { fixture: input.fixture, control: input.control, generation: input.generation, lifecycle, ack, measured, result, at: now() });
    return result;
  } catch (error) { raw(input.rawDir, { fixture: input.fixture, control: input.control, generation: input.generation, lifecycle, verdict: "FAIL", error: String(error) }); throw error; }
  finally { try { await context?.close(); } finally { try { await browser?.close(); } finally { try { await server?.close(); } finally { try { await controller?.close(); } finally { stop(api); stop(daemon); stop(fixture); rmSync(work, { recursive: true, force: true }); } } } } }
}

export async function main() {
  const input = values(process.argv.slice(2));
  if (!input.metadata || !input.output || !input["raw-dir"] || !input.checkpoint) throw new Error("--metadata, --output, --raw-dir and --checkpoint are required");
  const metadata = JSON.parse(readFileSync(input.metadata, "utf8")); assertTimeToAnswerEnvironment(metadata.environment);
  if (git("status", "--porcelain")) throw new Error("refusing independence protocol from a dirty worktree");
  if (git("rev-parse", "HEAD") !== input.checkpoint || metadata.environment.sourceRevision !== input.checkpoint || metadata.environment.harnessRevision !== git("log", "-1", "--format=%H", "--", "tests/perf", "apps/web/src/lib/performance")) throw new Error("checkpoint must exactly bind metadata, harness and HEAD");
  if (metadata.environment.methodologyVersion !== TIME_TO_ANSWER_METHODOLOGY) throw new Error("metadata methodology mismatch");
  const daemonBinary = metadata.daemonBinary ?? join(ROOT, "crates/target/release/dockermap-daemon"); const digest = () => createHash("sha256").update(readFileSync(daemonBinary)).digest("hex");
  assertDaemonBinaryProvenance({ expectedSha256: metadata.environment.daemonBinarySha256, observedSha256: digest(), phase: "before independence capture" });
  const apiPort = await reservePort();
  run("npm", ["run", "build", "--workspace", "@dockermap/contracts"]); run("npm", ["run", "build", "--workspace", "@dockermap/web"]); run("npx", ["vite", "build", "--config", "tests/perf/benchAppVite.config.mjs"], { VITE_API_BASE_URL: `http://127.0.0.1:${apiPort}` }); assertIsolation();
  const cells: any[] = [];
  try {
    for (const fixture of fixtures) {
      const normal: Sample[] = [], control: Sample[] = [];
      // Every sample owns a fresh fixture lifecycle, so generation one is a
      // discriminating transition on every fixture and cannot saturate its
      // Offline count during the fixed 48-sample protocol.
      for (let runIndex = 0; runIndex < TIME_TO_ANSWER_CONTROLLED_RUNS; runIndex++) for (let sample = 0; sample < TIME_TO_ANSWER_WARMED_SAMPLES; sample++) normal.push(await runControlledStageSixSeven({ fixture: fixture.name, containers: fixture.containers, scenario: fixture.scenario, control: false, delayMs: 0, rawDir: input["raw-dir"], generation: 1, daemonBinary, apiPort, pollIntervalMs: Number(metadata.environment.ssePollIntervalMs), browserFlags: metadata.environment.browserFlags }));
      for (let sample = 0; sample < TIME_TO_ANSWER_INDEPENDENCE_SAMPLES; sample++) control.push(await runControlledStageSixSeven({ fixture: fixture.name, containers: fixture.containers, scenario: fixture.scenario, control: true, delayMs: TIME_TO_ANSWER_INDEPENDENCE_DELAY_MS, rawDir: input["raw-dir"], generation: 1, daemonBinary, apiPort, pollIntervalMs: Number(metadata.environment.ssePollIntervalMs), browserFlags: metadata.environment.browserFlags }));
      const verdict = assertStageSixSevenIndependence({ fixture: fixture.name, normalStageSixMs: normal.map((s) => s.stageSixMs), normalStageSevenMs: normal.map((s) => s.stageSevenMs), controlStageSixMs: control.map((s) => s.stageSixMs), controlStageSevenMs: control.map((s) => s.stageSevenMs) });
      cells.push({ fixture: fixture.name, normalStageSixRuns: Array.from({ length: TIME_TO_ANSWER_CONTROLLED_RUNS }, (_, runIndex) => normal.slice(runIndex * TIME_TO_ANSWER_WARMED_SAMPLES, (runIndex + 1) * TIME_TO_ANSWER_WARMED_SAMPLES).map((s) => s.stageSixMs)), normalStageSevenRuns: Array.from({ length: TIME_TO_ANSWER_CONTROLLED_RUNS }, (_, runIndex) => normal.slice(runIndex * TIME_TO_ANSWER_WARMED_SAMPLES, (runIndex + 1) * TIME_TO_ANSWER_WARMED_SAMPLES).map((s) => s.stageSevenMs)), controlEvidence: { delayMs: TIME_TO_ANSWER_INDEPENDENCE_DELAY_MS, acceptanceSeam: "observed", triggerRevision: control[0]?.triggerRevision, acceptedRevision: control[0]?.acceptedRevision, samples: control, verdict } });
    }
    assertDaemonBinaryProvenance({ expectedSha256: metadata.environment.daemonBinarySha256, observedSha256: digest(), phase: "after independence capture" });
    writeFileSync(input.output, `${JSON.stringify({ methodologyVersion: TIME_TO_ANSWER_METHODOLOGY, checkpointSha: input.checkpoint, measurementProtocol: "controlled-stage6-stage7-independence", cells, independenceEvidence: { verdict: "PASS", controlSamplesExcludedFromBaselineTiming: true } }, null, 2)}\n`);
  } catch (error) { raw(input["raw-dir"], { verdict: "FAIL", error: String(error) }); throw error; }
}
if (import.meta.url === new URL(process.argv[1]!, "file:").href) main().catch((error) => { process.stderr.write(`[independence] FAIL: ${String(error)}\n`); process.exitCode = 1; });
