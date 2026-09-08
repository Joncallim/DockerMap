// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppContext, type AppContextValue } from "../context";
import { collisionFixture, runtimeFixture } from "../lib/atlas/fixtures";
import { projectRuntimeMap } from "../lib/atlas/project";
import AtlasOverview from "./AtlasOverview";

function envelope(subjects = 5) {
  return projectRuntimeMap(runtimeFixture(subjects, "chain", "dependency"));
}

function context(atlas = envelope()): AppContextValue {
  return { model: null, atlas, modelProvenance: null, loading: false, error: null, health: null, tick: 0, evidenceMode: null, openCommand: () => {} };
}

function markup(value: AppContextValue): string {
  return renderToStaticMarkup(<AppContext.Provider value={value}><AtlasOverview /></AppContext.Provider>);
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
    await act(async () => root.render(<AppContext.Provider value={context()}><AtlasOverview /></AppContext.Provider>));
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
    await act(async () => root.render(<AppContext.Provider value={context(orthogonal)}><AtlasOverview /></AppContext.Provider>));
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
    await act(async () => root.render(<AppContext.Provider value={context(local)}><AtlasOverview /></AppContext.Provider>));
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
    await act(async () => root.render(<AppContext.Provider value={context(marked)}><AtlasOverview /></AppContext.Provider>));
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
    await act(async () => root.render(<AppContext.Provider value={initial}><AtlasOverview /></AppContext.Provider>));
    await act(async () => host.querySelector<HTMLButtonElement>(".atlas-directory button:not(:disabled)")!.click());
    const replacement = projectRuntimeMap(collisionFixture());
    const revised = { ...replacement, sourceRevision: "replacement-r2" };
    await act(async () => root.render(<AppContext.Provider value={context(revised)}><AtlasOverview /></AppContext.Provider>));
    expect(document.activeElement).toBe(host.querySelector(".atlas-directory"));
    expect(host.querySelector(".atlas-inspector")?.textContent).toContain("Select a subject");
    await act(async () => root.unmount());
    host.remove();
  });
});
