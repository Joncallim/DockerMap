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
