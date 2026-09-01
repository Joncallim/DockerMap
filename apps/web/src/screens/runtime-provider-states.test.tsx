import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { DockerSnapshot, RuntimeMap } from "@dockermap/contracts";
import { AppContext, type AppContextValue } from "../context";
import { buildModel } from "../lib/model";
import RuntimeScreen from "./Runtime";

const snapshot: DockerSnapshot = {
  containers: [], images: [], networks: [], volumes: [], lastUpdated: 1, modelRevision: "test-revision"
};

const runtime: RuntimeMap = {
  nodes: [], edges: [], diagnostics: [], lastUpdated: 1, modelRevision: "test-revision",
  providerStates: [
    { slot: "network_infrastructure", state: "fresh" },
    { slot: "host_scoped", state: "stale" },
    { slot: "python_processes", state: "collecting" },
    { slot: "native_processes", state: "timed_out" },
    { slot: "project_npm", state: "disabled" }
  ]
};

function render(evidenceMode: AppContextValue["evidenceMode"] = "live") {
  const value: AppContextValue = {
    model: buildModel(snapshot, runtime), modelProvenance: evidenceMode === "live" ? "live" : evidenceMode,
    loading: false, error: null, health: null, tick: 0, evidenceMode, openCommand: () => {}
  };
  return renderToStaticMarkup(
    <AppContext.Provider value={value}>
      <MemoryRouter><RuntimeScreen /></MemoryRouter>
    </AppContext.Provider>
  );
}

describe("Runtime collection evidence", () => {
  it("renders all fixed collection slots with their daemon-provided state, separate from service health", () => {
    const html = render();

    expect(html).toContain("Collection evidence");
    expect(html).toContain("Collection state only — it does not describe service health");
    expect(html.match(/class="provider-state-row /g)).toHaveLength(5);
    expect(html).toContain("Network infrastructure");
    expect(html).toContain("Host-scoped services");
    expect(html).toContain("Python processes");
    expect(html).toContain("Native processes");
    expect(html).toContain("Project npm");
    expect(html).toContain("Current");
    expect(html).toContain("Retained observation");
    expect(html).toContain("Collecting");
    expect(html).toContain("Timed out");
    expect(html).toContain("Disabled");
  });

  it("uses a labelled semantic list and does not present sample-mode collection state as host evidence", () => {
    const html = render("mock");

    expect(html).toContain('<ul class="provider-state-list" aria-label="Provider collection evidence">');
    expect(html).toContain("Sample mode: these collection states are not host evidence.");
    expect(html).not.toContain("Demo Mode does not collect host evidence");
  });
});
