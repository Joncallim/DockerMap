/** The general Baseline-4 capture must never execute or retain delay controls. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("../..", import.meta.url).pathname);

test("normal Stage-6/7 capture and calibration cannot contain injected-delay samples", () => {
 const capture = readFileSync(resolve(root, "tests/perf/capture.ts"), "utf8");
 assert.doesNotMatch(capture, /BenchRenderDelayMs/);
 assert.doesNotMatch(capture, /TIME_TO_ANSWER_INDEPENDENCE_(?:DELAY|SAMPLES)/);
 assert.doesNotMatch(capture, /assertStageSixSevenIndependence/);
 assert.doesNotMatch(capture, /controlStage(?:Six|Seven)Ms/);
});

test("protocol ownership keeps Stage-5 out of normal capture while retaining normal Stage-6/7 rows", () => {
 const contract = readFileSync(resolve(root, "apps/web/src/lib/performance/timeToAnswerEvidence.ts"), "utf8");
 const capture = readFileSync(resolve(root, "tests/perf/capture.ts"), "utf8");
 const assembler = readFileSync(resolve(root, "tests/perf/assembleCompositeEvidence.ts"), "utf8");
 assert.match(contract, /TIME_TO_ANSWER_END_TO_END_MATRIX/);
 assert.match(contract, /TIME_TO_ANSWER_CONTROLLED_POLL_MATRIX/);
 assert.match(contract, /TIME_TO_ANSWER_WARM_UP_METRICS[\s\S]*TIME_TO_ANSWER_END_TO_END_MATRIX/);
 assert.match(capture, /const MATRIX = new Set\(TIME_TO_ANSWER_END_TO_END_MATRIX/);
 assert.match(capture, /const records = TIME_TO_ANSWER_END_TO_END_MATRIX\.map/);
 assert.match(assembler, /general evidence contains a non-end-to-end cell/);
 assert.doesNotMatch(assembler, /const independenceRecords/);
});

test("independence is a dedicated protocol, never a silent capture mode", () => {
 const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
 assert.equal(pkg.scripts["perf:independence"], "tsx tests/perf/captureIndependence.ts");
 const protocol = readFileSync(resolve(root, "tests/perf/captureIndependence.ts"), "utf8");
 assert.doesNotMatch(protocol, /from ["']\.\/capture(?:\.ts)?["']/);
 assert.doesNotMatch(protocol, /perf:time-to-answer/);
 for (const flag of ["metadata", "output", "raw-dir", "checkpoint"]) assert.match(protocol, new RegExp(`--${flag.replace("-", "\\-")}`));
 assert.match(protocol, /armStageFivePublication/);
 assert.match(protocol, /assertStageSixSevenIndependence/);
});
