import { describe, expect, it } from "vitest";
import { atlasLensView, isAtlasLens } from "./lens";
import { runtimeFixture } from "./fixtures";
import { layoutAtlas } from "./layout";
import { projectRuntimeMap } from "./project";

describe("Atlas lens selector", () => {
  const model = projectRuntimeMap(runtimeFixture(10, "outbound_star", "network")).model;
  const layout = layoutAtlas(model);

  it("uses only the bounded Atlas model/layout planner and keeps overview/runtime/attention route-free", () => {
    for (const lens of ["overview", "runtime", "attention"] as const) {
      expect(atlasLensView(model, layout, lens).routes.routes).toEqual([]);
    }
  });

  it("keeps the supported query vocabulary closed and distinguishes attachment lenses", () => {
    expect(isAtlasLens("dependencies")).toBe(true);
    expect(isAtlasLens("camera")).toBe(false);
    expect(atlasLensView(model, layout, "connectivity").routes.routes.every((route) => route.routeClass !== "declaration" && route.routeClass !== "storage_attachment")).toBe(true);
    expect(atlasLensView(model, layout, "storage").routes.routes.every((route) => route.routeClass === "storage_attachment")).toBe(true);
  });
});
