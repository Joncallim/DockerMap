// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppContext, type AppContextValue } from "../context";
import { collisionFixture, mutateStateOnly, runtimeFixture } from "../lib/atlas/fixtures";
import { projectRuntimeMap } from "../lib/atlas/project";
import AtlasOverview from "./AtlasOverview";

function envelope(subjects = 5) {
  return projectRuntimeMap(runtimeFixture(subjects, "chain", "dependency"));
}

function context(atlas = envelope()): AppContextValue {
  return { model: null, atlas, modelProvenance: null, loading: false, error: null, health: null, tick: 0, evidenceMode: null, openCommand: () => {} };
}

function markup(value: AppContextValue): string {
  return renderToStaticMarkup(<AppContext.Provider value={value}><MemoryRouter initialEntries={["/atlas"]}><AtlasOverview /></MemoryRouter></AppContext.Provider>);
}

function mounted(value: AppContextValue, path = "/atlas") {
  return <AppContext.Provider value={value}><MemoryRouter initialEntries={[path]}><Routes><Route path="/atlas" element={<AtlasOverview />} /></Routes></MemoryRouter></AppContext.Provider>;
}

describe("AtlasOverview", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses only the coherent Atlas envelope and makes no screen fetch", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const html = markup(context());
    expect(fetch).not.toHaveBeenCalled();
    expect(html).toContain("Atlas Overview");
    expect(html).toContain("data-atlas-renderer=\"svg-html-hybrid\"");
    expect(html).toContain("relations and attachments remain suppressed");
    expect(html).not.toContain("runtime_subject_");
  });

  it("renders an explicit non-invented empty orientation", () => {
    const html = markup(context(projectRuntimeMap(runtimeFixture(0))));
    expect(html).toContain("No observed subjects");
    expect(html).toContain("No topology has been invented");
  });

  it("keeps collisions visible but disabled and never exposes their source identity", () => {
    const html = markup(context(projectRuntimeMap(collisionFixture())));
    expect(html).toContain("Ambiguous runtime identity");
    expect(html).toContain("Not selectable");
    expect(html).not.toContain("docker_container_container_000");
  });

  it("puts the fixed non-colour marker vocabulary into the narrow text alternative", () => {
    const atlas = envelope(1);
    const marked = {
      ...atlas,
      model: { ...atlas.model, subjects: atlas.model.subjects.map((subject) => ({ ...subject, attention: "warning" as const, freshness: "stale" as const, ambiguity: "unsupported" as const })) }
    };
    const html = markup(context(marked));
    expect(html).toContain("warning attention, unsupported identity, healthy, stale observation");
    expect(html).not.toContain("runtime_subject_");
  });

  it.each([25, 100, 250])("holds the bounded %i-subject directory without default edge spaghetti", (count) => {
    const html = markup(context(envelope(count)));
    expect((html.match(/data-atlas-subject/g) ?? [])).toHaveLength(count);
    expect(html).not.toContain("data-atlas-relation");
    expect(html).not.toContain("data-atlas-attachment");
  });

  it("uses a bounded URL-backed aggregate expansion without claiming inferred topology", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root: Root = createRoot(host);
    const aggregateAtlas = projectRuntimeMap(runtimeFixture(10, "outbound_star", "network"));
    await act(async () => root.render(mounted(context(aggregateAtlas))));
    const control = host.querySelector<HTMLButtonElement>(".atlas-context-expansions button")!;
    expect(control.getAttribute("aria-label")).toBe("Recorded context coverage 1 of 1");
    await act(async () => control.click());
    expect(control.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector("[data-atlas-expanded=aggregate]")?.textContent).toContain("resolved context records");
    expect(host.textContent).toContain("not inferred topology or causality");
    await act(async () => root.unmount());
    host.remove();
  });

  it("names multiple aggregate controls by stable ordinal and count without exposing their keys", () => {
    const base = projectRuntimeMap(runtimeFixture(10, "outbound_star", "network"));
    const first = base.model.aggregates[0]!;
    const second = { ...first, key: "atlas:attachment-aggregate:1" as typeof first.key };
    const html = markup(context({ ...base, model: { ...base.model, aggregates: [first, second] } }));
    expect(html).toContain('aria-label="Recorded context coverage 1 of 2"');
    expect(html).toContain('aria-label="Recorded context coverage 2 of 2"');
    expect(html).not.toContain("attachment-aggregate");
  });

  it("focuses URL-expanded aggregate content instead of a selected subject", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root: Root = createRoot(host);
    const aggregateAtlas = projectRuntimeMap(runtimeFixture(10, "outbound_star", "network"));
    const aggregate = aggregateAtlas.model.aggregates[0]!.key;
    await act(async () => root.render(mounted(context(aggregateAtlas), `/atlas?expand=${encodeURIComponent(aggregate)}`)));
    const expanded = host.querySelector<HTMLElement>("[data-atlas-expanded=aggregate]")!;
    expect(document.activeElement).toBe(expanded);
    expect(host.querySelector(".atlas-subject.is-selected")).toBeNull();
    await act(async () => root.unmount());
    host.remove();
  });

  it("keeps long names bounded while exposing the complete projected safe display in text", () => {
    const input = runtimeFixture(3);
    input.nodes[2] = { ...input.nodes[2]!, label: `safe ${"label ".repeat(120)}` };
    const html = markup(context(projectRuntimeMap(input)));
    expect(html).toContain("safe label");
    expect(html).toContain("…");
    expect(html).not.toContain("label label label label label label label label label label label label label label label label label label label");
  });

  it("selects only a routable directory subject and mirrors its marker text in the inspector", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root: Root = createRoot(host);
    await act(async () => root.render(mounted(context())));
    const first = host.querySelector<HTMLButtonElement>(".atlas-directory button:not(:disabled)")!;
    await act(async () => first.click());
    expect(host.querySelector(".atlas-inspector")?.textContent).toContain("no attention");
    await act(async () => root.unmount());
    host.remove();
  });

  it("keeps attention, ambiguity, operational state, and freshness visible as four independent inspector labels", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root: Root = createRoot(host);
    const atlas = envelope(1);
    const orthogonal = {
      ...atlas,
      model: { ...atlas.model, subjects: atlas.model.subjects.map((subject) => ({ ...subject, attention: "advisory" as const, ambiguity: "unresolved" as const, operationalState: "updating" as const, freshness: "unavailable" as const })) }
    };
    await act(async () => root.render(mounted(context(orthogonal))));
    await act(async () => host.querySelector<HTMLButtonElement>(".atlas-directory button:not(:disabled)")!.click());
    const inspector = host.querySelector(".atlas-inspector")?.textContent ?? "";
    expect(inspector).toContain("advisory attention, unresolved identity, updating, unavailable observation");
    expect(inspector).not.toContain("degraded");
    await act(async () => root.unmount());
    host.remove();
  });

  it("discloses only selected evidence-backed non-causal local context to keyboard selection", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root: Root = createRoot(host);
    const local = projectRuntimeMap(runtimeFixture(5, "outbound_star", "network"));
    await act(async () => root.render(mounted(context(local))));
    await act(async () => host.querySelector<HTMLButtonElement>(".atlas-directory button:not(:disabled)")!.click());
    const inspector = host.querySelector(".atlas-inspector")!;
    expect(inspector.textContent).toContain("Recorded local context");
    expect(inspector.textContent).toContain("Recorded network membership");
    expect(inspector.textContent).toContain("do not establish communication, data direction, host exposure, reachability, or ownership");
    expect(inspector.textContent).not.toContain("0.0.0.0");
    await act(async () => root.unmount());
    host.remove();
  });

  it("keeps attention, operational state, and freshness independent in selected local-rail item text", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root: Root = createRoot(host);
    const atlas = projectRuntimeMap(runtimeFixture(2, "outbound_star", "network"));
    const contextKey = atlas.model.attachments[0]!.context;
    const marked = {
      ...atlas,
      model: { ...atlas.model, subjects: atlas.model.subjects.map((subject) => subject.key === contextKey
        ? { ...subject, attention: "advisory" as const, operationalState: "updating" as const, freshness: "unavailable" as const }
        : subject) }
    };
    await act(async () => root.render(mounted(context(marked))));
    await act(async () => host.querySelector<HTMLButtonElement>(".atlas-directory button:not(:disabled)")!.click());
    const rail = host.querySelector(".atlas-local-context")?.textContent ?? "";
    expect(rail).toContain("advisory attention, unambiguous identity, updating, unavailable observation");
    await act(async () => root.unmount());
    host.remove();
  });

  it("recovers focus to the directory when a selected subject disappears in a replacement revision", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root: Root = createRoot(host);
    const initial = context(envelope(2));
    const selectedKey = initial.atlas!.model.subjects.find((subject) => subject.routability === "routable")!.key;
    await act(async () => root.render(mounted(initial, `/atlas?subject=${selectedKey}`)));
    expect(host.querySelector(".atlas-inspector")?.textContent).not.toContain("Select a subject");
    expect(host.querySelector(".atlas-subject.is-selected")).not.toBeNull();
    const replacement = projectRuntimeMap(collisionFixture());
    const revised = { ...replacement, sourceRevision: "replacement-r2" };
    await act(async () => root.render(mounted(context(revised), `/atlas?subject=${selectedKey}`)));
    expect(document.activeElement).toBe(host.querySelector(".atlas-directory"));
    expect(host.querySelector(".atlas-inspector")?.textContent).toContain("Select a subject");
    expect(host.querySelector(".atlas-route-status")?.textContent).toContain("unavailable");
    await act(async () => root.unmount());
    host.remove();
  });

  it("keeps the exact viewport transform and surviving selection through coherent revision classes", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root: Root = createRoot(host);
    const baseInput = runtimeFixture(5, "chain", "dependency");
    const base = projectRuntimeMap(baseInput);
    const selected = base.model.subjects.find((subject) => subject.routability === "routable")!.key;
    const relationOnly = projectRuntimeMap({ ...baseInput, edges: [] });
    const unrelatedStructural = projectRuntimeMap({
      ...baseInput,
      nodes: [...baseInput.nodes, {
        id: "host_refresh_context", provider: "host", type: "host", layer: "host", label: "refresh context", status: "running", metadata: {}
      }]
    });
    const stateOnly = projectRuntimeMap(mutateStateOnly(baseInput));
    await act(async () => root.render(mounted(context(base), `/atlas?subject=${selected}`)));
    const transform = () => host.querySelector<SVGGElement>(".atlas-canvas > g")!.getAttribute("transform");
    const initialTransform = transform();

    for (const revision of [stateOnly, relationOnly, unrelatedStructural]) {
      await act(async () => root.render(mounted(context(revision), `/atlas?subject=${selected}`)));
      expect(transform()).toBe(initialTransform);
      expect(host.querySelector(".atlas-subject.is-selected")).not.toBeNull();
    }

    await act(async () => root.unmount());
    host.remove();
  });
});
