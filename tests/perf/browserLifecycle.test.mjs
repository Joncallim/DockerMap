import assert from "node:assert/strict";
import test from "node:test";
import { withFreshBrowserRuns } from "./browserLifecycle.mjs";

test("repeated control-shaped runs start with a fresh browser and close it after every run", async () => {
 const browsers = [];
 const rendered = [];
 await withFreshBrowserRuns({
  runs: 21,
  launch: async () => {
   const browser = { pageValue: "0", closed: false, async close() { this.closed = true; } };
   browsers.push(browser);
   return browser;
  },
  run: async (browser, runIndex) => {
   // This is the stale-Home failure shape: a reused page would retain the
   // previous control's value instead of beginning from the fixture baseline.
   assert.equal(browser.pageValue, "0");
   browser.pageValue = String(runIndex + 1);
   rendered.push(browser.pageValue);
  }
 });
 assert.deepEqual(rendered, Array.from({ length: 21 }, (_, index) => String(index + 1)));
 assert.equal(new Set(browsers).size, 21);
 assert.ok(browsers.every((browser) => browser.closed));
});

test("a failed run still closes its browser before the next clean run", async () => {
 const browsers = [];
 await assert.rejects(
  withFreshBrowserRuns({
   runs: 2,
   launch: async () => {
    const browser = { closed: false, async close() { this.closed = true; } };
    browsers.push(browser);
    return browser;
   },
   run: async () => { throw new Error("control failed"); }
  }),
  /control failed/
 );
 assert.equal(browsers.length, 1);
assert.equal(browsers[0].closed, true);
});

test("reports browser closure without changing fresh-browser ownership", async () => {
 const events = [];
 await withFreshBrowserRuns({
 runs: 1,
 launch: async () => ({ async close() {} }),
 run: async () => {},
 lifecycle: (...event) => events.push(event)
 });
 assert.deepEqual(events, [["closure", "browser"]]);
});
