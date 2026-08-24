import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { DockerSnapshot, RuntimeMap } from "@dockermap/contracts";
import { AppContext, type AppContextValue } from "../context";
import { getDemoResponse } from "../lib/demoData";
import { buildModel } from "../lib/model";
import Changes from "./Changes";
import Home from "./Home";
import ServiceDetail from "./ServiceDetail";

const runtime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], lastUpdated: 0 };
const liveSnapshot: DockerSnapshot = { containers: [{ id: "live-api", name: "api", image: "nginx:1", status: "running", role: "api", networks: [], ports: [], mounts: [], dependsOn: [] }], images: [], networks: [], volumes: [], lastUpdated: 0 };
function render(mode: AppContextValue["evidenceMode"], snapshot: DockerSnapshot, path: string, screen: ReactElement) {
  const context: AppContextValue = { model: buildModel(snapshot, runtime), loading: false, error: null, health: null, tick: 0, evidenceMode: mode, openCommand: () => {} };
  return renderToStaticMarkup(<AppContext.Provider value={context}><MemoryRouter initialEntries={[path]}><Routes><Route path={path === "/" ? "/" : "/services/:name"} element={screen} /></Routes></MemoryRouter></AppContext.Provider>);
}

describe("update surfaces are unavailable in every mode", () => {
  it.each([["live", liveSnapshot], ["demo", getDemoResponse<DockerSnapshot>("/api/snapshot")]] as const)("renders Home as not collected in %s", (mode, snapshot) => {
    const html = render(mode, snapshot, "/", <Home />);
    expect(html.replace(/<[^>]*>/g, " ")).toContain("Not collected");
    expect(html).toContain("metric-updates");
    expect(html).toContain("Update checks not wired — DockerMap does not query registries");
    expect(html).not.toContain("Updates available");
  });

  it.each([["live", liveSnapshot], ["demo", getDemoResponse<DockerSnapshot>("/api/snapshot")]] as const)("renders detail and changes without update claims in %s", (mode, snapshot) => {
    const detail = render(mode, snapshot, "/services/api", <ServiceDetail />);
    expect(detail).toContain("impact-cell-updates");
    expect(detail).toContain("Not collected");
    expect(detail).toContain("update status");
    const context: AppContextValue = { model: buildModel(snapshot, runtime), loading: false, error: null, health: null, tick: 0, evidenceMode: mode, openCommand: () => {} };
    const changes = renderToStaticMarkup(<AppContext.Provider value={context}><MemoryRouter><Changes /></MemoryRouter></AppContext.Provider>);
    expect(changes).not.toContain(">Updates<");
    expect(changes).not.toContain("image_update");
  });
});
