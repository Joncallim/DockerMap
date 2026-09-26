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

test("the protocol self-orchestrates its private fixture, daemon, API, browser and teardown", () => {
 const protocol = readFileSync(resolve(root, "tests/perf/captureIndependence.ts"), "utf8");
 for (const primitive of ["fake-docker-api.mjs", "startStageFivePublicationController", "apps/api/src/index.ts", "chromium.launch", "startStaticServer", "finally", "rmSync(work"]) assert.match(protocol, new RegExp(primitive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
 assert.match(protocol, /controlled-stage6-stage7-independence/);
 assert.doesNotMatch(protocol, /Hermes protocol harness/);
});

test("the controlled release binds exact acknowledgement to browser acceptance", () => {
 const protocol = readFileSync(resolve(root, "tests/perf/captureIndependence.ts"), "utf8");
 for (const primitive of ["armStageFivePublication", "markModelPublicationTriggered", "setExpectedModelRevision", "awaitModelAcceptance", "ack.triggerId !== triggerId", "measured.acceptedRevision !== ack.revision"]) assert.match(protocol, new RegExp(primitive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("only controls carry exactly the fixed post-acceptance delay", () => {
 const protocol = readFileSync(resolve(root, "tests/perf/captureIndependence.ts"), "utf8");
 assert.match(protocol, /!input\.control && input\.delayMs !== 0/);
 assert.match(protocol, /input\.control && input\.delayMs !== TIME_TO_ANSWER_INDEPENDENCE_DELAY_MS/);
 assert.match(protocol, /delayAppliedAfterAcceptance/);
});

test("success is withheld until every fixture verdict and daemon provenance check pass", () => {
 const protocol = readFileSync(resolve(root, "tests/perf/captureIndependence.ts"), "utf8");
 assert.match(protocol, /assertDaemonBinaryProvenance[\s\S]*before independence capture/);
 assert.match(protocol, /after independence capture/);
 assert.ok(protocol.indexOf("writeFileSync(input.output") > protocol.indexOf("assertStageSixSevenIndependence"));
});

test("failed controlled samples retain dedicated raw evidence without contaminating baseline capture", () => {
 const protocol = readFileSync(resolve(root, "tests/perf/captureIndependence.ts"), "utf8");
 assert.match(protocol, /controlled-stage6-stage7-independence/);
 assert.match(protocol, /verdict: "FAIL"/);
 assert.doesNotMatch(protocol, /from ["']\.\/capture(?:\.ts)?["']/);
});

test("the independence runner fails closed without all trusted invocation bindings", () => {
 const protocol = readFileSync(resolve(root, "tests/perf/captureIndependence.ts"), "utf8");
 assert.match(protocol, /--metadata, --output, --raw-dir and --checkpoint are required/);
 assert.match(protocol, /refusing independence protocol from a dirty worktree/);
 assert.match(protocol, /checkpoint must exactly bind metadata, harness and HEAD/);
});
