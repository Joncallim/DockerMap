import { testProviderStates } from "../lib/testProviderStates";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockerSnapshot, ObservedChangeHistoryResponse, RuntimeMap } from "@dockermap/contracts";
import { AppContext, type AppContextValue } from "../context";
import { getDemoResponse } from "../lib/demoData";
import { buildModel } from "../lib/model";
import { observedChangeFeed } from "../lib/observedHistory";
import { visibleText } from "../lib/test-utils";
import Changes from "./Changes";
import Home from "./Home";

const revision = "publication-r42";
const runtime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], modelRevision: revision, providerStates: testProviderStates, lastUpdated: 0 };
const snapshot: DockerSnapshot = { containers: [], images: [], networks: [], volumes: [], modelRevision: revision, lastUpdated: 0 };
const coherentHistory: ObservedChangeHistoryResponse = {
  source: "docker",
  baselineEstablished: true,
  currentModelRevision: revision,
  observedRevision: "docker-observation-r17",
  events: [{
    id: "history-2",
    kind: "container_status_changed",
    observedAtMs: 1710000000000,
    containerId: "docker_container_a1b2c3d4",
    previousStatus: "running",
    currentStatus: "stopped"
  }]
};
const inheritedSourceHistory = Object.assign(
  Object.create({ source: "docker" }),
  (({ source: _source, ...rest }) => rest)(coherentHistory)
) as ObservedChangeHistoryResponse;

function render(path: "/" | "/changes", history: ObservedChangeHistoryResponse | null, mode: AppContextValue["evidenceMode"] = "live") {
  const value: AppContextValue = {
    model: buildModel(snapshot, runtime),
    modelProvenance: "live",
    loading: false,
    error: null,
    health: null,
    tick: 0,
    evidenceMode: mode,
    observedHistory: history,
    openCommand: () => {}
  };
  return renderToStaticMarkup(
    <AppContext.Provider value={value}>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route path="/" element={<Home />} /><Route path="/changes" element={<Changes />} /></Routes>
      </MemoryRouter>
    </AppContext.Provider>
  );
}

afterEach(() => vi.restoreAllMocks());

describe("observed inventory history", () => {
  it("keeps Demo Mode's transport response empty and non-Docker", () => {
    const demoHistory = getDemoResponse<ObservedChangeHistoryResponse>("/api/history");
    expect(demoHistory).toEqual({ source: "mock", baselineEstablished: false, currentModelRevision: null, observedRevision: null, events: [] });
    expect(observedChangeFeed(buildModel(snapshot, runtime), "demo", "demo", demoHistory).kind).toBe("unavailable");
  });

  it("renders coherent live Docker observations as non-causal, non-routable rows", () => {
    const changes = render("/changes", coherentHistory);
    const home = render("/", coherentHistory);
    for (const html of [changes, home]) {
      const text = visibleText(html);
      expect(text).toContain("Observed");
      expect(text).toContain("Container status changed in observed inventory");
      expect(text).not.toMatch(/deployed|restarted|recovered|failure/i);
      expect(html).not.toContain("/services/");
    }
    expect(visibleText(changes)).toContain("docker_container_a1b2c3d4");
    expect(visibleText(changes)).toContain("Status: running to stopped.");
    expect(changes).toContain("timeline-row");
    expect(home).toContain("feed-row");
    expect(changes).not.toContain("filter-chip");
    expect(visibleText(home)).toContain("status changed");
    expect(visibleText(home)).toContain("Event causality not reconstructed");
  });

  it.each([
    ["revision mismatch", { ...coherentHistory, currentModelRevision: "other-revision" }, "live"],
    ["non-Docker source", { ...coherentHistory, source: "mock" }, "live"],
    ["inherited Docker source", inheritedSourceHistory, "live"],
    ["mode mismatch", coherentHistory, "mock"]
  ] as const)("fails closed without rows or generated time for %s", (_caseName, history, mode) => {
    const now = vi.spyOn(Date, "now");
    const model = buildModel(snapshot, runtime);
    const result = observedChangeFeed(model, mode, "live", history);
    expect(result.kind).toBe("unavailable");
    expect(now).not.toHaveBeenCalled();

    const html = render("/changes", history, mode);
    expect(visibleText(html)).toContain("Not collected");
    expect(html).not.toContain("timeline-row");
    expect(html).not.toContain("filter-chip");
    expect(visibleText(html)).not.toMatch(/\d+[smhd] ago/);
    expect(now).not.toHaveBeenCalled();
  });
});
