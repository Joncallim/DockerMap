/**
 * Benchmark-only probe entry (#335).
 *
 * It imports the REAL production modules — `buildModel` from
 * apps/web/src/lib/model.ts and `layoutServices` from apps/web/src/lib/layout.ts
 * — and exposes them for measurement in real Chromium. Nothing is copied or
 * reimplemented here, and this entry is built by a benchmark-only Vite config:
 * the ordinary production build never includes it.
 *
 * The probe itself performs no timing until the capture harness calls
 * `measureModel`, so it cannot benchmark anything by merely being loaded.
 */
import { buildModel } from "../../../apps/web/src/lib/model";
import { layoutServices } from "../../../apps/web/src/lib/layout";

interface ProbeApi {
  measureModel(
    snapshot: unknown,
    runtimeMap: unknown,
    samples: number
  ): Promise<{ buildModelMs: number[]; legacyTopologyLayoutMs: number[] }>;
}

declare global {
  interface Window {
    __dockermapProbe?: ProbeApi;
  }
}

function warmed(samples: number, run: () => void): number[] {
  const measured: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const start = performance.now();
    run();
    measured.push(performance.now() - start);
  }
  return measured;
}

window.__dockermapProbe = {
  async measureModel(snapshot, runtimeMap, samples) {
    const build = () => {
      buildModel(snapshot as never, runtimeMap as never);
    };
    // Warm-ups use the same real functions; only the returned samples are kept,
    // so JIT warm-up does not inflate the recorded numbers.
    warmed(2, build);
    const model = buildModel(snapshot as never, runtimeMap as never);
    const layout = () => {
      layoutServices(model.services, model.relationships, (service, index) => `${service.id}\u0000${index}`);
    };
    warmed(2, layout);
    return {
      buildModelMs: warmed(samples, build),
      legacyTopologyLayoutMs: warmed(samples, layout)
    };
  }
};

document.getElementById("probe-status")!.textContent = "ready";
