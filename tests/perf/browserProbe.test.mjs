/** Regression coverage for the Stage-6/7 seam-isolation boundary (#335). */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

const probe = readFileSync(resolve(new URL(".", import.meta.url).pathname, "browserProbe.js"), "utf8");

function installProbe() {
let clock = 0;
const window = { fetch() {}, EventSource: function EventSource() {}, requestAnimationFrame: (done) => setImmediate(() => done()), performance: { now: () => ++clock } };
window.EventSource.prototype = { addEventListener() {} };
const document = { documentElement: { dataset: {}, querySelectorAll: () => [] }, querySelectorAll: () => [], addEventListener() {} };
const context = { window, document, performance: window.performance, requestAnimationFrame: window.requestAnimationFrame, MutationObserver: class { observe() {} }, Element: class {}, URL, location: { href: "http://probe.test/" }, setImmediate, Promise, String, Number, Boolean, Array, JSON, Object, RegExp };
vm.runInNewContext(probe, context);
window.__dockermapBenchAcceptanceSink = [];
return window;
}

test("seam isolation selects the first coherent post-boundary pair without publication identity or content matching", async () => {
const window = installProbe();
const helpers = window.__dockermapBenchHelpers;
helpers.armModelAcceptance({ mode: "content", seamIsolation: true, previousSeq: 0, limit: 1_000, metricLabel: "Offline" });
helpers.armSeamIsolationDelay(250);
assert.equal(window.__dockermapBenchDelayAfterNextAcceptance, true);
window.__dockermapBench.notifyLog.push({ at: 1, revision: "unrelated" });
window.__dockermapBench.fetchLog.push({ url: "snapshot", startedAt: 2, at: 3, revision: "unrelated" });
window.__dockermapBenchAcceptanceSink.push({ seq: 1, at: 4, revision: "unrelated", snapshotRevision: "unrelated", runtimeMapRevision: "unrelated" });
window.__dockermapBench.commits.push({ at: 5, inHome: true, inStory: true, textChanged: true, revision: "unrelated", storyValue: "not-a-fixture-sentinel" });
const measured = await helpers.awaitModelAcceptance();
assert.equal(measured.acceptedRevision, "unrelated");
assert.equal(measured.acceptedSequence, 1);
assert.equal(measured.triggerRevision, "");
});

test("the probe source keeps normal trigger identity separate from seam isolation", () => {
assert.match(probe, /armSeamIsolationDelay/);
assert.match(probe, /arm\.seamIsolation \|\| entry\.storyValue === arm\.expectedMetricValue/);
});
