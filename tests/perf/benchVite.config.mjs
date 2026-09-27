import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

/**
 * BENCHMARK-ONLY Vite config (#335).
 *
 * It builds `tests/perf/probe/` — an entry that imports the real production
 * modules — into `tests/perf/.bench-dist`. It is used exclusively by
 * `npm run perf:time-to-answer`.
 *
 * The ordinary production build (`npm run build --workspace @dockermap/web`)
 * does not read this file and does not include this entry. A hostile regression
 * test asserts that the production artifact contains no probe identifiers.
 */
const probeRoot = fileURLToPath(new URL("./probe", import.meta.url));

export default defineConfig({
  root: probeRoot,
  base: "./",
  build: {
    outDir: fileURLToPath(new URL("./.bench-dist", import.meta.url)),
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      input: fileURLToPath(new URL("./probe/index.html", import.meta.url))
    }
  }
});
