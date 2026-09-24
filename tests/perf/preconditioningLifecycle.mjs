/**
 * Reduced, deterministic longevity control for the benchmark harness. It does
 * not capture performance evidence; it exercises the ownership boundaries that
 * must survive the long controlled matrix.
 */
import { withFreshBrowserRuns } from "./browserLifecycle.mjs";

export const PRECONDITIONING_RUNS = 12;
export const PRECONDITIONING_FIXTURES = ["reference-25", "reference-100"];
export const PRECONDITIONING_GENERATIONS = [16, 17, 18];

export function assertBalancedLifecycle(events) {
 const created = new Set();
 const tornDown = new Set();
 for (const event of events) {
 if (event.event === "create") created.add(event.id);
 if (event.event === "teardown") tornDown.add(event.id);
 }
 if (created.size !== tornDown.size || [...created].some((id) => !tornDown.has(id))) {
 throw new Error(`preconditioning lifecycle leak: created ${created.size}, torn down ${tornDown.size}`);
 }
}

export async function runSequentialPreconditioning({
 runs = PRECONDITIONING_RUNS,
 createReader = async () => ({ async cancel() {} })
} = {}) {
 const events = [];
 let readerSequence = 0;
 await withFreshBrowserRuns({
 runs,
 launch: async () => ({ async close() {} }),
 lifecycle: (event, _kind, id) => {
 if (event === "create") events.push({ event: "create", id });
 if (event === "closure") events.push({ event: "teardown", id });
 },
 run: async (_browser, run) => {
 for (const fixture of PRECONDITIONING_FIXTURES) {
 for (const generation of PRECONDITIONING_GENERATIONS) {
 const id = `reader-${readerSequence++}`;
 events.push({ event: "create", id, fixture, run, generation });
 const reader = await createReader({ fixture, run, generation, id });
 try {
 // A stage-5 observation has no useful result until its stream is closed.
 await Promise.resolve();
 } finally {
 await reader.cancel();
 events.push({ event: "teardown", id, fixture, run, generation });
 }
 }
 }
 }
 });
 assertBalancedLifecycle(events);
 return { runs, fixtures: PRECONDITIONING_FIXTURES, generations: PRECONDITIONING_GENERATIONS, events };
}
