import { testProviderStates } from "./testProviderStates";
import { describe, expect, it } from "vitest";
import type { DockerSnapshot, RuntimeMap, RuntimeMapNode } from "@dockermap/contracts";
import { buildModel, stateForStatus } from "./model";

const runtime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], modelRevision: "test-revision", providerStates: testProviderStates, lastUpdated: 0 };
const emptySnapshot: DockerSnapshot = { containers: [], images: [], networks: [], volumes: [], modelRevision: "test-revision", lastUpdated: 0 };

describe("D1. Docker health-suffix false-green", () => {
  it("'Up 3 hours (unhealthy)' is degraded, not healthy", () => {
    expect(stateForStatus("Up 3 hours (unhealthy)")).toBe("degraded");
  });

  it("'Up 2 minutes (health: starting)' is updating, not healthy", () => {
    expect(stateForStatus("Up 2 minutes (health: starting)")).toBe("updating");
  });

  it("'Up 3 hours (healthy)' is healthy", () => {
    expect(stateForStatus("Up 3 hours (healthy)")).toBe("healthy");
  });

  it("plain 'Up 3 hours' without a health marker is healthy", () => {
    expect(stateForStatus("Up 3 hours")).toBe("healthy");
  });

  it("'Exited (0) 2 hours ago' is offline", () => {
    expect(stateForStatus("Exited (0) 2 hours ago")).toBe("offline");
  });

  it("a container with 'Up ... (unhealthy)' never feeds an all-healthy Home claim", () => {
    const model = buildModel(
      { containers: [{ id: "c1", name: "web", image: "nginx:1", status: "Up 3 hours (unhealthy)", role: "api", networks: [], ports: [], mounts: [], dependsOn: [] }], images: [], networks: [], volumes: [], modelRevision: "test-revision", lastUpdated: 0 },
      runtime
    );
    expect(model.services[0].state).toBe("degraded");
    expect(model.services.every((s) => s.state === "healthy")).toBe(false);
  });
});

describe("D2. negative-state overclassification and bucket precision", () => {
  function runtimeStateFor(nodes: RuntimeMapNode[], id: string): string | undefined {
    const model = buildModel(emptySnapshot, { nodes, edges: [], diagnostics: [], modelRevision: "test-revision", providerStates: testProviderStates, lastUpdated: 0 });
    return model.runtime.nodes.find((n) => n.id === id)?.state;
  }

  function node(id: string, status: string | null): RuntimeMapNode {
    return { id, provider: "systemd", type: "service", label: id, status, metadata: {}, service: null };
  }

  it("'not configured' is not invented as offline", () => {
    expect(runtimeStateFor([node("a", "not configured")], "a")).not.toBe("offline");
    expect(runtimeStateFor([node("a", "not configured")], "a")).not.toBe("healthy");
  });

  it("'not applicable' is not invented as offline", () => {
    expect(runtimeStateFor([node("b", "not applicable")], "b")).not.toBe("offline");
  });

  it("'not monitored' is not invented as offline", () => {
    expect(runtimeStateFor([node("c", "not monitored")], "c")).not.toBe("offline");
  });

  it("'not ready' remains a recognized negative state", () => {
    expect(runtimeStateFor([node("d", "not ready")], "d")).not.toBe("healthy");
  });

  it("explicit health.state unhealthy maps to degraded, not offline", () => {
    const model = buildModel(emptySnapshot, {
      nodes: [{ id: "svc", provider: "docker", type: "service", label: "svc", status: "running", metadata: {}, service: { name: "svc", status: "running", dependencies: [], dependents: [], health: { state: "unhealthy" }, logs: [], events: [], owner: null, location: null } }],
      edges: [], diagnostics: [], modelRevision: "test-revision", providerStates: testProviderStates, lastUpdated: 0
    });
    expect(model.runtime.nodes.find((n) => n.id === "svc")?.state).toBe("degraded");
  });

  it("explicit health.state unknown is preserved as unknown, never healthy", () => {
    const model = buildModel(emptySnapshot, {
      nodes: [{ id: "svc", provider: "docker", type: "service", label: "svc", status: "running", metadata: {}, service: { name: "svc", status: "running", dependencies: [], dependents: [], health: { state: "unknown" }, logs: [], events: [], owner: null, location: null } }],
      edges: [], diagnostics: [], modelRevision: "test-revision", providerStates: testProviderStates, lastUpdated: 0
    });
    expect(model.runtime.nodes.find((n) => n.id === "svc")?.state).toBe("unknown");
  });
});
