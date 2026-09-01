import { testProviderStates } from "./testProviderStates";
import { describe, expect, it, vi } from "vitest";
import type { DockerSnapshot, RuntimeMap } from "@dockermap/contracts";
import { RESOURCE_STATS_CLAIM } from "./resources";
import { type EvidenceMode, type ModelProvenance } from "./evidence";
import { buildModel, summarize } from "./model";
import { RESOURCE_CLAIM_MATRIX } from "./test-utils";
import { resourceFor, resourceForWithHasherForTest, type ResourceSample } from "./stubs";

const runtime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], modelRevision: "test-revision", providerStates: testProviderStates, lastUpdated: 0 };
const snapshot: DockerSnapshot = { containers: [{ id: "offline", name: "db", image: "postgres", status: "Exited (1)", role: "database", networks: [], ports: [], mounts: [], dependsOn: [] }], images: [], networks: [], volumes: [], modelRevision: "test-revision", lastUpdated: 0 };
const model = buildModel(snapshot, runtime);
const service = model.services[0];

// Copied from no-synthetic-updates.test.ts: this shallow structural tripwire
// catches accidental model-layer resource fields but is NOT the backstop; the
// type probes and source gate below protect the public contract directly.
function deepKeys(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(deepKeys);
  return Object.entries(value).flatMap(([key, nested]) => [key, ...deepKeys(nested)]);
}

describe("resource samples are explicit-demo-only", () => {
  it.each(RESOURCE_CLAIM_MATRIX)("resourceFor(%s, %s) → %s", (mode, provenance, expected) => {
    const claim = resourceFor(service, mode, provenance);
    expect(claim.kind).toBe(expected);
    if (claim.kind === "unavailable") {
      expect(expected).toBe("unavailable");
      expect(claim).toBe(RESOURCE_STATS_CLAIM);
      expect(claim.value).toBeNull();
      expect(claim.detail).toBe("Resource collectors not wired — DockerMap does not measure container CPU, memory or network");
      expect(Object.keys(claim)).not.toContain("cpuPercent");
    } else {
      expect(expected).toBe("demo");
      expect(claim.value.cpuSeries).toHaveLength(24);
      expect(Object.values(claim.value).flatMap((value) => Array.isArray(value) ? value : [value]).every(Number.isFinite)).toBe(true);
    }
  });

  it.each(RESOURCE_CLAIM_MATRIX)("unavailable %s/%s returns before service or hash access", (mode: EvidenceMode | null, provenance: ModelProvenance | null, expected) => {
    if (expected === "demo") return;
    const proxy = new Proxy(service, { get: () => { throw new Error("service read before gate"); } });
    const hash = vi.fn(() => { throw new Error("resource synthesis reached"); });
    expect(resourceForWithHasherForTest(proxy, mode, provenance, hash)).toBe(RESOURCE_STATS_CLAIM);
    expect(hash).not.toHaveBeenCalled();
  });

  it("reaches the hasher only for the authorized pair", () => {
    const hash = vi.fn(() => 0.17);
    expect(resourceForWithHasherForTest(service, "demo", "demo", hash).kind).toBe("demo");
    expect(hash).toHaveBeenCalled();
  });

  it("locks removed estimated field and claim boundary at type level", () => {
    type EstProbe<K extends string> = `estimate${K}`;
    // @ts-expect-error estimated must remain absent from ResourceSample.
    const estimatedProbe: EstProbe<"d"> extends keyof ResourceSample ? "ok" : never = "ok";
    // @ts-expect-error resourceFor returns a Claim, never raw sample data.
    const bypass: ResourceSample = resourceFor(service, "demo", "demo");
    expect([estimatedProbe, bypass]).toHaveLength(2);
  });

  it("keeps resource-shaped fields out of the model layer", () => {
    expect(deepKeys([model.services, summarize(model)]).some((key) => /cpu|memory|kbps|bytes|percent/i.test(key))).toBe(false);
  });
});
