/**
 * Own the browser lifetime for one controlled capture run.
 *
 * A capture run may exercise several fixtures, but it must not inherit browser
 * pages, connections, caches, or renderer state from an earlier run.
 */
export async function withFreshBrowserRuns({ runs, launch, run, lifecycle = (..._args) => {} }) {
 const created = new Set();
 const closed = new Set();
 for (let runIndex = 0; runIndex < runs; runIndex += 1) {
 const browser = await launch();
 const id = `browser-${runIndex}`;
 created.add(id);
 lifecycle("create", "browser", id);
 try {
 await run(browser, runIndex);
 } finally {
 try {
 await browser.close();
 closed.add(id);
 lifecycle("closure", "browser", id);
} catch (error) {
lifecycle("exception", "browser_close", error);
throw error;
 }
 }
 }
 if (created.size !== closed.size || [...created].some((id) => !closed.has(id))) {
 throw new Error(`browser lifecycle leak: created ${created.size}, closed ${closed.size}`);
 }
}
