#!/usr/bin/env node
/** Dedicated controlled Stage-6/7 protocol. It never imports capture.ts. */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
 TIME_TO_ANSWER_CONTROLLED_RUNS, TIME_TO_ANSWER_INDEPENDENCE_DELAY_MS,
 TIME_TO_ANSWER_INDEPENDENCE_SAMPLES, TIME_TO_ANSWER_METHODOLOGY,
 TIME_TO_ANSWER_WARMED_SAMPLES, assertStageSixSevenIndependence, assertTimeToAnswerEnvironment
} from "../../apps/web/src/lib/performance/timeToAnswerEvidence";
import { armStageFivePublication } from "./stageFivePublicationControl.mjs";

const ROOT = new URL("../..", import.meta.url).pathname;
function values(argv: string[]) { return Object.fromEntries(argv.flatMap((value, index, all) => value.startsWith("--") ? [[value.slice(2), all[index + 1] ?? ""]] : [])); }
function git(...args: string[]) { const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" }); if (result.status) throw new Error(result.stderr); return result.stdout.trim(); }
function raw(directory: string, value: unknown) { mkdirSync(directory, { recursive: true }); appendFileSync(join(directory, "stage-six-seven-independence.raw.jsonl"), `${JSON.stringify(value)}\n`); }
/**
 * The runner is injected by Hermes' fixed protocol harness. Keeping it as an
 * explicit dependency prevents a CLI invocation from silently falling back to
 * the ordinary end-to-end capture path. The callback must use the shared
 * arm/release primitive, observe real acceptance, and return identity/audit.
 */
export async function runControlledStageSixSeven(input: {
 fixture: string; control: boolean; delayMs: number;
 armRelease: typeof armStageFivePublication;
 }): Promise<{ stageSixMs: number; stageSevenMs: number; triggerRevision: string; acceptedRevision: string; acceptanceSeam: "observed"; delayAppliedAfterAcceptance: boolean }> {
 void input;
 throw new Error("controlled Stage-6/7 runner is unavailable: invoke through the approved Hermes protocol harness");
}
export async function main() {
 const input = values(process.argv.slice(2));
 if (!input.metadata || !input.output || !input["raw-dir"] || !input.checkpoint) throw new Error("--metadata, --output, --raw-dir and --checkpoint are required");
 const metadata = JSON.parse(readFileSync(input.metadata, "utf8")); assertTimeToAnswerEnvironment(metadata.environment);
 if (git("status", "--porcelain")) throw new Error("refusing independence protocol from a dirty worktree");
 if (git("rev-parse", "HEAD") !== input.checkpoint || metadata.environment.sourceRevision !== input.checkpoint) throw new Error("checkpoint must exactly bind metadata and HEAD");
 if (metadata.environment.methodologyVersion !== TIME_TO_ANSWER_METHODOLOGY) throw new Error("metadata methodology mismatch");
 const fixtures = ["reference-25", "reference-100", "reference-250", "docker-topology-change"];
 const cells: any[] = [];
 try {
   for (const fixture of fixtures) {
     const normal: any[] = []; const control: any[] = [];
     for (let index = 0; index < TIME_TO_ANSWER_CONTROLLED_RUNS * TIME_TO_ANSWER_WARMED_SAMPLES; index += 1) normal.push(await runControlledStageSixSeven({ fixture, control: false, delayMs: 0, armRelease: armStageFivePublication }));
     for (let index = 0; index < TIME_TO_ANSWER_INDEPENDENCE_SAMPLES; index += 1) control.push(await runControlledStageSixSeven({ fixture, control: true, delayMs: TIME_TO_ANSWER_INDEPENDENCE_DELAY_MS, armRelease: armStageFivePublication }));
     for (const sample of control) if (sample.acceptanceSeam !== "observed" || sample.triggerRevision !== sample.acceptedRevision || !sample.delayAppliedAfterAcceptance) throw new Error(`${fixture}: missing acceptance/identity/post-acceptance-delay proof`);
     const verdict = assertStageSixSevenIndependence({ fixture, normalStageSixMs: normal.map((s) => s.stageSixMs), normalStageSevenMs: normal.map((s) => s.stageSevenMs), controlStageSixMs: control.map((s) => s.stageSixMs), controlStageSevenMs: control.map((s) => s.stageSevenMs) });
     cells.push({ fixture, normalStageSixRuns: Array.from({ length: TIME_TO_ANSWER_CONTROLLED_RUNS }, (_, run) => normal.slice(run * TIME_TO_ANSWER_WARMED_SAMPLES, (run + 1) * TIME_TO_ANSWER_WARMED_SAMPLES).map((s) => s.stageSixMs)), normalStageSevenRuns: Array.from({ length: TIME_TO_ANSWER_CONTROLLED_RUNS }, (_, run) => normal.slice(run * TIME_TO_ANSWER_WARMED_SAMPLES, (run + 1) * TIME_TO_ANSWER_WARMED_SAMPLES).map((s) => s.stageSevenMs)), controlEvidence: { delayMs: TIME_TO_ANSWER_INDEPENDENCE_DELAY_MS, acceptanceSeam: "observed", triggerRevision: control[0]?.triggerRevision, acceptedRevision: control[0]?.acceptedRevision, samples: control, verdict } });
   }
   writeFileSync(input.output, `${JSON.stringify({ methodologyVersion: TIME_TO_ANSWER_METHODOLOGY, checkpointSha: input.checkpoint, measurementProtocol: "controlled-stage6-stage7-independence", cells, independenceEvidence: { verdict: "PASS", controlSamplesExcludedFromBaselineTiming: true } }, null, 2)}\n`);
 } catch (error) { raw(input["raw-dir"], { verdict: "FAIL", error: String(error) }); throw error; }
}
if (import.meta.url === new URL(process.argv[1]!, "file:").href) main().catch((error) => { process.stderr.write(`[independence] FAIL: ${String(error)}\n`); process.exitCode = 1; });
