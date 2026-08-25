import { describe, expect, it, vi } from "vitest";
import type { DockerSnapshot, RuntimeMap } from "@dockermap/contracts";
import { claimAuthority } from "./evidence";
import { buildModel, type SystemModel } from "./model";
import { CAUSAL_CHAIN_CLAIM, CHANGE_HISTORY_CLAIM } from "./history";
import { causalChain, changeFeed, type ChangeEvent } from "./stubs";

const runtime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], lastUpdated: 0 };
const snapshot: DockerSnapshot = { containers: [{ id: "offline", name: "db", image: "postgres", status: "Exited (1)", role: "database", networks: [], ports: [], mounts: [], dependsOn: [] }], images: [], networks: [], volumes: [], lastUpdated: 0 };
const model: SystemModel = buildModel(snapshot, runtime);

describe("synthetic history is unavailable outside sample authority", () => {
  it.each(["live", "mock", "demo", null] as const)("matches the authority matrix for %s", (mode) => {
    const expected = claimAuthority(mode) === "sample" ? "demo" : "unavailable";
    const history = changeFeed(model, mode);
    const chain = causalChain(model, mode);
    expect(history.kind).toBe(expected);
    expect(chain.kind).toBe(expected);
    if (expected === "unavailable") {
      expect(history).toEqual(CHANGE_HISTORY_CLAIM);
      expect(chain).toEqual(CAUSAL_CHAIN_CLAIM);
      expect(history.value).toBeNull();
      expect(chain.value).toBeNull();
    }
  });

  it("never reads the clock for live/null authority but does for demo", () => {
    const now = vi.spyOn(Date, "now");
    changeFeed(model, "live");
    causalChain(model, null);
    expect(now).not.toHaveBeenCalled();
    changeFeed(model, "demo");
    expect(now).toHaveBeenCalled();
    now.mockRestore();
  });

  it("locks the removed estimated event field and array-return bypass at type level", () => {
    type EstProbe<K extends string> = `estimate${K}`;
    // @ts-expect-error estimated is not part of ChangeEvent.
    const estimatedProbe: EstProbe<"d"> extends keyof ChangeEvent ? "ok" : never = "ok";
    // @ts-expect-error changeFeed returns a claim, not a synthetic array.
    const bypass: ChangeEvent[] = changeFeed(model, "demo");
    expect([estimatedProbe, bypass]).toHaveLength(2);
  });

  it("documents the static gate's blind spot", () => {
    // The probes block reintroducing this field or returning an array, but do
    // not prove that an unrelated future event field is evidence-backed. The
    // authority matrix and live render tests are the complementary guard.
    expect("unrelated future field").not.toContain("estimated");
  });
});
