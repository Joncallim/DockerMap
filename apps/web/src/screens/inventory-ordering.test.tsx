import { testProviderStates } from "../lib/testProviderStates";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { DockerSnapshot, RuntimeMap } from "@dockermap/contracts";
import { AppContext, type AppContextValue } from "../context";
import { buildModel } from "../lib/model";
import Networking from "./Networking";
import Storage from "./Storage";

const runtime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], modelRevision: "test-revision", providerStates: testProviderStates, lastUpdated: 0 };

const networks = [
  { id: "network_b", name: "beta", driver: "bridge", internal: false, members: [] },
  { id: "network_a", name: "alpha", driver: "bridge", internal: false, members: [] }
];
const volumes = [
  { id: "volume_b", name: "beta", attachedTo: [] },
  { id: "volume_a", name: "alpha", attachedTo: [] }
];

function snapshot(networkRecords = networks, volumeRecords = volumes): DockerSnapshot {
  return { containers: [], images: [], networks: networkRecords, volumes: volumeRecords, modelRevision: "test-revision", lastUpdated: 0 };
}

function renderInventory(path: "/networking" | "/storage", value: AppContextValue): string {
  const screen = path === "/networking" ? <Networking /> : <Storage />;
  return renderToStaticMarkup(
    <AppContext.Provider value={value}>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route path={path} element={screen} /></Routes>
      </MemoryRouter>
    </AppContext.Provider>
  );
}

function contextFor(source: DockerSnapshot): AppContextValue {
  return {
    model: buildModel(source, runtime),
    modelProvenance: "live",
    loading: false,
    error: null,
    health: null,
    tick: 0,
    evidenceMode: "live",
    openCommand: () => {}
  };
}

describe("inventory ordering across equivalent refreshes", () => {
  it("renders Networking and Storage in the same order when Docker input order changes", () => {
    const first = contextFor(snapshot());
    const reordered = contextFor(snapshot([...networks].reverse(), [...volumes].reverse()));

    for (const path of ["/networking", "/storage"] as const) {
      const before = renderInventory(path, first);
      const after = renderInventory(path, reordered);
      expect(after).toBe(before);
    }
  });
});
