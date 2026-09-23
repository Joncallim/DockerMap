import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * BENCHMARK-MODE APPLICATION build (#335).
 *
 * It builds the REAL production application (`apps/web`) with the
 * benchmark-only acceptance seam compiled IN:
 *
 *   __DOCKERMAP_BENCH_ACCEPTANCE__ = "true"
 *
 * That is the only difference from the shipped build. The application source is
 * not copied, forked or reimplemented — the seam is the same code the product
 * build compiles out (`apps/web/src/lib/performance/modelAcceptance.tsx`), and
 * the capture uses this build only for the browser stages that need to observe
 * coherent-model acceptance (stages 6 and 7) and their independence control.
 * Every other browser stage (production bundle/startup, Cmd-K) is measured on
 * the ordinary production build (`apps/web/dist`) served alongside it.
 *
 * It is read exclusively by `npm run perf:time-to-answer`; no production build
 * path references this file.
 */
const appRoot = fileURLToPath(new URL("../../apps/web", import.meta.url));

export default defineConfig({
  root: appRoot,
  base: "./",
  plugins: [react()],
  define: { __DOCKERMAP_BENCH_ACCEPTANCE__: "true" },
  build: {
    outDir: fileURLToPath(new URL("./.bench-app-dist", import.meta.url)),
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false
  }
});
