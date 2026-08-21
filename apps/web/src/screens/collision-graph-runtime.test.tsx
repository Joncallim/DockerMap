import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { DockerSnapshot, RuntimeMap } from "@dockermap/contracts";
import { AppContext, type AppContextValue } from "../context";
import { buildModel } from "../lib/model";
import { COLLISION_HINT, COLLISION_TAG } from "../lib/identity";
import MapScreen from "./Map";
import RuntimeScreen from "./Runtime";
import ServiceDetail from "./ServiceDetail";

/**
 * Duplicate-identity fixture: two containers share the SAME id, two share the
 * SAME name (redaction-collided), and one is unique. Every occurrence must
 * stay visible on the graph and in the runtime list WITH the collision tag
 * and hint, and none of the collided occurrences may become a selectable
 * node (graph button or runtime row button). The first duplicate-id record
 * also depends on the duplicate id itself, so the dependency list must show
 * a VISIBLE collision-tagged non-routable row for that raw occurrence.
 */
const fixture: DockerSnapshot = {
  containers: [
    { id: "c_dup", name: "first", image: "busybox:1", status: "running", role: "", networks: [], ports: [], mounts: [], dependsOn: ["c_dup"] },
    { id: "c_dup", name: "second", image: "busybox:1", status: "running", role: "", networks: [], ports: [], mounts: [], dependsOn: [] },
    { id: "c_name1", name: "dup-name", image: "busybox:1", status: "running", role: "", networks: [], ports: [], mounts: [], dependsOn: [] },
    { id: "c_name2", name: "dup-name", image: "busybox:1", status: "running", role: "", networks: [], ports: [], mounts: [], dependsOn: [] },
    { id: "c_ok", name: "unique", image: "busybox:1", status: "running", role: "", networks: [], ports: [], mounts: [], dependsOn: [] }
  ],
  images: [],
  networks: [],
  volumes: [],
  lastUpdated: 0
};

const runtimeFixture: RuntimeMap = {
  nodes: [
    { id: "rt_dup", provider: "docker", type: "container", label: "first", status: "running", metadata: {} },
    { id: "rt_dup", provider: "docker", type: "container", label: "second", status: "running", metadata: {} },
    { id: "rt_ok", provider: "docker", type: "container", label: "unique", status: "running", metadata: {} }
  ],
  edges: [],
  diagnostics: [],
  lastUpdated: 0
};

const model = buildModel(fixture, runtimeFixture);

const contextValue: AppContextValue = {
  model,
  loading: false,
  error: null,
  health: null,
  tick: 0,
  openCommand: () => {}
};

function renderScreen(initialPath: string, route: string, element: ReactElement) {
  return renderToStaticMarkup(
    <AppContext.Provider value={contextValue}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path={route} element={element} />
        </Routes>
      </MemoryRouter>
    </AppContext.Provider>
  );
}

describe("collision tags on graph nodes and runtime rows", () => {
  it("ServiceMap keeps collided id/name nodes visible with a tag and hint, never interactive", () => {
    expect(model.serviceIdCollisions.has("c_dup")).toBe(true);
    expect(model.serviceNameCollisions.has("dup-name")).toBe(true);

    const html = renderScreen("/map", "/map", <MapScreen />);
    // Every collided occurrence carries the visible "identity collision" tag
    // (4 collided nodes → 4 tag texts)…
    expect(html.split("identity collision").length - 1).toBeGreaterThanOrEqual(4);
    // …the accessible explanatory text is present (per-node <title> AND the
    // relationship text alternative)…
    expect(html.split(COLLISION_HINT).length - 1).toBeGreaterThanOrEqual(1);
    expect(html).toContain("Identity collision: first, second, dup-name");
    // …the dashed-ring collision treatment class is applied to each node…
    expect(html.split("node-collided").length - 1).toBeGreaterThanOrEqual(4);
    // …and ONLY the unique service is a selectable graph button.
    expect(html.split('role="button"').length - 1).toBe(1);
    expect(html).toContain('aria-label="unique, healthy"');
    // Collided labels render as plain text, not buttons.
    expect(html).not.toContain('aria-label="first, healthy"');
    expect(html).not.toContain('aria-label="dup-name, healthy"');
  });

  it("ServiceMap gives duplicate-id occurrences DISTINCT in-viewport transforms", () => {
    // The layout is keyed by service OCCURRENCE: two records sharing the
    // canonical id `c_dup` must NOT share one SVG transform (the later node
    // used to paint over the earlier one at the exact same coordinate).
    const html = renderScreen("/map", "/map", <MapScreen />);
    const chunks = html.split('<g class="node').slice(1);
    expect(chunks.length).toBe(5);
    const nodes = chunks.map((chunk) => {
      const transform = chunk.match(/^[^>]*transform="translate\(([-\d.]+) ([-\d.]+)\)"/);
      expect(transform, `node group missing transform in: ${chunk.slice(0, 120)}`).not.toBeNull();
      return { x: Number(transform![1]), y: Number(transform![2]), label: chunk.includes(">first<") ? "first" : chunk.includes(">second<") ? "second" : chunk.includes(">unique<") ? "unique" : "other" };
    });
    // Every occurrence (including both `c_dup` records) gets its own
    // coordinate — no two nodes share a transform.
    const coords = nodes.map((node) => `${node.x},${node.y}`);
    expect(new Set(coords).size).toBe(5);
    const first = nodes.find((node) => node.label === "first")!;
    const second = nodes.find((node) => node.label === "second")!;
    expect(`${first.x},${first.y}`).not.toBe(`${second.x},${second.y}`);
    // All nodes sit inside the 240×240 viewBox within the collision-tag-safe
    // margin: centers stay within [30, 210], so the 6px "identity collision"
    // tag (baseline at center+30, ~30px half-width) is fully visible inside
    // 0..240 — a node at the old ±1 extreme rendered its tag off-viewport.
    for (const node of nodes) {
      expect(node.x).toBeGreaterThanOrEqual(30);
      expect(node.x).toBeLessThanOrEqual(210);
      expect(node.y).toBeGreaterThanOrEqual(30);
      expect(node.y).toBeLessThanOrEqual(210);
    }
  });

  it("ServiceDetail shows a collision-tagged non-routable row for a duplicate container_* dependency", () => {
    const html = renderScreen("/services/first", "/services/:name", <ServiceDetail defaultTab="dependencies" />);
    // The raw occurrence `c_dup` (a duplicate canonical id) stays VISIBLE…
    expect(html).toContain(">c_dup</span>");
    // …carries the collision tag, hint, and treatment class…
    expect(html).toContain(COLLISION_TAG);
    expect(html).toContain(COLLISION_HINT);
    expect(html).toContain('class="svc-name collision-identity"');
    // …and is NON-ROUTABLE: no detail link may point at the ambiguous id.
    expect(html).not.toContain('href="/services/c_dup"');
  });

  it("Runtime keeps collided id rows visible with a tag and hint, never selectable", () => {
    expect(model.runtime.idCollisions.has("rt_dup")).toBe(true);

    const html = renderScreen("/runtime", "/runtime", <RuntimeScreen />);
    // Both collided rows render with the visible tag…
    expect(html.split("identity collision").length - 1).toBeGreaterThanOrEqual(2);
    // …each carries the hint in its title AND its unavailable-for-selection
    // accessible name…
    expect(html.split(COLLISION_HINT).length - 1).toBeGreaterThanOrEqual(2);
    expect(html).toContain("first is unavailable for selection");
    expect(html).toContain("second is unavailable for selection");
    // …and only the unique node is a selectable runtime-node button; the
    // collided rows are non-interactive divs.
    expect(html.split('class="runtime-node-btn"').length - 1).toBe(1);
    expect(html.split('class="runtime-node-btn runtime-node-unresolved"').length - 1).toBe(2);
  });
});
