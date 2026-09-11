// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { collisionFixture, runtimeFixture } from "../fixtures";
import { layoutAtlas } from "../layout";
import { projectRuntimeMap } from "../project";
import { RendererHarness } from "./RendererHarness";
import { ATLAS_COMPARISON_SUBJECT_COUNTS, hasFiniteRendererSamples, recordRendererComparison, rendererMetrics, type AtlasRendererComparisonRecord } from "./metrics";
import type { AtlasRendererCandidate } from "./policy";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
let root: Root | null = null;

function props(count: number, topology: Parameters<typeof runtimeFixture>[1] = "chain", evidence: Parameters<typeof runtimeFixture>[2] = "dependency") {
  const model = projectRuntimeMap(runtimeFixture(count, topology, evidence)).model;
  return { model, layout: layoutAtlas(model), camera: { x: 0, y: 0, zoom: 1 } };
}

function mount(candidate: AtlasRendererCandidate, rendered = props(25), onSelect?: (key: string) => void): HTMLDivElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<RendererHarness candidate={candidate} {...rendered} onSelect={onSelect} />));
  return host;
}

function measure(name: string, start: string, end: string): number {
  const value = globalThis.performance.measure(name, start, end).duration;
  globalThis.performance.clearMarks(start);
  globalThis.performance.clearMarks(end);
  globalThis.performance.clearMeasures(name);
  return value;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

describe("Atlas renderer controlled mounted harness", () => {
  it.each([25, 100, 250])("caps native/hybrid subject DOM at %i deterministic subjects", (count) => {
    for (const candidate of ["native_svg", "svg_html_hybrid"] as const) {
      const rendered = props(count);
      const container = mount(candidate, rendered);
      const visualCount = candidate === "native_svg"
        ? container.querySelectorAll("[data-atlas-subject]").length
        : container.querySelectorAll("[data-atlas-renderer='svg-html-hybrid'] li").length;
      const metrics = rendererMetrics(candidate, rendered.model, rendered.layout);
      expect(visualCount).toBe(count);
      expect(container.querySelectorAll("svg [data-atlas-subject]")).toHaveLength(metrics.subjectVisuals);
      expect(container.querySelectorAll("svg [data-atlas-relation]")).toHaveLength(metrics.visibleRelations);
      expect(container.querySelectorAll("svg [data-atlas-attachment]")).toHaveLength(metrics.visibleAttachments);
      const transforms = [...container.querySelectorAll("[data-atlas-subject]")].map((node) => node.getAttribute("transform"));
      if (candidate === "native_svg") {
        act(() => root!.render(<RendererHarness candidate="native_svg" {...rendered} />));
        expect([...container.querySelectorAll("[data-atlas-subject]")].map((node) => node.getAttribute("transform"))).toEqual(transforms);
      }
      act(() => root?.unmount());
      host?.remove();
      host = null;
      root = null;
    }
  });

  it("enforces local subject and layout-point caps before DOM indexing", () => {
    const base = props(250);
    const oversized = {
      ...base,
      model: { ...base.model, subjects: [...base.model.subjects, ...base.model.subjects] },
      layout: { ...base.layout, points: [...base.layout.points, ...base.layout.points] }
    };
    const container = mount("svg_html_hybrid", oversized);
    expect(container.querySelectorAll("[data-atlas-renderer='svg-html-hybrid'] li")).toHaveLength(250);
  });

  it("preserves visual geometry for state-only mutation and local-only layout anchors", () => {
    const first = props(25);
    const container = mount("native_svg", first);
    const before = [...container.querySelectorAll("[data-atlas-subject]")].map((node) => node.getAttribute("transform"));
    const changed = {
      ...first,
      model: { ...first.model, subjects: first.model.subjects.map((subject, index) => index === 0 ? { ...subject, operationalState: "degraded" as const } : subject) }
    };
    act(() => root!.render(<RendererHarness candidate="native_svg" {...changed} />));
    const after = [...container.querySelectorAll("[data-atlas-subject]")].map((node) => node.getAttribute("transform"));
    expect(after).toEqual(before);
    const local = props(26);
    act(() => root!.render(<RendererHarness candidate="native_svg" {...local} />));
    expect([...container.querySelectorAll("[data-atlas-subject]")].slice(0, 25).map((node) => node.getAttribute("transform"))).toEqual(before);
  });

  it("supports HTML directory keyboard selection/focus and nonroutable disabling", () => {
    const selected: string[] = [];
    const container = mount("svg_html_hybrid", props(25), (key) => selected.push(key));
    const button = container.querySelector("button")!;
    button.focus();
    expect(document.activeElement).toBe(button);
    act(() => button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(selected).toEqual(["docker_container_container_000"]);
    act(() => root?.unmount());
    container.remove();
    host = null;
    root = null;

    const collisionModel = projectRuntimeMap(collisionFixture()).model;
    const collisionHost = mount("svg_html_hybrid", { model: collisionModel, layout: layoutAtlas(collisionModel), camera: { x: 0, y: 0, zoom: 1 } });
    expect(collisionHost.querySelectorAll("button:disabled").length).toBeGreaterThan(0);
  });

  it("renders actual attachment cap and bounded long labels", () => {
    const base = props(100, "outbound_star", "network");
    const fixtureMetrics = rendererMetrics("svg_html_hybrid", base.model, base.layout);
    expect(fixtureMetrics).toMatchObject({ subjectVisuals: 100, visibleRelations: 0, visibleAttachments: 8 });
    const fixtureHybrid = mount("svg_html_hybrid", base);
    expect(fixtureHybrid.querySelectorAll("svg [data-atlas-subject]")).toHaveLength(fixtureMetrics.subjectVisuals);
    expect(fixtureHybrid.querySelectorAll("svg [data-atlas-relation]")).toHaveLength(fixtureMetrics.visibleRelations);
    expect(fixtureHybrid.querySelectorAll("svg [data-atlas-attachment]")).toHaveLength(fixtureMetrics.visibleAttachments);
    act(() => root?.unmount());
    fixtureHybrid.remove();
    host = null;
    root = null;
    const attachment = base.model.attachments[0]!;
    const rendered = { ...base, model: { ...base.model, attachments: Array.from({ length: 100 }, () => attachment) } };
    const expected = rendererMetrics("native_svg", rendered.model, rendered.layout).visibleAttachments;
    const container = mount("native_svg", rendered);
    expect(expected).toBe(80);
    expect(container.querySelectorAll("[data-atlas-attachment]")).toHaveLength(expected);
    act(() => root?.unmount());
    container.remove();
    host = null;
    root = null;
    const hybrid = mount("svg_html_hybrid", rendered);
    expect(hybrid.querySelectorAll("svg [data-atlas-attachment]")).toHaveLength(expected);
    act(() => root?.unmount());
    hybrid.remove();
    host = null;
    root = null;
    const labelsContainer = mount("native_svg", base);
    const labels = [...labelsContainer.querySelectorAll("text")].map((node) => node.textContent ?? "");
    expect(labels.every((label) => Array.from(label).length <= 96 || label.includes("resolved attachments"))).toBe(true);
    act(() => root?.unmount());
    labelsContainer.remove();
    host = null;
    root = null;
    const long = props(1);
    long.model = { ...long.model, subjects: long.model.subjects.map((subject) => ({ ...subject, display: "x".repeat(20_000) })) };
    const longHost = mount("native_svg", long);
    expect(Array.from(longHost.querySelector("text")?.textContent ?? "").length).toBeLessThanOrEqual(96);
  });

  // This intentionally performs 192 React operations (warmup plus 15 samples
  // for six comparison cells); allow slower CI runners without weakening it.
  it("records fifteen warmed projection, layout, mount, and update samples for every comparison cell", () => {
    const records: AtlasRendererComparisonRecord[] = [];
    for (const subjectCount of ATLAS_COMPARISON_SUBJECT_COUNTS) for (const candidate of ["native_svg", "svg_html_hybrid"] as const) {
      const samples = [];
      for (let iteration = 0; iteration <= 15; iteration += 1) {
        const prefix = `atlas-${candidate}-${subjectCount}-${iteration}`;
        globalThis.performance.mark(`${prefix}-projection-start`);
        const model = projectRuntimeMap(runtimeFixture(subjectCount, "chain", "dependency")).model;
        globalThis.performance.mark(`${prefix}-projection-end`);
        const projectionMs = measure(`${prefix}-projection`, `${prefix}-projection-start`, `${prefix}-projection-end`);
        globalThis.performance.mark(`${prefix}-layout-start`);
        const layout = layoutAtlas(model);
        globalThis.performance.mark(`${prefix}-layout-end`);
        const layoutMs = measure(`${prefix}-layout`, `${prefix}-layout-start`, `${prefix}-layout-end`);
        host = document.createElement("div");
        document.body.append(host);
        root = createRoot(host);
        const rendered = { model, layout, camera: { x: 0, y: 0, zoom: 1 } };
        globalThis.performance.mark(`${prefix}-mount-start`);
        act(() => root!.render(<RendererHarness candidate={candidate} {...rendered} />));
        globalThis.performance.mark(`${prefix}-mount-end`);
        const mountMs = measure(`${prefix}-mount`, `${prefix}-mount-start`, `${prefix}-mount-end`);
        globalThis.performance.mark(`${prefix}-update-start`);
        act(() => root!.render(<RendererHarness candidate={candidate} {...rendered} selectedKey={model.subjects[0]?.key ?? null} />));
        globalThis.performance.mark(`${prefix}-update-end`);
        const updateMs = measure(`${prefix}-update`, `${prefix}-update-start`, `${prefix}-update-end`);
        act(() => root?.unmount());
        host.remove();
        host = null;
        root = null;
        if (iteration > 0) samples.push({ projectionMs, layoutMs, mountMs, updateMs });
      }
      records.push(recordRendererComparison(candidate, subjectCount, samples));
    }
    expect(records).toHaveLength(ATLAS_COMPARISON_SUBJECT_COUNTS.length * 2);
    expect(records.every(hasFiniteRendererSamples)).toBe(true);
  }, 20_000);
});
