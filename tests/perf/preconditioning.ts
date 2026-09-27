#!/usr/bin/env node
/** Runnable reduced sustained-preconditioning gate for issue #335. */
import { runSequentialPreconditioning } from "./preconditioningLifecycle.mjs";

export async function main(): Promise<void> {
 const startedAt = performance.now();
 const result = await runSequentialPreconditioning();
 const elapsedMs = performance.now() - startedAt;
 process.stdout.write(
 `[preconditioning] PASS: ${result.runs} sequential fresh-browser runs; ` +
 `${result.fixtures.join(", ")}; generations ${result.generations.join(", ")}; ` +
 `${elapsedMs.toFixed(0)} ms\n`
 );
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
 main().catch((error: unknown) => {
 process.stderr.write(`[preconditioning] FAIL: ${String(error)}\n`);
 process.exitCode = 1;
 });
}
