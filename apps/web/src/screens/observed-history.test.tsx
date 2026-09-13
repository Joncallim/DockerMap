import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { DockerSnapshot, ObservedChangeHistoryResponse, RuntimeMap } from "@dockermap/contracts";
import { AppContext, type AppContextValue } from "../context";
import { buildModel } from "../lib/model";
import { coherentObservedHistory, observedChangeFeed } from "../lib/observedHistory";
import { testProviderStates } from "../lib/testProviderStates";
import { visibleText } from "../lib/test-utils";
import Changes from "./Changes";
import Home from "./Home";

const revision = "publication-r42";
const snapshot: DockerSnapshot = { containers: [], images: [], networks: [], volumes: [], modelRevision: revision, lastUpdated: 0 };
const runtime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], modelRevision: revision, providerStates: testProviderStates, lastUpdated: 0 };
const model = buildModel(snapshot, runtime);
const history: ObservedChangeHistoryResponse = {
  source: "docker",
  baselineEstablished: true,
  currentModelRevision: revision,
  observedRevision: "observation-r8",
  events: [{
    id: "0123456789abcdef0123456789abcdef-1",
    kind: "container_status_changed",
    observedAtMs: 1_710_000_000_000,
    containerId: `docker_container_${"a".repeat(64)}`,
    previousStatus: "running",
    currentStatus: "stopped"
  }]
};

function render(path: "/" | "/changes", observedHistory: ObservedChangeHistoryResponse | null, overrides: Partial<AppContextValue> = {}) {
  const value: AppContextValue = {
    model, modelProvenance: "live", loading: false, error: null, health: null,
    tick: 0, evidenceMode: "live", observedHistory, openCommand: () => {}, ...overrides
  };
  return renderToStaticMarkup(<AppContext.Provider value={value}><MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/" element={<Home />} /><Route path="/changes" element={<Changes />} />
  </Routes></MemoryRouter></AppContext.Provider>);
}

describe("observed inventory history", () => {
  it("renders coherent rows as identity-free, non-causal, non-routable observations", () => {
    for (const path of ["/", "/changes"] as const) {
      const html = render(path, history);
      const text = visibleText(html);
      expect(text).toContain("Observation");
      expect(text).toContain("A container observation changed status");
      expect(text).not.toContain("docker_container_");
      expect(text).not.toMatch(/deployed|restarted|failure|cause/i);
      expect(html).not.toContain("/services/");
    }
    const changes = render("/changes", history);
    expect(visibleText(changes)).toContain("Inventory observations");
    expect(changes).not.toContain("filter-chip");
  });

  it("uses an observed empty state after a coherent baseline", () => {
    const html = render("/changes", { ...history, events: [] });
    expect(visibleText(html)).toContain("No retained observations");
    expect(visibleText(html)).toContain("daemon");
    expect(visibleText(html)).not.toContain("No sample change");
  });

  it.each<[string, ObservedChangeHistoryResponse, Partial<AppContextValue>]>([
    ["mock source", { ...history, source: "mock" }, {}],
    ["no baseline", { ...history, baselineEstablished: false }, {}],
    ["model mismatch", { ...history, currentModelRevision: "other" }, {}],
    ["empty observation revision", { ...history, observedRevision: "" }, {}],
    ["mock provenance", history, { modelProvenance: "mock" }],
    ["mock mode", history, { evidenceMode: "mock" }]
  ])("fails closed for %s", (_name, candidate, overrides) => {
    const now = vi.spyOn(Date, "now");
    expect(observedChangeFeed(model, overrides.evidenceMode ?? "live", overrides.modelProvenance ?? "live", candidate).kind).toBe("unavailable");
    const html = render("/changes", candidate, overrides);
    expect(visibleText(html)).toContain("Not collected");
    expect(html).not.toContain("timeline-row");
    expect(now).not.toHaveBeenCalled();
    now.mockRestore();
  });

  it("requires source and baseline to be own properties", () => {
    const inherited = Object.assign(Object.create({ source: "docker", baselineEstablished: true }), {
      currentModelRevision: revision, observedRevision: "obs", events: []
    }) as ObservedChangeHistoryResponse;
    expect(coherentObservedHistory(model, "live", "live", inherited)).toBeNull();
  });

  it.each([
    ["unknown kind", { ...history.events[0], kind: "container_restarted" }],
    ["invalid identity", { ...history.events[0], containerId: "raw-container-name" }],
    ["invalid timestamp", { ...history.events[0], observedAtMs: Number.NaN }],
    ["incoherent status transition", { ...history.events[0], currentStatus: "running" }],
    ["missing required status", (() => { const { currentStatus: _, ...event } = history.events[0]; return event; })()],
    ["unknown field", { ...history.events[0], providerPayload: "secret" }]
  ])("fails closed for malformed event shape: %s", (_name, event) => {
    const malformed = { ...history, events: [event] } as ObservedChangeHistoryResponse;
    expect(coherentObservedHistory(model, "live", "live", malformed)).toBeNull();
    expect(visibleText(render("/changes", malformed))).toContain("Not collected");
  });
});
