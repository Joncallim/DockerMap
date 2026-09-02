import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { DockerSnapshot, ObservedDockerEventHistoryResponse, RuntimeMap } from "@dockermap/contracts";
import { AppContext, type AppContextValue } from "../context";
import { getDemoResponse } from "../lib/demoData";
import type { EvidenceMode, ModelProvenance } from "../lib/evidence";
import { buildModel } from "../lib/model";
import { coherentObservedDockerEvents } from "../lib/observedDockerEvents";
import { visibleText } from "../lib/test-utils";
import { testProviderStates } from "../lib/testProviderStates";
import Changes from "./Changes";

const revision = "publication-r42";
const runtime: RuntimeMap = {
  nodes: [], edges: [], diagnostics: [], modelRevision: revision, providerStates: testProviderStates, lastUpdated: 0
};
const snapshot: DockerSnapshot = {
  containers: [], images: [], networks: [], volumes: [], modelRevision: revision, lastUpdated: 0
};
const eventId = "docker_event_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const containerId = "docker_container_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const coherentHistory: ObservedDockerEventHistoryResponse = {
  source: "docker",
  collectionState: "reconnecting",
  currentModelRevision: revision,
  currentObservationRevision: "observation-r42",
  events: [{
    id: eventId,
    kind: "container_created",
    evidenceSource: "docker_event_stream",
    observedAtMs: 1_710_000_001_000,
    sourceOccurredAtMs: 1_710_000_000_000,
    containerId,
    anchorModelRevision: revision,
    anchorObservationRevision: "observation-r42"
  }]
};

function render(
  history: ObservedDockerEventHistoryResponse | null,
  mode: EvidenceMode | null = "live",
  modelProvenance: ModelProvenance | null = "live"
) {
  const value: AppContextValue = {
    model: buildModel(snapshot, runtime),
    modelProvenance,
    loading: false,
    error: null,
    health: null,
    tick: 0,
    evidenceMode: mode,
    observedDockerEvents: history,
    openCommand: () => {}
  };
  return renderToStaticMarkup(
    <AppContext.Provider value={value}>
      <MemoryRouter initialEntries={["/changes"]}>
        <Routes><Route path="/changes" element={<Changes />} /></Routes>
      </MemoryRouter>
    </AppContext.Provider>
  );
}

describe("Docker event observations", () => {
  it("keeps Demo Mode's stream transport explicitly unavailable and empty", () => {
    const demo = getDemoResponse<ObservedDockerEventHistoryResponse>("/api/observed-events");
    expect(demo).toEqual({
      source: "mock",
      collectionState: "unavailable",
      currentModelRevision: null,
      currentObservationRevision: null,
      events: []
    });
    expect(coherentObservedDockerEvents(buildModel(snapshot, runtime), "demo", "demo", demo)).toBeNull();
  });

  it("renders a distinct, non-routable stream-observation panel with accessible list semantics", () => {
    const html = render(coherentHistory);
    const text = visibleText(html);

    expect(text).toContain("Docker event observations");
    expect(text).toContain("Bounded daemon-lifetime observations from the read-only Docker event stream.");
    expect(text).toContain("reconnects can leave gaps.");
    expect(text).toContain("Collection state: reconnecting; observations may be incomplete");
    expect(text).toContain("Docker stream observation");
    expect(text).toContain("container_created");
    expect(text).toContain("docker_event_stream");
    expect(text).not.toContain(eventId);
    expect(text).not.toContain(containerId);
    expect(html).toContain('<section class="panel panel-docker-event-observations">');
    expect(html).toContain('<h2 class="panel-title">');
    expect(html).toContain('role="status"');
    expect(html).toContain('<ol class="stream-observation-list" aria-describedby="docker-event-observation-boundary">');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('<time class="timeline-time" dateTime="2024-03-09T16:00:01.000Z">');
    expect(html).not.toContain("/services/");
    expect(html).not.toContain('href="/services/');
  });

  it.each([null, undefined, false, 0, "row", [], {}])("rejects a non-record event row (%p) without throwing", (row) => {
    const malformed = {
      ...coherentHistory,
      events: [row]
    } as unknown as ObservedDockerEventHistoryResponse;

    expect(coherentObservedDockerEvents(buildModel(snapshot, runtime), "live", "live", malformed)).toBeNull();
    expect(() => render(malformed)).not.toThrow();
    expect(render(malformed)).not.toContain("panel-docker-event-observations");
  });

  it("rejects an oversized retained-event response before rendering", () => {
    const oversized: ObservedDockerEventHistoryResponse = {
      ...coherentHistory,
      events: Array.from({ length: 65 }, (_, index) => ({
        ...coherentHistory.events[0]!,
        id: `docker_event_${index.toString(16).padStart(64, "0")}`
      }))
    };

    expect(coherentObservedDockerEvents(buildModel(snapshot, runtime), "live", "live", oversized)).toBeNull();
    expect(render(oversized)).not.toContain("panel-docker-event-observations");
  });

  const incoherentHistories: Array<[string, ObservedDockerEventHistoryResponse, EvidenceMode, ModelProvenance]> = [
    ["mock source", { ...coherentHistory, source: "mock" }, "live", "live"],
    ["revision mismatch", { ...coherentHistory, currentModelRevision: "other" }, "live", "live"],
    ["collector unavailable", { ...coherentHistory, collectionState: "unavailable", currentModelRevision: null, currentObservationRevision: null, events: [] }, "live", "live"],
    ["demo mode", coherentHistory, "demo", "demo"],
    ["model source mismatch", coherentHistory, "live", "mock"],
    ["duplicate event ids", { ...coherentHistory, events: [coherentHistory.events[0]!, coherentHistory.events[0]!] }, "live", "live"],
    ["future source timestamp", { ...coherentHistory, events: [{ ...coherentHistory.events[0]!, sourceOccurredAtMs: 1_710_000_001_001 }] }, "live", "live"],
    ["unrenderable observation timestamp", { ...coherentHistory, events: [{ ...coherentHistory.events[0]!, observedAtMs: 8_640_000_000_000_001 }] }, "live", "live"]
  ];

  it.each(incoherentHistories)("fails closed and omits the panel for %s", (_name, history, mode, provenance) => {
    const model = buildModel(snapshot, runtime);
    expect(coherentObservedDockerEvents(model, mode, provenance, history)).toBeNull();
    const html = render(history, mode, provenance);
    expect(visibleText(html)).not.toContain("Docker event observations");
    expect(html).not.toContain("panel-docker-event-observations");
  });
});
