import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { DockerSnapshot, RuntimeMap } from "@dockermap/contracts";
import { AppContext, type AppContextValue } from "../context";
import { getDemoResponse } from "../lib/demoData";
import { buildModel } from "../lib/model";
import { visibleText } from "../lib/test-utils";
import Changes from "./Changes";
import Home from "./Home";
import ServiceDetail from "./ServiceDetail";

const runtime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], modelRevision: "test-revision", providerStates: [], lastUpdated: 0 };
const liveSnapshot: DockerSnapshot = { containers: [{ id: "live-api", name: "api", image: "nginx:1", status: "running", role: "api", networks: [], ports: [], mounts: [], dependsOn: [] }], images: [], networks: [], volumes: [], modelRevision: "test-revision", lastUpdated: 0 };
function render(mode: AppContextValue["evidenceMode"], snapshot: DockerSnapshot, path: string, screen: ReactElement) {
  const context: AppContextValue = { model: buildModel(snapshot, runtime), modelProvenance: mode === "demo" ? "demo" : mode === "mock" ? "mock" : "live", loading: false, error: null, health: null, tick: 0, evidenceMode: mode, openCommand: () => {} };
  return renderToStaticMarkup(<AppContext.Provider value={context}><MemoryRouter initialEntries={[path]}><Routes><Route path={path === "/" ? "/" : "/services/:name"} element={screen} /></Routes></MemoryRouter></AppContext.Provider>);
}

describe("update surfaces are unavailable in every mode", () => {
  // U17: the pure-mock case (healthMode "mock" + demoMode false resolves to
  // evidenceMode "mock" in resolveEvidenceMode) renders the SAME claim — no
  // mode branch may exist on these surfaces (Q6).
  it.each([["live", liveSnapshot], ["mock", liveSnapshot], ["demo", getDemoResponse<DockerSnapshot>("/api/snapshot")]] as const)("renders Home as not collected in %s", (mode, snapshot) => {
    const html = render(mode, snapshot, "/", <Home />);
    expect(visibleText(html)).toContain("Not collected");
    expect(html).toContain("metric-updates");
    expect(html).toContain("Update checks not wired — DockerMap does not query registries");
    expect(html).not.toContain("Updates available");
    // U5/V3: the Updates metric value must never be a bare count — not "0",
    // not any digit-only string. Scoped to the updates block because Home
    // renders four other numeric metrics (an unscoped scan proves nothing).
    const updatesBlock = html.match(/<div class="metric metric-updates">[\s\S]*?<\/div>/)?.[0] ?? "";
    expect(updatesBlock).toContain("Not collected");
    expect([...updatesBlock.matchAll(/<strong class="metric-value">([^<]*)<\/strong>/g)].every(([, value]) => !/^\d+$/.test(value.trim()))).toBe(true);
  });

  it.each([["live", liveSnapshot], ["mock", liveSnapshot], ["demo", getDemoResponse<DockerSnapshot>("/api/snapshot")]] as const)("renders detail and changes without update claims in %s", (mode, snapshot) => {
    const detail = render(mode, snapshot, "/services/api", <ServiceDetail />);
    expect(detail).toContain("impact-cell-updates");
    expect(detail).toContain("Not collected");
    expect(detail).toContain("update status");
    // U5/V3: the impact band must never carry a synthetic Yes/No availability
    // verdict — only the not-collected label, scoped to the band (the old
    // cell rendered a flat Yes/No verdict here).
    const band = detail.match(/<div class="impact-band wide">([\s\S]*?)<nav class="tabs"/)?.[1] ?? "";
    expect(band).toContain("Not collected");
    expect(band).not.toContain(">Yes<");
    expect(band).not.toContain(">No<");
    const context: AppContextValue = { model: buildModel(snapshot, runtime), modelProvenance: mode === "demo" ? "demo" : mode === "mock" ? "mock" : "live", loading: false, error: null, health: null, tick: 0, evidenceMode: mode, openCommand: () => {} };
    const changes = renderToStaticMarkup(<AppContext.Provider value={context}><MemoryRouter><Changes /></MemoryRouter></AppContext.Provider>);
    expect(changes).not.toContain(">Updates<");
    expect(changes).not.toContain("image_" + "update");
  });
});
