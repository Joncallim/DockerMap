import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("../..", import.meta.url).pathname);
const read = (path) => readFileSync(resolve(root, path), "utf8");

test("metadata and contract pin the same methodology", () => {
 const contract = read("apps/web/src/lib/performance/timeToAnswerEvidence.ts");
 const emitter = read("tests/perf/emit-metadata.mjs");
 const version = contract.match(/TIME_TO_ANSWER_METHODOLOGY = "([^"]+)"/)?.[1];
 assert.equal(emitter.match(/METHODOLOGY_VERSION = "([^"]+)"/)?.[1], version);
});

test("ordinary end-to-end capture uses fixed 60 plus 15 without calibration authority", () => {
 const contract = read("apps/web/src/lib/performance/timeToAnswerEvidence.ts");
 const capture = read("tests/perf/capture.ts");
 assert.match(contract, /TIME_TO_ANSWER_END_TO_END_BURN_IN_OBSERVATIONS = 60/);
 assert.doesNotMatch(contract, /TIME_TO_ANSWER_FROZEN_WARM_UP_COUNTS/);
 assert.doesNotMatch(capture, /frozenWarmUpCount|assertWarmUpStationarity/);
 assert.match(capture, /splitWarmedObservations\(values, samples\)/);
 assert.match(capture, /TIME_TO_ANSWER_END_TO_END_BURN_IN_OBSERVATIONS \+ samples/);
 assert.match(capture, /burnInObservations\[label\] = burnIns/);
});

test("calibration remains persisted historical diagnostic evidence", () => {
 const capture = read("tests/perf/capture.ts");
 assert.match(capture, /kind: "dockermap-v1\/time-to-answer-warm-up-calibration-1"/);
 assert.match(capture, /Calibration is retained historical diagnostic evidence only/);
 assert.doesNotMatch(capture, /derivationReport\.verdict === "CONFLICT"\) throw/);
});

test("controlled protocols remain separate from normal end-to-end timing", () => {
 const capture = read("tests/perf/capture.ts");
 const assembler = read("tests/perf/assembleCompositeEvidence.ts");
 assert.match(capture, /TIME_TO_ANSWER_END_TO_END_MATRIX/);
 assert.match(assembler, /controlled-poll-phase/);
 assert.match(assembler, /controlled-stage6-stage7-independence/);
});
