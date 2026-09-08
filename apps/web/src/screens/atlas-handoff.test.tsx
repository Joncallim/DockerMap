import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { DockerSnapshot } from "@dockermap/contracts";
import { AppContext, type AppContextValue } from "../context";
import { runtimeFixture } from "../lib/atlas/fixtures";
import { projectRuntimeMap } from "../lib/atlas/project";
import { buildModel } from "../lib/model";
import RuntimeScreen from "./Runtime";
import Home from "./Home";
import Networking from "./Networking";
import ServiceDetail from "./ServiceDetail";

const runtime = runtimeFixture(2, "outbound_star", "network");
const snapshot: DockerSnapshot = {
  containers: [{ id: "docker_container_container_000", name: "container-0", image: "nginx:1", status: "Exited (1)", role: "api", networks: ["network-1"], ports: [], mounts: [], dependsOn: [] }],
  images: [], networks: [{ id: "docker_network_network_001", name: "network-1", driver: "bridge", internal: false, members: ["container-0"] }], volumes: [], lastUpdated: 1, modelRevision: "atlas-handoff-r1"
};

describe("Atlas source-exact cross-screen handoffs", () => {
  it("does not render a handoff in the default-disabled build across every Atlas source surface", () => {
    const atlas = projectRuntimeMap(runtime);
    const value: AppContextValue = {
      model: buildModel(snapshot, runtime), atlas, modelProvenance: "live", loading: false, error: null,
      health: null, tick: 0, evidenceMode: "live", openCommand: () => {}
    };
    const render = (path: string, element: ReactElement) => renderToStaticMarkup(<AppContext.Provider value={value}><MemoryRouter initialEntries={[path]}><Routes><Route path={path} element={element} /></Routes></MemoryRouter></AppContext.Provider>);
    for (const [path, screen] of [["/", <Home />], ["/runtime", <RuntimeScreen />], ["/networking", <Networking />], ["/services/container-0", <ServiceDetail />]] as const) {
      const html = render(path, screen);
      expect(html).not.toContain("Open in Atlas");
      expect(html).not.toContain('href="/atlas');
    }
  });

});
