/** The seam-isolation control is supporting evidence, isolated from Baseline-4. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("../..", import.meta.url).pathname);
const read = (path) => readFileSync(resolve(root, path), "utf8");

test("normal Stage-6/7 capture and calibration cannot contain injected-delay samples", () => {
const capture = read("tests/perf/capture.ts");
assert.doesNotMatch(capture, /BenchRenderDelayMs/);
assert.doesNotMatch(capture, /TIME_TO_ANSWER_INDEPENDENCE_(?:DELAY|SAMPLES)/);
assert.doesNotMatch(capture, /assertStageSixSevenIndependence/);
assert.doesNotMatch(capture, /controlStage(?:Six|Seven)Ms/);
});

test("seam isolation is a dedicated supporting protocol, never a silent capture mode", () => {
const pkg = JSON.parse(read("package.json"));
const protocol = read("tests/perf/captureIndependence.ts");
assert.equal(pkg.scripts["perf:independence"], "tsx tests/perf/captureIndependence.ts");
assert.match(protocol, /controlled-stage6-stage7-seam-isolation/);
assert.doesNotMatch(protocol, /from ["']\.\/capture(?:\.ts)?["']/);
assert.match(protocol, /armSeamIsolationDelay/);
assert.match(protocol, /assertStageSixSevenIndependence/);
});

test("the private seam control retains real acceptance, coherence, post-acceptance delay and isolation", () => {
const protocol = read("tests/perf/captureIndependence.ts");
for (const primitive of ["fake-docker-api.mjs", "apps/api/src/index.ts", "chromium.launch", "startStaticServer", "finally", "rmSync(work", "acceptedRevision !== measured.snapshotRevision", "delayStartedAfterAcceptance"]) assert.match(protocol, new RegExp(primitive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.doesNotMatch(protocol, /startStageFivePublicationController/);
assert.doesNotMatch(protocol, /armStageFivePublication/);
assert.doesNotMatch(protocol, /setExpectedModelRevision/);
assert.doesNotMatch(protocol, /triggerRevision/);
});

test("composite rejects publication-attribution-shaped control artifacts", () => {
const assembler = read("tests/perf/assembleCompositeEvidence.ts");
assert.match(assembler, /controlled-stage6-stage7-seam-isolation/);
assert.match(assembler, /publication-level causal identity unavailable/);
assert.match(assembler, /validatesDaemonToBrowserAttribution !== false/);
assert.match(assembler, /"triggerRevision" in sample/);
assert.match(read("tests/perf/captureIndependence.ts"), /controlSamplesExcludedFromBaselineTiming/);
});

test("seam isolation is supporting evidence rather than a Baseline-4 prerequisite", () => {
const assembler = read("tests/perf/assembleCompositeEvidence.ts");
assert.match(assembler, /stageSixSeven === null\) return validateTimeToAnswerEvidence/);
assert.match(assembler, /supporting-evidence\.json/);
});
