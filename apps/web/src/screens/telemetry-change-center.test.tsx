import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { DockerSnapshot, ObservedDockerEventHistoryResponse, ObservedResourceTelemetryResponse, RuntimeMap } from "@dockermap/contracts";
import { AppContext, type AppContextValue } from "../context";
import { buildModel } from "../lib/model";
import { coherentObservedDockerEvents } from "../lib/observedDockerEvents";
import { testProviderStates } from "../lib/testProviderStates";
import { visibleText } from "../lib/test-utils";
import Changes from "./Changes";
import ServiceDetail from "./ServiceDetail";

const revision = "publication-r42";
const containerId = "docker_container_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const eventId = "docker_event_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const runtime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], modelRevision: revision, providerStates: testProviderStates, lastUpdated: 0 };
const snapshot: DockerSnapshot = { containers: [{ id: containerId, name: "api", image: "nginx", status: "running", role: "api", networks: [], ports: [], mounts: [], dependsOn: [] }], images: [], networks: [], volumes: [], modelRevision: revision, lastUpdated: 0 };
const now = Date.now();
const metric = (value: number) => ({ value, observedAtMs: now - 10, expiresAtMs: now + 30_000 });
const events: ObservedDockerEventHistoryResponse = { source: "docker", collectionState: "collecting", currentModelRevision: revision, currentObservationRevision: "event-r7", events: [{ id: eventId, containerId, evidenceSource: "docker_event_stream", kind: "container_died", observedAtMs: 1_710_000_000_000, sourceOccurredAtMs: 1_710_000_000_000, anchorModelRevision: revision, anchorObservationRevision: "event-r7" }] };
const telemetry: ObservedResourceTelemetryResponse = { source: "docker", collectionState: "fresh", currentModelRevision: revision, currentObservationRevision: "telemetry-r7", samples: [{ containerId, cpuPercent: metric(40), memoryUsedBytes: metric(128 * 1024 * 1024), memoryLimitBytes: metric(512 * 1024 * 1024), networkRxBytesPerSecond: metric(500), networkTxBytesPerSecond: metric(750) }] };

function render(path: "/changes" | "/services/api", overrides: Partial<AppContextValue> = {}) {
  const value: AppContextValue = { model: buildModel(snapshot, runtime), modelProvenance: "live", loading: false, error: null, health: null, tick: 0, evidenceMode: "live", observedDockerEvents: events, resourceTelemetry: telemetry, openCommand: () => {}, ...overrides };
  return renderToStaticMarkup(<AppContext.Provider value={value}><MemoryRouter initialEntries={[path]}><Routes><Route path="/changes" element={<Changes />} /><Route path="/services/:name" element={<ServiceDetail defaultTab="resources" />} /></Routes></MemoryRouter></AppContext.Provider>);
}

describe("Change Center and current telemetry boundaries", () => {
  it("renders independent coherent historical events and current telemetry without identities crossing either surface", () => {
    const changes = render("/changes");
    const resources = render("/services/api");
    expect(visibleText(changes)).toContain("Docker event observations");
    expect(visibleText(changes)).toContain("container_died");
    expect(visibleText(resources)).toContain("Observed — current");
    expect(resources).toContain('aria-label="Memory 25% — Observed, current"');
    for (const html of [changes, resources]) { expect(html).not.toContain(eventId); expect(html).not.toContain("event-r7"); expect(html).not.toContain("telemetry-r7"); }
    expect(changes).not.toContain("/services/");
  });

  it("keeps fresh telemetry available after an empty retained stream reset", () => {
    const changes = render("/changes", { observedDockerEvents: { ...events, events: [] } });
    const resources = render("/services/api", { observedDockerEvents: { ...events, events: [] } });
    expect(visibleText(changes)).toContain("No retained stream observations");
    expect(visibleText(changes)).toContain("reset or reconnect");
    expect(resources).toContain('aria-label="Memory 25% — Observed, current"');
  });

  it("does not treat stale telemetry as an event reset or let an incoherent event response hide the stale state", () => {
    const stale = { ...telemetry, collectionState: "stale" } as ObservedResourceTelemetryResponse;
    const malformed = { ...events, currentModelRevision: "other" };
    const changes = render("/changes", { observedDockerEvents: malformed });
    const resources = render("/services/api", { observedDockerEvents: malformed, resourceTelemetry: stale });
    expect(changes).not.toContain("panel-docker-event-observations");
    expect(visibleText(resources)).toContain("Telemetry stale");
    expect(resources).not.toContain('aria-label="Memory 25% — Observed, current"');
  });

  it("rejects oversized revision strings before rendering or traversing their code points", () => {
    const hostile = { ...events, currentObservationRevision: "x".repeat(129) } as ObservedDockerEventHistoryResponse;
    expect(coherentObservedDockerEvents(buildModel(snapshot, runtime), "live", "live", hostile)).toBeNull();
    expect(render("/changes", { observedDockerEvents: hostile })).not.toContain("panel-docker-event-observations");
  });
});
