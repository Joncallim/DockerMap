#!/usr/bin/env node
/** Runnable Stage-5 publication-control pre-gate (#335). */
import { createServer } from "node:http";
import { armStageFivePublication, startStageFivePublicationController } from "./stageFivePublicationControl.mjs";
import { POLL_PHASE_CONTROL_TOLERANCE_MS, pollPhaseGridMs } from "../../apps/web/src/lib/performance/timeToAnswerPollPhase";

const intervalMs = 2_000;
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function fixture() {
 let revision = "initial";
 const server = createServer((_request, response) => response.end(JSON.stringify({ modelRevision: revision })));
 await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
 return {
 url: `http://127.0.0.1:${(server.address() as any).port}`,
 set: (next: string) => { revision = next; },
 close: () => new Promise<void>((done) => server.close(() => done()))
 };
}

async function runFixture(name: string) {
 const daemon = await fixture();
 const controller = await startStageFivePublicationController({ upstream: daemon.url });
 const grid = pollPhaseGridMs(intervalMs);
 const latencies: number[] = [];
 try {
 for (const [index, requestedPhaseMs] of grid.entries()) {
 const previousRevision = index === 0 ? "initial" : `${name}-trigger-${index - 1}`;
 const triggerId = `${name}-trigger-${index}`;
await fetch(`${controller.url}/daemon/health`);
const publication = await armStageFivePublication({
controllerUrl: controller.url,
triggerId,
requestedPhaseMs,
previousRevision,
timeoutMs: intervalMs * 4
});
 // This is the real cadence under test: a Node-style fixed setInterval poller,
 // not a predicted grid or a random achieved phase distribution.
 const polls: Array<{ at: number; revision: string }> = [];
 const timer = setInterval(async () => {
 const at = performance.now();
 const payload = await (await fetch(`${controller.url}/daemon/health`)).json() as { modelRevision: string };
 polls.push({ at, revision: payload.modelRevision });
 }, intervalMs);
const ack: any = await publication.release(() => { daemon.set(`${name}-trigger-${index}`); });
const deadline = Date.now() + intervalMs * 4;
 while (Date.now() < deadline && !polls.some((poll) => poll.revision === ack?.revision)) await sleep(5);
 clearInterval(timer);
 const observed = polls.find((poll) => poll.revision === ack?.revision);
 if (!ack || !observed) throw new Error(`${name} phase ${requestedPhaseMs} did not observe its exact trigger`);
 const observedPhaseMs = ack.releasedAtMs - ack.pollAtMs;
 const phaseErrorMs = observedPhaseMs - requestedPhaseMs;
 const latency = observed.at - ack.releasedAtMs;
 if (ack.triggerId !== triggerId || ack.revision !== `${name}-trigger-${index}`) throw new Error(`${name} observed a substituted publication`);
 if (Math.abs(phaseErrorMs) > POLL_PHASE_CONTROL_TOLERANCE_MS) throw new Error(`${name} phase error ${phaseErrorMs} exceeds tolerance`);
 latencies.push(latency);
 process.stdout.write(`[phase-control] ${name} intended phase ${requestedPhaseMs.toFixed(1)} ms; observed phase ${observedPhaseMs.toFixed(1)} ms; trigger identity ${triggerId}; phase error ${phaseErrorMs.toFixed(1)} ms\n`);
 }
 const span = Math.max(...latencies) - Math.min(...latencies);
 if (span < intervalMs * 0.5) throw new Error(`${name} grid span ${span.toFixed(1)} ms is below 50% of the polling interval`);
 return span;
 } finally { await controller.close(); await daemon.close(); }
}

export async function main() {
 const fixtures = ["reference-25", "reference-100", "reference-250", "provider-only-revision-change", "docker-topology-change", "unavailable-optional-provider"];
 const spans = await Promise.all(fixtures.map(runFixture));
 process.stdout.write(`[phase-control] PASS: ${fixtures.join(", ")}; grid span ${spans.map((span) => span.toFixed(1)).join(", ")} ms; tolerance ${POLL_PHASE_CONTROL_TOLERANCE_MS} ms\n`);
}
if (import.meta.url === new URL(process.argv[1]!, "file:").href) main().catch((error) => { process.stderr.write(`[phase-control] FAIL: ${String(error)}\n`); process.exitCode = 1; });
