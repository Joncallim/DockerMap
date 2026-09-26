#!/usr/bin/env node
/**
 * Methodology drift guard (#335).
 *
 * `tests/perf/emit-metadata.mjs` is plain Node and cannot import the TypeScript
 * contract, so it carries its own copy of the methodology version. A copy that
 * silently diverged would let a capture record one design while validating
 * against another — exactly the class of defect that makes an artifact
 * unreproducible. This test fails when the two disagree.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const REPO_ROOT = resolve(new URL("../..", import.meta.url).pathname);

function read(path) {
  return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

test("the metadata emitter's methodology version matches the contract", () => {
  const contract = read("apps/web/src/lib/performance/timeToAnswerEvidence.ts");
  const emitter = read("tests/perf/emit-metadata.mjs");
  const contractMatch = contract.match(/export const TIME_TO_ANSWER_METHODOLOGY = "([^"]+)"/);
  const emitterMatch = emitter.match(/const METHODOLOGY_VERSION = "([^"]+)"/);
  assert.ok(contractMatch, "the contract must declare TIME_TO_ANSWER_METHODOLOGY");
  assert.ok(emitterMatch, "emit-metadata must declare METHODOLOGY_VERSION");
  assert.equal(emitterMatch[1], contractMatch[1]);
});

test("the warm-up protocol is declared in the contract, not derived at runtime", () => {
const contract = read("apps/web/src/lib/performance/timeToAnswerEvidence.ts");
 assert.match(contract, /export const TIME_TO_ANSWER_CALIBRATION_OBSERVATIONS = 40;/);
assert.match(contract, /export const TIME_TO_ANSWER_WARM_UP_SAFETY_MARGIN = 2;/);
assert.match(contract, /export const TIME_TO_ANSWER_FROZEN_WARM_UP_COUNTS/);
assert.match(contract, /deriveFrozenWarmUpCount/);
  assert.match(contract, /export const TIME_TO_ANSWER_STATIONARITY_MIN_RATIO = [\d.]+;/);
  assert.match(contract, /export const TIME_TO_ANSWER_STATIONARITY_MAX_RATIO = [\d.]+;/);
});

test("calibration is a separate retained collector, never a baseline fallback", () => {
 const capture = read("tests/perf/capture.ts");
 assert.match(capture, /const calibrationOutputPath = args\["calibration-output"\]/);
 assert.match(capture, /const calibration = Boolean\(calibrationOutputPath\)/);
 assert.match(capture, /TIME_TO_ANSWER_CALIBRATION_OBSERVATIONS/);
 assert.match(capture, /TIME_TO_ANSWER_CALIBRATION_REFERENCE_FIXTURES/);
 assert.match(capture, /if \(!calibration\) for \(const stage of TIME_TO_ANSWER_STAGES\)/);
 assert.match(capture, /if \(calibration\) \{[\s\S]*?kind: "dockermap-v1\/time-to-answer-warm-up-calibration-1"/);
 assert.doesNotMatch(capture.match(/if \(calibration\) \{[\s\S]*?const harnessEvidencePath/)?.[0] ?? "", /validateTimeToAnswerEvidence/);
 const probe = read("tests/perf/probe/entry.ts");
 assert.match(probe, /async measureModel\(snapshot, runtimeMap, samples, calibration = false\)/);
 assert.match(probe, /if \(!calibration\) warmed\(2, build\)/);
 assert.match(probe, /if \(!calibration\) warmed\(2, layout\)/);
});

test("a failed stationarity gate retains its complete warmed window before aborting", () => {
 const capture = read("tests/perf/capture.ts");
 const retainedBeforeGate = capture.match(
 /warmUpObservations\[label\] = warmUps;[\s\S]*?warmedObservationWindows\[label\] = benchSamples\[key\]\.slice\(0, requiredForMetric\);[\s\S]*?assertWarmUpStationarity\(\{ label, warmUps, recorded, warmUpCount \}\)/
 );
 assert.ok(retainedBeforeGate, "warm-ups and their complete window must be retained before stationarity can throw");
 assert.match(capture, /warmUpStationarityFailures\[label\] = \{[\s\S]*?fixture: plan\.name,[\s\S]*?stage: key,[\s\S]*?run: runIndex,[\s\S]*?warmUps,[\s\S]*?measuredSamples: recorded,[\s\S]*?calculation: \{[\s\S]*?finalWarmUpMedian:[\s\S]*?measuredMedian:[\s\S]*?ratio: calculation\.ratio,[\s\S]*?bounds:[\s\S]*?reason: String\(error\)/);
 assert.match(capture, /JSON\.stringify\([\s\S]*?warmedObservationWindows,[\s\S]*?warmUpObservations,[\s\S]*?warmUpStationarity,[\s\S]*?warmUpStationarityFailures/);
});

test("stage 5 declares a deterministic phase grid, not a random jitter", () => {
 const pollPhase = read("apps/web/src/lib/performance/timeToAnswerPollPhase.ts");
 assert.match(pollPhase, /export const POLL_PHASE_DIVISIONS = 10;/);
 assert.match(pollPhase, /export const POLL_PHASE_CONTROL_TOLERANCE_MS = 90;/);
 assert.match(pollPhase, /export const POLL_PHASE_MIN_DIRECTION_SHARE = 0\.5;/);
 assert.match(pollPhase, /return sampleIndex % POLL_PHASE_DIVISIONS;/);
  assert.match(pollPhase, /export function pollPhaseGridMs/);
  assert.match(pollPhase, /export function assertPollPhaseSweep/);
  const capture = read("tests/perf/capture.ts");
  // The random-jitter design is gone: no sample may be positioned by Math.random.
  assert.doesNotMatch(capture, /Math\.random\(\) \* pollIntervalMs/);
 assert.match(capture, /observeStageFiveSample/);
 const docs = read("docs/testing/TIME_TO_ANSWER_EVIDENCE.md");
 assert.match(docs, /\*\*10 equal divisions\*\*/);
 assert.match(docs, /\*\*90 ms\s+tolerance\*\*/);
 assert.match(docs, /repeats phases\s+0–4/);
});

test("provider-driven stage-5 cells stay free-running and non-authoritative", () => {
const pollPhase = read("apps/web/src/lib/performance/timeToAnswerPollPhase.ts");
const controlled = pollPhase.match(
/export const POLL_PHASE_CONTROLLED_FIXTURES = \[([\s\S]*?)\] as const;/
);
assert.ok(controlled, "the controlled fixture set must remain an explicit declaration");
for (const fixture of ["provider-only-revision-change", "unavailable-optional-provider"]) {
assert.doesNotMatch(
controlled[1],
new RegExp(`"${fixture}"`),
`${fixture} is structurally phase-pinned and must not enter the controlled sweep`
);
}
const docs = read("docs/testing/TIME_TO_ANSWER_EVIDENCE.md");
assert.match(docs, /## Free-running provider-driven cells/);
assert.match(docs, /real\s+\*\*API-SSE poller path\*\*/);
assert.match(docs, /They are \*\*excluded from the\s+phase-normalized scalar\*\*/);
});
