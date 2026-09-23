import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  /**
   * The benchmark instrumentation seam (#335) is compile-time gated. The
   * production build defines the flag `false`, so the acceptance hook, its event
   * identifiers, the probe entry and the artificial render-delay machinery are
   * all removed by dead-code elimination before minification. Flipping this value
   * here is exactly what must never happen: tests/perf/productionIsolation.test.mjs
   * reads this file and requires the production definition to be `false`, and
   * inspects the built artifact for the seam's identifiers.
   */
  define: { __DOCKERMAP_BENCH_ACCEPTANCE__: "false" },
  server: {
    port: 3233
  }
});
