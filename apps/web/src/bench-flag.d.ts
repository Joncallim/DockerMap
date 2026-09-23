/**
 * Compile-time flag for the benchmark-only instrumentation seam (#335).
 *
 * The ordinary production build defines it `false` (apps/web/vite.config.ts), so
 * every benchmark branch is removed by dead-code elimination before
 * minification. The benchmark-mode application build in `tests/perf` defines it
 * `true`.
 *
 * It is declared here so BOTH builds typecheck against the same product source:
 * the seam lives in real application code, never in a copied implementation.
 */
declare const __DOCKERMAP_BENCH_ACCEPTANCE__: boolean;
