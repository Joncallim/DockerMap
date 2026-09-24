/**
 * Own the browser lifetime for one controlled capture run.
 *
 * A capture run may exercise several fixtures, but it must not inherit browser
 * pages, connections, caches, or renderer state from an earlier run.
 */
export async function withFreshBrowserRuns({ runs, launch, run, lifecycle = (..._args) => {} }) {
 for (let runIndex = 0; runIndex < runs; runIndex += 1) {
  const browser = await launch();
  try {
   await run(browser, runIndex);
} finally {
try {
await browser.close();
lifecycle("closure", "browser");
} catch (error) {
lifecycle("exception", "browser_close", error);
throw error;
}
}
 }
}
