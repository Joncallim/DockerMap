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
 , calibration?: boolean): Promise<{ buildModelMs: number[]; legacyTopologyLayoutMs: number[] }>;
}

declare global {
  interface Window {
    __dockermapProbe?: ProbeApi;
  }
}

 function timed(samples: number, run: () => void): number[] {
  const measured: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const start = performance.now();
    run();
    measured.push(performance.now() - start);
  }
  return measured;
}

window.__dockermapProbe = {
 async measureModel(snapshot, runtimeMap, samples, calibration = false) {
    const build = () => {
      buildModel(snapshot as never, runtimeMap as never);
    };
 const model = buildModel(snapshot as never, runtimeMap as never);
    const layout = () => {
      layoutServices(model.services, model.relationships, (service, index) => `${service.id}\u0000${index}`);
    };
 // Ordinary capture returns all 75 ordered calls so the harness can retain its
 // 60-call burn-in and publish only calls 61-75. Calibration remains a
 // separately requested 60-observation diagnostic series.
 const count = calibration ? samples : samples + 60;
 return {
 buildModelMs: timed(count, build),
 legacyTopologyLayoutMs: timed(count, layout)
 };
  }
};

document.getElementById("probe-status")!.textContent = "ready";
