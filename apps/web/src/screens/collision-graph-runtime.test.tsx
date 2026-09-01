import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { DockerSnapshot, RuntimeMap } from "@dockermap/contracts";
import { AppContext, type AppContextValue } from "../context";
import { buildModel } from "../lib/model";
import { COLLISION_HINT, COLLISION_TAG } from "../lib/identity";
import ServiceMap from "../components/ServiceMap";
import MapScreen from "./Map";
import RuntimeScreen from "./Runtime";
import ServiceDetail from "./ServiceDetail";

/**
 * Duplicate-identity fixture: two containers share the SAME id, two share the
 * SAME name (redaction-collided), and one is unique. Every occurrence must
 * stay visible on the graph and in the runtime list WITH the collision tag
 * and hint, and none of the collided occurrences may become a selectable
 * node (graph button or runtime row button). The first duplicate-id record
 * depends on the duplicate id itself, so the dependency list must show a
 * VISIBLE collision-tagged non-routable row for that raw occurrence. The
 * SECOND duplicate-id record depends on the UNIQUE `c_ok`: its source id is
 * ambiguous, so no semantic edge may render, no dependent attribution may
 * reach `c_ok`, and no spring may attach to either duplicate occurrence.
 */
const fixture: DockerSnapshot = {
  containers: [
    { id: "c_dup", name: "first", image: "busybox:1", status: "running", role: "", networks: [], ports: [], mounts: [], dependsOn: ["c_dup"] },
    { id: "c_dup", name: "second", image: "busybox:1", status: "running", role: "", networks: [], ports: [], mounts: [], dependsOn: ["c_ok"] },
    { id: "c_name1", name: "dup-name", image: "busybox:1", status: "running", role: "", networks: [], ports: [], mounts: [], dependsOn: [] },
    { id: "c_name2", name: "dup-name", image: "busybox:1", status: "running", role: "", networks: [], ports: [], mounts: [], dependsOn: [] },
    { id: "c_ok", name: "unique", image: "busybox:1", status: "running", role: "", networks: [], ports: [], mounts: [], dependsOn: [] }
  ],
  images: [],
  networks: [],
  volumes: [],
  modelRevision: "test-revision", lastUpdated: 0,
  };

const runtimeFixture: RuntimeMap = {
  nodes: [
    { id: "rt_dup", provider: "docker", type: "container", label: "first", status: "running", metadata: {} },
    { id: "rt_dup", provider: "docker", type: "container", label: "second", status: "running", metadata: {} },
    { id: "rt_ok", provider: "docker", type: "container", label: "unique", status: "running", metadata: {} }
  ],
  edges: [],
  diagnostics: [],
  providerStates: [],
    lastUpdated: 0,
  modelRevision: "test-revision"
  };

const model = buildModel(fixture, runtimeFixture);

const contextValue: AppContextValue = {
  model,
  modelProvenance: "live",
  loading: false,
  error: null,
  health: null,
  tick: 0,
  evidenceMode: "live",
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
    // Collided records stay visible in the directory as non-routable evidence.
    expect(html.split("identity collision").length - 1).toBeGreaterThanOrEqual(4);
    expect(html).toContain(COLLISION_HINT);
    // The graph's text alternative is scoped to graph-visible records; the
    // directory carries the collision names and individual explanatory hints.
    expect(html).not.toContain("Identity collision: first, second, dup-name");
    // ONLY the unique service is a selectable directory button.
    expect(html.match(/<button[^>]*class="runtime-node-btn/g) ?? []).toHaveLength(1);
    expect(html).toContain(">unique</span>");
    // Collided labels render as plain non-buttons.
    expect(html).not.toMatch(/<button[^>]*aria-label="(?:first|dup-name)/);
    // The default topology graph contains no semantic edge for this fixture.
    expect(html.split('class="edge-group"').length - 1).toBe(0);
    expect(html).toContain("No Compose start-order declarations are visible in this graph.");
  });

  it("ServiceMap gives duplicate-id occurrences DISTINCT in-viewport transforms", () => {
    // The layout is keyed by service OCCURRENCE: two records sharing the
    // canonical id `c_dup` must NOT share one SVG transform (the later node
    // used to paint over the earlier one at the exact same coordinate).
    // The reusable graph still supports the collision-safe full evidence view
    // when another screen deliberately asks for it.
    const html = renderToStaticMarkup(
      <AppContext.Provider value={contextValue}>
        <ServiceMap model={model} selectedId={null} onSelect={() => {}} interactive={false} />
      </AppContext.Provider>
    );
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
    // tag (baseline at center+30, 2px paint-order stroke) is fully visible
    // inside 0..240 — a node at the old ±1 extreme rendered its tag
    // off-viewport. The BROWSER-level regression (tests/e2e) additionally
    // measures every tag's transformed getBBox()+stroke bounds within 0..240.
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

  it("ServiceDetail highlights EXACTLY the intended occurrence of a duplicate id", () => {
    // The route identifies one of the two `c_dup` records by its UNIQUE name;
    // the embedded map must mark only that occurrence node-self — never both
    // (and never the first record for the second one). Node groups are
    // matched as whole <g class="node…">…</g> blocks (a plain split on
    // 'class="node' would be cut at the inner node-label text element).
    const nodeGroups = (html: string) => html.match(/<g class="node[^"]*"[^>]*>[\s\S]*?<\/g>/g) ?? [];
    const htmlFirst = renderScreen("/services/first", "/services/:name", <ServiceDetail defaultTab="overview" />);
    const selfFirst = nodeGroups(htmlFirst).filter((group) => group.includes("node-self"));
    expect(selfFirst).toHaveLength(1);
    expect(selfFirst[0]).toContain(">first<");

    const htmlSecond = renderScreen("/services/second", "/services/:name", <ServiceDetail defaultTab="overview" />);
    const selfSecond = nodeGroups(htmlSecond).filter((group) => group.includes("node-self"));
    expect(selfSecond).toHaveLength(1);
    expect(selfSecond[0]).toContain(">second<");
    // The other duplicate occurrence is never marked selected…
    expect(selfSecond[0]).not.toContain(">first<");
    // …and the impact banner names the EXACT occurrence too — never the byId
    // lookup, which EXCLUDES collided ids and would label the highlighted
    // node "anonymous" while the map highlights it.
    const bannerOf = (html: string) => html.match(/<span class="map-impact-kind">[\s\S]*?<\/span>/)?.[0] ?? "";
    expect(bannerOf(htmlFirst)).toContain(">first<");
    expect(bannerOf(htmlFirst)).not.toContain(">second<");
    expect(bannerOf(htmlSecond)).toContain(">second<");
    expect(bannerOf(htmlSecond)).not.toContain(">first<");
    expect(bannerOf(htmlSecond)).not.toContain("anonymous");
    // The embedded map is read-only (no interactive buttons at all); the
    // duplicate nodes' non-selectability on the INTERACTIVE map is asserted
    // by the MapScreen regression (exactly one role="button" — the unique
    // service — even with a selection present).
    expect(htmlSecond.split('role="button"').length - 1).toBe(0);
  });

  it("suppresses the selected state for an id-only selection of a collided id", () => {
    // Without an exact occurrence (selectedService), a collided id cannot
    // identify one record — NO node may receive node-self; the selection is
    // suppressed instead of highlighting every occurrence.
    const html = renderToStaticMarkup(
      <AppContext.Provider value={contextValue}>
        <ServiceMap model={model} selectedId="c_dup" onSelect={() => {}} interactive={false} />
      </AppContext.Provider>
    );
    expect(html.split("node-self").length - 1).toBe(0);
    // A UNIQUE id still selects normally through the first-occurrence map.
    const htmlUnique = renderToStaticMarkup(
      <AppContext.Provider value={contextValue}>
        <ServiceMap model={model} selectedId="c_ok" onSelect={() => {}} interactive={false} />
      </AppContext.Provider>
    );
    expect(htmlUnique.split("node-self").length - 1).toBe(1);
    expect(htmlUnique).toContain("node-self");
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
