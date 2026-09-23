/** Regression coverage for the stage-7 control-trigger ordering (#335). */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

const probe = readFileSync(resolve(new URL(".", import.meta.url).pathname, "browserProbe.js"), "utf8");

function installProbe() {
  let clock = 0;
  const window = {
    fetch() {},
    EventSource: function EventSource() {},
    requestAnimationFrame: (done) => setImmediate(() => done()),
    performance: { now: () => ++clock }
  };
  window.EventSource.prototype = { addEventListener() {} };
  const document = {
    documentElement: { dataset: {}, querySelectorAll: () => [] },
    querySelectorAll: () => [],
    addEventListener() {}
  };
  const context = {
    window,
    document,
    performance: window.performance,
    requestAnimationFrame: window.requestAnimationFrame,
    MutationObserver: class { observe() {} },
    Element: class {},
    URL,
    location: { href: "http://probe.test/" },
    setImmediate,
    Promise,
    String,
    Number,
    Boolean,
    Array,
    JSON,
    Object,
    RegExp
  };
  vm.runInNewContext(probe, context);
  window.__dockermapBenchAcceptanceSink = [];
  return window;
}

test("stage-7 control ignores a revision accepted between arm and trigger", async () => {
  const window = installProbe();
  const helpers = window.__dockermapBenchHelpers;
  helpers.armModelAcceptance({
    mode: "content",
    previousSeq: 0,
    limit: 1_000,
    expectedMetricValue: "16",
    awaitPublicationTrigger: true
  });
  // This is the race from the aborted capture: background polling accepts a
  // revision after arming but before the fixture POST. It must not satisfy the
  // control sample.
  window.__dockermapBenchAcceptanceSink.push({ seq: 1, at: 10, revision: "background" });
  helpers.markModelPublicationTriggered();
  window.__dockermapBench.notifyLog.push({ at: 11, revision: "triggered" });
  window.__dockermapBench.fetchLog.push({ url: "snapshot", startedAt: 12, at: 13, revision: "triggered" });
  window.__dockermapBenchAcceptanceSink.push({ seq: 2, at: 14, revision: "triggered" });
  // This is the stage-7 proof: the selected acceptance must pair with Home
  // content carrying the same accepted revision and the triggered metric.
  window.__dockermapBench.commits.push({
    at: 15,
    inHome: true,
    inStory: true,
    textChanged: true,
    revision: "triggered",
    storyValue: "16"
  });
  const measured = await helpers.awaitModelAcceptance();
  assert.equal(measured.acceptedRevision, "triggered");
  assert.equal(measured.acceptedSequence, 2);
  assert.equal(measured.triggerAcceptedSequence, 1);
});
