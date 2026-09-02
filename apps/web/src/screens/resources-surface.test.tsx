import { testProviderStates } from "../lib/testProviderStates";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { DockerSnapshot, ObservedResourceTelemetryResponse, RuntimeMap } from "@dockermap/contracts";
import { AppContext, type AppContextValue } from "../context";
import { buildModel } from "../lib/model";
import { RESOURCE_CLAIM_MATRIX, visibleText } from "../lib/test-utils";
import Home from "./Home";
import ServiceDetail from "./ServiceDetail";

const runtime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], modelRevision: "test-revision", providerStates: testProviderStates, lastUpdated: 0 };
const running: DockerSnapshot = { containers: [{ id: "api", name: "api", image: "nginx", status: "running", role: "api", networks: [], ports: [], mounts: [], dependsOn: [] }], images: [], networks: [], volumes: [], modelRevision: "test-revision", lastUpdated: 0 };
const offline: DockerSnapshot = { ...running, containers: [{ ...running.containers[0], status: "Exited (1)" }] };
function render(snapshot: DockerSnapshot, mode: AppContextValue["evidenceMode"], provenance: AppContextValue["modelProvenance"], path: "/" | "/services/api", screen: ReactElement, resourceTelemetry?: ObservedResourceTelemetryResponse | null) {
  const value: AppContextValue = { model: buildModel(snapshot, runtime), modelProvenance: provenance, loading: false, error: null, health: null, tick: 0, evidenceMode: mode, resourceTelemetry, openCommand: () => {} };
  return renderToStaticMarkup(<AppContext.Provider value={value}><MemoryRouter initialEntries={[path]}><Routes><Route path="/" element={screen} /><Route path="/services/:name" element={screen} /></Routes></MemoryRouter></AppContext.Provider>);
}
function homeRegion(html: string) { return html.match(/<span class="svc-res">[\s\S]*?<\/span><\/li>/)?.[0] ?? ""; }

describe("resource surfaces follow the 16-pair source policy", () => {
  it.each(RESOURCE_CLAIM_MATRIX)("renders %s/%s as %s", (mode, provenance, expected) => {
    const home = homeRegion(render(offline, mode, provenance, "/", <Home />));
    const detail = render(running, mode, provenance, "/services/api", <ServiceDetail defaultTab="resources" />);
    const panel = detail.match(/<section class="panel panel-resources">[\s\S]*?<\/section>/)?.[0] ?? "";
    expect(panel).not.toBe("");
    if (expected === "unavailable") {
      expect(visibleText(home).trim()).toBe("CPU not collected");
      expect(home).not.toMatch(/bar|\d|%|Resource collectors/);
      expect(visibleText(panel)).toContain("Not collected");
      expect(visibleText(panel)).toContain(
        mode === "live" && provenance === "live"
          ? "Current Docker resource telemetry is not available for this model."
          : "Resource collectors not wired — DockerMap does not measure container CPU, memory or network"
      );
      expect(panel).not.toMatch(/res-grid|res-cell|metric|bar|spark|%|MB|KB/);
    } else {
      expect(home).toContain("bar");
      expect(visibleText(home)).toContain("Sample data");
      expect(home).toMatch(/aria-label="CPU \d+% — Sample data"/);
      expect(panel).toContain("Sample data");
      expect((panel.match(/res-cell/g) ?? [])).toHaveLength(3);
      expect(panel).toContain("spark");
      expect(panel).toMatch(/aria-label="Memory \d+% — Sample data"/);
    }
  });

  it("keeps offline demo zero visibly tagged and Resources inactive by default", () => {
    const home = homeRegion(render(offline, "demo", "demo", "/", <Home />));
    expect(visibleText(home)).toContain("Sample data");
    expect(home).toContain('aria-label="CPU 0% — Sample data"');
    expect(render(offline, "demo", "demo", "/services/api", <ServiceDetail />)).not.toContain("panel-resources");
  });

  it("shows fresh Docker telemetry without a history/sparkline and hides opaque identity", () => {
    const now = Date.now();
    const telemetry: ObservedResourceTelemetryResponse = {
      source: "docker", collectionState: "fresh", currentModelRevision: "test-revision", currentObservationRevision: "observation-r7",
      samples: [{
        containerId: "api",
        cpuPercent: { value: 40, observedAtMs: now - 1, expiresAtMs: now + 30_000 },
        memoryUsedBytes: { value: 128 * 1024 * 1024, observedAtMs: now - 1, expiresAtMs: now + 30_000 },
        memoryLimitBytes: { value: 512 * 1024 * 1024, observedAtMs: now - 1, expiresAtMs: now + 30_000 },
        networkRxBytesPerSecond: { value: 500, observedAtMs: now - 1, expiresAtMs: now + 30_000 },
        networkTxBytesPerSecond: { value: 750, observedAtMs: now - 1, expiresAtMs: now + 30_000 }
      }]
    };
    const home = homeRegion(render(offline, "live", "live", "/", <Home />, telemetry));
    const detail = render(running, "live", "live", "/services/api", <ServiceDetail defaultTab="resources" />, telemetry);
    expect(visibleText(home)).toContain("Observed");
    expect(home).toContain('aria-label="CPU 40% — Observed, current"');
    expect(visibleText(detail)).toContain("Observed — current");
    expect(visibleText(detail)).toContain("128 MB");
    expect(detail).not.toContain("spark");
    expect(detail).not.toContain("observation-r7");
    expect(detail).not.toContain("containerId");
  });

  it("does not render live values when the telemetry is stale", () => {
    const stale: ObservedResourceTelemetryResponse = { source: "docker", collectionState: "stale", currentModelRevision: "test-revision", currentObservationRevision: "observation-r7", samples: [] };
    const home = homeRegion(render(offline, "live", "live", "/", <Home />, stale));
    const detail = render(running, "live", "live", "/services/api", <ServiceDetail defaultTab="resources" />, stale);
    expect(visibleText(home)).toContain("CPU telemetry stale");
    expect(visibleText(detail)).toContain("Telemetry stale");
    expect(visibleText(detail)).toContain("stale");
    expect(detail).not.toMatch(/res-grid|res-cell|bar|spark|%|MB|KB/);
  });
});
