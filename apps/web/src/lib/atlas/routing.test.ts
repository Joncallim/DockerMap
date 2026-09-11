import { describe, expect, it } from "vitest";
import { layoutAtlas } from "./layout";
import { mutateStateOnly, permutation, runtimeFixture } from "./fixtures";
import { projectRuntimeMap } from "./project";
import { ATLAS_ROUTING_POLICY, planAtlasRoutes, routeAvoidsSubjectInteriors } from "./routing";
import type { AtlasEvidenceSources, AtlasKey, AtlasModel } from "./types";

function model(count: number, topology: Parameters<typeof runtimeFixture>[1], evidence: Parameters<typeof runtimeFixture>[2]) {
  return projectRuntimeMap(runtimeFixture(count, topology, evidence)).model;
}

function plan(count: number, topology: Parameters<typeof runtimeFixture>[1], evidence: Parameters<typeof runtimeFixture>[2], selected?: AtlasKey) {
  const current = model(count, topology, evidence);
  return { current, layout: layoutAtlas(current), value: planAtlasRoutes(current, layoutAtlas(current), { lens: "dependencies", selected }) };
}

describe("Atlas bounded orthogonal routing planner", () => {
  it("is versioned and keeps the overview relation/attachment-free", () => {
    const current = model(25, "chain", "dependency");
    expect(planAtlasRoutes(current, layoutAtlas(current), { lens: "overview" })).toEqual({
      policyVersion: "atlas-v1/orthogonal-routing-1", routes: [], population: { resolved: 0, unresolved: 0, ambiguous: 0, omitted: 0 },
      metrics: { connectors: 0, segments: 0, crossings: 0, maxRegionConnectors: 0, maxRegionSegments: 0, maxRegionCrossings: 0, viewportConnectors: 0, viewportSegments: 0, viewportCrossings: 0 }
    });
  });

  it.each([[25, 24, 12, 72, 36], [100, 80, 16, 240, 48], [250, 80, 16, 240, 48]] as const)("enforces controlled %i-subject connector and segment limits", (count, connectors, regionConnectors, segments, regionSegments) => {
    const { layout, value } = plan(count, "cycle", "dependency");
    expect(value.routes.length).toBeLessThanOrEqual(connectors);
    expect(value.routes.reduce((total, route) => total + route.segments.length, 0)).toBeLessThanOrEqual(segments);
    expect(value.metrics).toMatchObject({ connectors: value.routes.length });
    expect(value.metrics.crossings).toBeLessThanOrEqual(count === 25 ? 4 : 12);
    expect(value.metrics.maxRegionCrossings).toBeLessThanOrEqual(count === 25 ? 2 : 3);
    expect(value.routes.every((route) => route.segments.length <= 3 && routeAvoidsSubjectInteriors(route, layout))).toBe(true);
    // Endpoint region accounting is a necessary conservative subset of every
    // visible-region budget; the plan never admits more than the documented cap.
    const perEndpoint = new Map<string, number>();
    for (const route of value.routes) for (const key of [route.source, route.target]) perEndpoint.set(key, (perEndpoint.get(key) ?? 0) + 1);
    expect(Math.max(0, ...perEndpoint.values())).toBeLessThanOrEqual(regionConnectors);
    expect(value.routes.every((route) => route.segments.length <= regionSegments)).toBe(true);
  });

  it("allocates selected candidates before canonical secondary candidates without bypassing caps", () => {
    const current = model(100, "outbound_star", "network");
    // Select an endpoint with a legal local route. A distant selected endpoint
    // may still be omitted by the rectangle rule; selection is priority, not
    // permission to cross an interactive subject.
    const selected = current.attachments[0]!.context;
    const selectedPlan = planAtlasRoutes(current, layoutAtlas(current), { lens: "connectivity", selected });
    expect(selectedPlan.routes.length).toBeLessThanOrEqual(80);
    expect(selectedPlan.routes[0]).toMatchObject({ selected: true, target: selected });
  });

  it("is permutation and state-update stable, and ignores forged evidence at its boundary", () => {
    const input = runtimeFixture(25, "chain", "dependency");
    const first = projectRuntimeMap(input).model;
    const reordered = projectRuntimeMap({ ...input, nodes: permutation(input.nodes), edges: permutation(input.edges) }).model;
    expect(planAtlasRoutes(first, layoutAtlas(first), { lens: "dependencies" })).toEqual(planAtlasRoutes(reordered, layoutAtlas(reordered), { lens: "dependencies" }));
    const state = projectRuntimeMap(mutateStateOnly(input)).model;
    expect(planAtlasRoutes(first, layoutAtlas(first), { lens: "dependencies" }).routes).toEqual(planAtlasRoutes(state, layoutAtlas(state), { lens: "dependencies" }).routes);
    const forged = {
      ...first,
      relations: [{ ...first.relations[0]!, evidence: [{ ...first.relations[0]!.evidence[0]!, relationship: "connected_to" }] as unknown as AtlasEvidenceSources }]
    } as AtlasModel;
    expect(planAtlasRoutes(forged, layoutAtlas(forged), { lens: "dependencies" }).routes).toEqual([]);
  });

  it("uses only declared structural classes and never turns opaque-port absence into a connector", () => {
    const network = model(25, "star", "network");
    expect(planAtlasRoutes(network, layoutAtlas(network), { lens: "dependencies" }).routes).toEqual([]);
    const storage = model(25, "star", "storage");
    expect(planAtlasRoutes(storage, layoutAtlas(storage), { lens: "storage" }).routes.every((route) => route.routeClass === "storage_attachment")).toBe(true);
    expect(ATLAS_ROUTING_POLICY.evidenceSortVersion).toBe("atlas-v1/evidence-sort-1");
  });

  it("bundles canonical duplicate endpoints without exposing evidence in route keys", () => {
    const first = model(2, "chain", "dependency");
    const duplicated = { ...first, relations: [first.relations[0]!, first.relations[0]!] };
    const value = planAtlasRoutes(duplicated, layoutAtlas(duplicated), { lens: "dependencies" });
    expect(value.routes).toHaveLength(1);
    expect(value.routes[0]).toMatchObject({ key: "atlas-route:0", bundlePopulation: 2 });
    expect(value.routes[0]!.key).not.toContain("fixture_");
  });

  it("reserves a valid selected route discovered after more than eighty canonical secondary records", () => {
    const current = model(100, "cycle", "dependency");
    const selected = current.relations.at(-1)!.source;
    const value = planAtlasRoutes(current, layoutAtlas(current), { lens: "dependencies", selected });
    expect(value.routes.some((route) => route.source === selected || route.target === selected)).toBe(true);
    expect(value.routes[0]?.selected).toBe(true);
  });

  it("charges every traversed logical region and the caller viewport before admitting a route", () => {
    const current = model(25, "chain", "dependency");
    const layout = layoutAtlas(current);
    const shifted = { ...layout, points: layout.points.map((point, index) => index === 1 ? { ...point, x: 1216 } : point) };
    const value = planAtlasRoutes(current, shifted, { lens: "dependencies", viewport: { x: 590, y: -20, width: 540, height: 280 } });
    expect(value.metrics.maxRegionConnectors).toBeLessThanOrEqual(12);
    expect(value.metrics.maxRegionSegments).toBeLessThanOrEqual(36);
    expect(value.metrics.viewportConnectors).toBeLessThanOrEqual(24);
    expect(value.metrics.viewportSegments).toBeLessThanOrEqual(72);
  });

  it("fails closed before traversing oversized collections or accessor-backed evidence/layout data", () => {
    const current = model(2, "chain", "dependency");
    const oversized = { ...current, relations: Array.from({ length: 401 }, () => current.relations[0]!) };
    expect(planAtlasRoutes(oversized, layoutAtlas(oversized), { lens: "dependencies" }).routes).toEqual([]);
    const accessorRelation = { ...current.relations[0]!, get evidence() { throw new Error("must not read forged accessor"); } };
    const accessorModel = { ...current, relations: [accessorRelation] } as unknown as typeof current;
    expect(() => planAtlasRoutes(accessorModel, layoutAtlas(accessorModel), { lens: "dependencies" })).not.toThrow();
    const accessorLayout = { ...layoutAtlas(current), get points() { throw new Error("must not read forged accessor"); } } as unknown as ReturnType<typeof layoutAtlas>;
    expect(() => planAtlasRoutes(current, accessorLayout, { lens: "dependencies" })).not.toThrow();
  });
});
