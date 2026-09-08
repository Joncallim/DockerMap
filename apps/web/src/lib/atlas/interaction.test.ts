import { describe, expect, it, vi } from "vitest";
import { collisionFixture, runtimeFixture } from "./fixtures";
import { atlasHref, atlasRouteState, atlasSubjectHref, parseAtlasSearch, serializeAtlasState } from "./interaction";
import { projectRuntimeMap } from "./project";

const model = projectRuntimeMap(runtimeFixture(10, "outbound_star", "network")).model;
const selected = model.subjects.find((subject) => subject.routability === "routable")!.key;
const aggregate = model.aggregates[0]!.key;

describe("Atlas route interaction policy", () => {
  it("serializes only model-backed semantic state and omits the default lens", () => {
    expect(serializeAtlasState(model, { lens: "overview", selectedKey: selected, expandedKey: aggregate })).toBe(`?subject=${selected}&expand=${encodeURIComponent(aggregate)}`);
    expect(atlasHref(model, { selectedKey: selected })).toBe(`/atlas?subject=${selected}`);
    expect(serializeAtlasState(model, { selectedKey: "raw-label/0,0" })).toBe("");
  });

  it("rejects duplicate, unknown, oversized, raw and camera-like URL data", () => {
    const parsed = parseAtlasSearch(`?subject=${selected}&subject=${selected}&x=1&label=hostile`, model);
    expect(parsed.state).toEqual({ lens: "overview", selectedKey: null, expandedKey: null, focusTarget: "directory" });
    expect(parsed.rejectedSubject).toBe(true);
    expect(parseAtlasSearch(`?subject=${selected}&expand=raw/evidence`, model).state.selectedKey).toBe(selected);
    expect(parseAtlasSearch(`?subject=${selected}&x=1&y=2&zoom=5`, model).state.selectedKey).toBeNull();
    expect(parseAtlasSearch(`?subject=${"a".repeat(800)}`, model).state.selectedKey).toBeNull();
  });

  it("invalidates all Atlas route state for one unknown query field", () => {
    const parsed = parseAtlasSearch(`?subject=${selected}&expand=${aggregate}&x=1`, model);
    expect(parsed.state).toEqual({ lens: "overview", selectedKey: null, expandedKey: null, focusTarget: "directory" });
    expect(parsed.rejectedSubject).toBe(true);
    expect(parsed.rejectedExpansion).toBe(true);
  });

  it("admits only supported lenses and actual aggregate/group expansions", () => {
    expect(parseAtlasSearch(`?lens=dependencies&subject=${selected}`, model)).toMatchObject({ state: { lens: "dependencies", selectedKey: selected }, rejectedLens: false });
    expect(parseAtlasSearch(`?lens=not-a-lens&subject=${selected}`, model)).toMatchObject({ state: { lens: "overview", selectedKey: null }, rejectedLens: true, rejectedSubject: true });
    expect(atlasRouteState(model, { selectedKey: selected, expandedKey: "atlas-group-never-published" }).expandedKey).toBeNull();
    expect(atlasRouteState(model, { selectedKey: selected, expandedKey: aggregate }).expandedKey).toBe(aggregate);
    expect(atlasRouteState(model, { lens: "overview", selectedKey: selected }).selectedKey).toBe(selected);
    expect(serializeAtlasState(model, { lens: "storage", selectedKey: selected })).toBe(`?lens=storage&subject=${selected}`);
  });

  it("fails closed for collision and revision-disappeared selected identities", () => {
    const collision = projectRuntimeMap(collisionFixture()).model;
    expect(parseAtlasSearch(`?subject=${selected}`, collision)).toMatchObject({ state: { selectedKey: null }, rejectedSubject: true });
  });

  it("builds enabled cross-screen handoffs only from an exact current runtime source id", async () => {
    const envelope = { sourceRevision: "r1", model };
    expect(atlasSubjectHref(envelope, selected)).toBeNull();
    vi.stubEnv("VITE_ENABLE_ATLAS_OVERVIEW", "true");
    vi.resetModules();
    const enabled = await import("./interaction");
    expect(enabled.atlasSubjectHref(envelope, selected)).toBe(`/atlas?subject=${selected}`);
    expect(enabled.atlasSubjectHref(envelope, "same-safe-label-but-not-source")).toBeNull();
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
