import { describe, expect, it } from "vitest";
import type { DockerSnapshot, RuntimeMap, RuntimeMapNode } from "@dockermap/contracts";
import { buildModel } from "./model";

const runtime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], lastUpdated: 0 };
const emptySnapshot: DockerSnapshot = { containers: [], images: [], networks: [], volumes: [], lastUpdated: 0 };

function node(id: string, status: string | null): RuntimeMapNode {
  return {
    id,
    provider: "systemd",
    type: "service",
    label: id,
    status,
    metadata: {},
    service: null
  };
}

/** Build a runtime model and return the state of the node with the given id. */
function runtimeStateFor(nodes: RuntimeMapNode[], id: string): string | undefined {
  const model = buildModel(emptySnapshot, { nodes, edges: [], diagnostics: [], lastUpdated: 0 });
  return model.runtime.nodes.find((n) => n.id === id)?.state;
}

describe("#76 runtime state normalization must be negative-safe", () => {
  it("never maps a negative status containing a positive substring to healthy", () => {
    // Each of these contains a positive substring ("healthy", "available",
    // "active", "connected", "ready") that the old substring matcher hit.
    const cases: Array<[string, string]> = [
      ["unhealthy", "unhealthy"],
      ["unavailable", "unavailable"],
      ["inactive", "inactive"],
      ["disconnected", "disconnected"],
      ["not ready", "not ready"]
    ];
    for (const [id, status] of cases) {
      expect(runtimeStateFor([node(id, status)], id), `status "${status}" must not become healthy`).not.toBe("healthy");
    }
  });

  it("maps each negative status to a specific non-healthy state", () => {
    expect(runtimeStateFor([node("a", "unhealthy")], "a")).toBe("offline");
    expect(runtimeStateFor([node("b", "unavailable")], "b")).not.toBe("healthy");
    expect(runtimeStateFor([node("c", "inactive")], "c")).not.toBe("healthy");
    expect(runtimeStateFor([node("d", "disconnected")], "d")).not.toBe("healthy");
    expect(runtimeStateFor([node("e", "not ready")], "e")).not.toBe("healthy");
  });

  it("still maps genuinely positive statuses to healthy", () => {
    for (const status of ["healthy", "running", "active", "online", "available", "connected", "ready", "attached"]) {
      expect(runtimeStateFor([node("ok", status)], "ok"), `status "${status}" should be healthy`).toBe("healthy");
    }
  });

  it("keeps the attention states for known trouble statuses", () => {
    expect(runtimeStateFor([node("a", "degraded")], "a")).toBe("degraded");
    expect(runtimeStateFor([node("b", "failed")], "b")).toBe("degraded");
    expect(runtimeStateFor([node("c", "stopped")], "c")).toBe("offline");
    expect(runtimeStateFor([node("d", "exited")], "d")).toBe("offline");
    expect(runtimeStateFor([node("e", "warning")], "e")).toBe("warning");
    expect(runtimeStateFor([node("f", "restarting")], "f")).toBe("updating");
    expect(runtimeStateFor([node("g", "starting")], "g")).toBe("updating");
  });

  it("unknown status stays unknown", () => {
    expect(runtimeStateFor([node("a", "??")], "a")).toBe("unknown");
    expect(runtimeStateFor([node("b", null)], "b")).toBe("unknown");
  });
});
