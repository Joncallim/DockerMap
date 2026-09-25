#!/usr/bin/env node
/**
 * Dedicated controlled Stage-5 sub-benchmark (#335).
 *
 * This intentionally has no import from capture.ts.  It owns the only
 * arm -> mark -> trigger -> identity-ack protocol used to make a Stage-5
 * cell, and emits its own raw evidence section for composite assembly.
 */
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import {
 TIME_TO_ANSWER_CONTROLLED_RUNS,
 TIME_TO_ANSWER_METHODOLOGY,
 TIME_TO_ANSWER_STAGES,
 TIME_TO_ANSWER_WARMED_SAMPLES
} from "../../apps/web/src/lib/performance/timeToAnswerEvidence";
import { POLL_PHASE_CONTROL_TOLERANCE_MS, declaredPhaseForSample } from "../../apps/web/src/lib/performance/timeToAnswerPollPhase";
import { armStageFivePublication, startStageFivePublicationController } from "./stageFivePublicationControl.mjs";

const intervalMs = 2_000;
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const stageFiveFixtures = TIME_TO_ANSWER_STAGES.find((stage) => stage.id === "publicationToNodeObservationMs")!.fixtures;

function argumentsByName(argv: string[]): Record<string, string> {
 return Object.fromEntries(argv.flatMap((value, index, all) => value.startsWith("--") ? [[value.slice(2), all[index + 1] ?? ""]] : []));
}

async function fakeDaemon() {
 let revision = "initial";
 const server = createServer((_request, response) => response.end(JSON.stringify({ modelRevision: revision })));
 await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
 return {
 url: `http://127.0.0.1:${(server.address() as any).port}`,
 set: (next: string) => { revision = next; },
 close: () => new Promise<void>((done) => server.close(() => done()))
 };
}

async function measureFixture(fixture: string) {
 const daemon = await fakeDaemon();
 const controller = await startStageFivePublicationController({ upstream: daemon.url });
 const samples: Array<Record<string, unknown>> = [];
 try {
 for (let run = 0; run < TIME_TO_ANSWER_CONTROLLED_RUNS; run += 1) {
 for (let sample = 0; sample < TIME_TO_ANSWER_WARMED_SAMPLES; sample += 1) {
 const previousRevision = run === 0 && sample === 0 ? "initial" : sample === 0 ? `${fixture}-${run - 1}-${TIME_TO_ANSWER_WARMED_SAMPLES - 1}` : `${fixture}-${run}-${sample - 1}`;
 const triggerId = `${fixture}-${run}-${sample}`;
 const requestedPhaseMs = declaredPhaseForSample(run, sample, intervalMs);
 await fetch(`${controller.url}/daemon/health`);
 const publication = await armStageFivePublication({ controllerUrl: controller.url, triggerId, requestedPhaseMs, previousRevision, timeoutMs: intervalMs * 4 });
 const polls: Array<{ at: number; revision: string }> = [];
 const timer = setInterval(async () => {
 const at = performance.now();
 const payload = await (await fetch(`${controller.url}/daemon/health`)).json() as { modelRevision: string };
 polls.push({ at, revision: payload.modelRevision });
 }, intervalMs);
 const revision = `${fixture}-${run}-${sample}`;
 const ack: any = await publication.release(() => daemon.set(revision));
 const deadline = Date.now() + intervalMs * 4;
 while (Date.now() < deadline && !polls.some((poll) => poll.revision === ack.revision)) await sleep(2);
 clearInterval(timer);
 const observed = polls.find((poll) => poll.revision === ack.revision);
 if (!observed || ack.triggerId !== triggerId || ack.revision !== revision) throw new Error(`${fixture} ${triggerId} did not observe the acknowledged publication`);
 const observedPhaseMs = ack.releasedAtMs - ack.pollAtMs;
 if (Math.abs(observedPhaseMs - requestedPhaseMs) > POLL_PHASE_CONTROL_TOLERANCE_MS) throw new Error(`${fixture} ${triggerId} exceeded phase tolerance`);
 samples.push({ run, sample, triggerId, revision, requestedPhaseMs, observedPhaseMs, pollAtMs: ack.pollAtMs, releasedAtMs: ack.releasedAtMs, observedAtMs: observed.at, observedLatencyMs: observed.at - ack.releasedAtMs });
 }
 }
 return samples;
 } finally { await controller.close(); await daemon.close(); }
}

export async function main() {
 const args = argumentsByName(process.argv.slice(2));
 if (!args.output || !args.checkpoint) throw new Error("--output and --checkpoint are required for Stage-5 raw evidence");
 const evidence = await Promise.all(stageFiveFixtures.map(async (fixture) => [fixture, await measureFixture(fixture)] as const));
 writeFileSync(args.output, `${JSON.stringify({ methodologyVersion: TIME_TO_ANSWER_METHODOLOGY, checkpointSha: args.checkpoint, measurementProtocol: "controlled-poll-phase", cells: Object.fromEntries(evidence) }, null, 2)}\n`);
}
if (import.meta.url === new URL(process.argv[1]!, "file:").href) main().catch((error) => { process.stderr.write(`[stage-five] FAIL: ${String(error)}\n`); process.exitCode = 1; });
