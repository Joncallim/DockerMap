import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockerSnapshot, RuntimeMap } from "@dockermap/contracts";
import { buildModel, type SystemModel } from "./model";
import type { EvidenceMode, ModelProvenance } from "./evidence";
import { CAUSAL_CHAIN_CLAIM, CHANGE_HISTORY_CLAIM } from "./history";
import { causalChain, changeFeed, type ChangeEvent } from "./stubs";

const runtime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], lastUpdated: 0 };
const snapshot: DockerSnapshot = { containers: [{ id: "offline", name: "db", image: "postgres", status: "Exited (1)", role: "database", networks: [], ports: [], mounts: [], dependsOn: [] }], images: [], networks: [], volumes: [], lastUpdated: 0 };
const model: SystemModel = buildModel(snapshot, runtime);

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * V3 provenance gate matrix — HARD-CODED expected kinds, deliberately NOT
 * re-derived through claimAuthority (a matrix that re-derives its own
 * expectation from the very predicate it tests proves nothing). The mapping
 * is independently pinned by evidence.test.ts and the V1 render pairs.
 */
const PROVENANCE_MATRIX: [EvidenceMode | null, ModelProvenance | null, "demo" | "unavailable"][] = [
  ["live", "live", "unavailable"],
  ["live", "mock", "unavailable"],
  ["live", "demo", "unavailable"],
  ["mock", "live", "unavailable"],
  ["mock", "mock", "unavailable"],
  ["mock", "demo", "unavailable"],
  ["demo", "live", "unavailable"],
  ["demo", "mock", "unavailable"],
  ["demo", "demo", "demo"],
  [null, "live", "unavailable"],
  [null, "mock", "unavailable"],
  [null, "demo", "unavailable"],
  [null, null, "unavailable"]
];

describe("synthetic history is unavailable outside the allow-listed mode/provenance pair", () => {
  it.each(PROVENANCE_MATRIX)("changeFeed(%s, %s) → %s", (mode, provenance, expected) => {
    const history = changeFeed(model, mode, provenance);
    expect(history.kind).toBe(expected);
    if (history.kind === "unavailable") {
      expect(expected).toBe("unavailable");
      expect(history).toEqual(CHANGE_HISTORY_CLAIM);
      expect(history.value).toBeNull();
      expect(history.detail).toBe(CHANGE_HISTORY_CLAIM.detail);
    } else {
      expect(expected).toBe("demo");
    }
  });

  it.each(PROVENANCE_MATRIX)("causalChain(%s, %s) → %s", (mode, provenance, expected) => {
    const chain = causalChain(model, mode, provenance);
    expect(chain.kind).toBe(expected);
    if (chain.kind === "unavailable") {
      expect(expected).toBe("unavailable");
      expect(chain).toEqual(CAUSAL_CHAIN_CLAIM);
      expect(chain.value).toBeNull();
      expect(chain.detail).toBe(CAUSAL_CHAIN_CLAIM.detail);
    } else {
      expect(expected).toBe("demo");
    }
  });

  it("reads the clock ONLY for the authorized Demo Mode pair (demo/demo)", () => {
    const now = vi.spyOn(Date, "now");
    try {
      // The sole authorized pair may roll the clock once per emitted event.
      changeFeed(model, "demo", "demo");
      const authorizedCalls = now.mock.calls.length;
      expect(authorizedCalls).toBeGreaterThan(0);
      // Every mismatch and every causalChain call must be clock-free: the
      // guard runs before the generator body, so no pair may reach Date.now().
      for (const [mode, provenance] of PROVENANCE_MATRIX) {
        if (mode === "demo" && provenance === "demo") continue;
        changeFeed(model, mode, provenance);
        causalChain(model, mode, provenance);
      }
      expect(now.mock.calls.length).toBe(authorizedCalls);
    } finally {
      now.mockRestore();
    }
  });

  it("locks the removed estimated event field and claim bypass at type level", () => {
    type EstProbe<K extends string> = `estimate${K}`;
    // @ts-expect-error estimated is not part of ChangeEvent.
    const estimatedProbe: EstProbe<"d"> extends keyof ChangeEvent ? "ok" : never = "ok";
    // @ts-expect-error changeFeed returns a claim, not a synthetic array.
    const bypass: ChangeEvent[] = changeFeed(model, "demo", "demo");
    expect([estimatedProbe, bypass]).toHaveLength(2);
  });
});
