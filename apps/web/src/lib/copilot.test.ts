import { testProviderStates } from "./testProviderStates";
import { describe, expect, it } from "vitest";
import type { DockerSnapshot, ObservedDockerEventHistoryResponse, RuntimeMap } from "@dockermap/contracts";
import { answer } from "./copilot";
import { getDemoResponse } from "./demoData";
import { buildModel } from "./model";

const runtime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], modelRevision: "test-revision", providerStates: testProviderStates, lastUpdated: 0 };
const liveSnapshot: DockerSnapshot = { containers: [{ id: "live-api", name: "api", image: "nginx:1", status: "running", role: "api", networks: [], ports: ["443:443"], mounts: [], dependsOn: [] }], images: [], networks: [], volumes: [], modelRevision: "test-revision", lastUpdated: 0 };

const demoSnapshot = (): DockerSnapshot => getDemoResponse<DockerSnapshot>("/api/snapshot");

const observedEvents: ObservedDockerEventHistoryResponse = {
  source: "docker",
  collectionState: "collecting",
  currentModelRevision: "test-revision",
  currentObservationRevision: "event-observation-revision",
  // Deliberately reverse receipt order: Copilot must not rely on the current
  // daemon implementation's newest-first transport ordering.
  events: [
    {
      id: `docker_event_${"a".repeat(64)}`,
      containerId: `docker_container_${"b".repeat(64)}`,
      evidenceSource: "docker_event_stream",
      kind: "container_started",
      observedAtMs: 1,
      sourceOccurredAtMs: 1,
      anchorModelRevision: "test-revision",
      anchorObservationRevision: "event-observation-revision"
    },
    {
      id: `docker_event_${"c".repeat(64)}`,
      containerId: `docker_container_${"d".repeat(64)}`,
      evidenceSource: "docker_event_stream",
      kind: "container_health_healthy",
      observedAtMs: 2,
      sourceOccurredAtMs: 2,
      anchorModelRevision: "test-revision",
      anchorObservationRevision: "event-observation-revision"
    }
  ]
};

describe("Copilot evidence vocabulary", () => {
  it("labels live answers with the claim's evidence kind", () => {
    const response = answer(buildModel(liveSnapshot, runtime), "show unhealthy services", "live", "live");
    expect(response.evidence).toBe("derived");
  });

  it("labels sample-model answers as sample data regardless of the claim path", () => {
    const demo = buildModel(demoSnapshot(), runtime);
    expect(answer(demo, "show unhealthy services", "demo", "demo").evidence).toBe("demo");
    expect(answer(demo, "what depends on api", "demo", "demo").evidence).toBe("demo");
  });

  it("refuses a substantive answer when authority is unresolved", () => {
    const response = answer(buildModel(liveSnapshot, runtime), "show unhealthy services", null, null);
    expect(response.evidence).toBe("unavailable");
    expect(response.headline).toBe("Source not established");
  });

  it("never presents mock/demo bytes as observed host state", () => {
    const mock = buildModel(liveSnapshot, runtime);
    expect(answer(mock, "show unhealthy services", "mock", "mock").evidence).toBe("demo");
  });
});

describe("Copilot update-status responses", () => {
  it("uses identical not-collected copy for live and demo models", () => {
    for (const [snapshot, mode, provenance] of [
      [liveSnapshot, "live", "live"],
      [demoSnapshot(), "demo", "demo"]
    ] as Array<[DockerSnapshot, "live" | "demo", "live" | "demo"]>) {
      const response = answer(buildModel(snapshot, runtime), "what changed recently", mode, provenance);
      expect(response.headline).toBe("Recent and pending change");
      expect(response.body).toEqual([
        "Update status: Not collected — Update checks not wired — DockerMap does not query registries.",
        "Change history: Not collected — Change collectors not wired — DockerMap does not record deploy, restart or failure events."
      ]);
      expect(response.references).toEqual([]);
      expect(response.evidence).toBe("unavailable");
    }
  });

  it("answers from only coherent live Docker stream observations without identities or causal claims", () => {
    const response = answer(buildModel(liveSnapshot, runtime), "what changed recently", "live", "live", observedEvents);
    const text = `${response.headline} ${response.body.join(" ")}`;
    expect(response.headline).toBe("Most recent Docker stream observation");
    expect(response.evidence).toBe("observed");
    expect(response.references).toEqual([]);
    expect(text).toContain("container_health_healthy");
    expect(text).not.toContain(observedEvents.events[0]!.id);
    expect(text).not.toContain(observedEvents.events[0]!.containerId);
    expect(text).not.toMatch(/current state|service|cause|restart|deploy|failure/i);
  });

  it("reports a coherent empty stream as observed without claiming that nothing changed", () => {
    const response = answer(buildModel(liveSnapshot, runtime), "what changed recently", "live", "live", {
      ...observedEvents,
      events: []
    });
    expect(response.headline).toBe("No retained Docker stream observations");
    expect(response.evidence).toBe("observed");
    expect(response.body.join(" ")).not.toMatch(/nothing changed/i);
  });

  it("fails closed to unavailable for a malformed or revision-incoherent stream", () => {
    const malformed = structuredClone(observedEvents) as ObservedDockerEventHistoryResponse;
    malformed.events[0]!.id = "untrusted";
    for (const history of [malformed, { ...observedEvents, currentModelRevision: "different" }]) {
      const response = answer(buildModel(liveSnapshot, runtime), "what changed recently", "live", "live", history);
      expect(response.evidence).toBe("unavailable");
      expect(response.headline).toBe("Recent and pending change");
    }
  });

  it("preserves the unrelated port-answer dispatch", () => {
    expect(answer(buildModel(liveSnapshot, runtime), "show everything using port 443", "live", "live").headline).toBe("Port 443");
  });
});

describe("Copilot truthfulness in live mode", () => {
  it("describes dependents as declared start order, never failure impact", () => {
    const containers: DockerSnapshot["containers"] = [
      { id: "web", name: "web", image: "nginx:1", status: "running", role: "api", networks: [], ports: [], mounts: [], dependsOn: ["db"] },
      { id: "db", name: "db", image: "postgres:16", status: "running", role: "database", networks: [], ports: [], mounts: [], dependsOn: [] }
    ];
    const snapshot: DockerSnapshot = { containers, images: [], networks: [], volumes: [], modelRevision: "test-revision", lastUpdated: 0 };
    const response = answer(buildModel(snapshot, runtime), "what depends on db", "live", "live");
    expect(response.headline).toContain("declares start order after db");
    expect(response.body.join(" ")).toContain("start after db");
    expect(response.body.join(" ")).not.toContain("fails, these are affected");
    expect(response.body.join(" ")).not.toContain("can fail in isolation");
    expect(response.evidence).toBe("derived");
  });

  it("labels causal reasoning as inferred, not measured", () => {
    const containers: DockerSnapshot["containers"] = [
      { id: "web", name: "web", image: "nginx:1", status: "Exited (1)", role: "api", networks: [], ports: [], mounts: [], dependsOn: ["db"] },
      { id: "db", name: "db", image: "postgres:16", status: "Exited (1)", role: "database", networks: [], ports: [], mounts: [], dependsOn: [] }
    ];
    const snapshot: DockerSnapshot = { containers, images: [], networks: [], volumes: [], modelRevision: "test-revision", lastUpdated: 0 };
    const response = answer(buildModel(snapshot, runtime), "why is web offline", "live", "live");
    expect(response.body.join(" ")).toContain("Inferred");
    expect(response.body.join(" ")).toContain("heuristic, not measured");
    expect(response.evidence).toBe("inferred");
  });

  it("describes service overview with declaration vocabulary", () => {
    const containers: DockerSnapshot["containers"] = [
      { id: "web", name: "web", image: "nginx:1", status: "running", role: "api", networks: [], ports: [], mounts: [], dependsOn: ["db"] },
      { id: "db", name: "db", image: "postgres:16", status: "running", role: "database", networks: [], ports: [], mounts: [], dependsOn: [] }
    ];
    const snapshot: DockerSnapshot = { containers, images: [], networks: [], volumes: [], modelRevision: "test-revision", lastUpdated: 0 };
    const response = answer(buildModel(snapshot, runtime), "tell me about web", "live", "live");
    expect(response.body.join(" ")).toContain("Declares start order after 1 service");
    expect(response.body.join(" ")).not.toContain("used by");
  });
});
