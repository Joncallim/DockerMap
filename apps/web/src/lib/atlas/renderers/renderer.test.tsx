import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { collisionFixture, runtimeFixture } from "../fixtures";
import { layoutAtlas } from "../layout";
import { projectRuntimeMap } from "../project";
import { HybridAtlas } from "./HybridAtlas";
import { rendererMetrics } from "./metrics";
import { NativeSvgAtlas } from "./NativeSvgAtlas";
import { nextRoutableSubjectKey } from "./shared";

function fixture(count = 5) {
  const model = projectRuntimeMap(runtimeFixture(count, "chain", "dependency")).model;
  return { model, layout: layoutAtlas(model), camera: { x: 0, y: 0, zoom: 1 } };
}

describe("Atlas renderer comparison spike", () => {
  it("keeps the native SVG baseline dependency-free and deterministic", () => {
    const props = fixture();
    const first = renderToStaticMarkup(<NativeSvgAtlas {...props} />);
    const second = renderToStaticMarkup(<NativeSvgAtlas {...props} />);
    expect(first).toBe(second);
    expect(first).toContain('data-atlas-renderer="native-svg"');
    expect(first).toContain('role="button"');
    expect(first).not.toContain("docker_container_container_000");
    expect(first).not.toContain("atlas:lane");
  });

  it("assigns deterministic unique marker ids to simultaneous native instances", () => {
    const props = fixture();
    const html = renderToStaticMarkup(<><NativeSvgAtlas {...props} /><NativeSvgAtlas {...props} /></>);
    const markerIds = [...html.matchAll(/<marker id="([^"]+)"/g)].map((match) => match[1]);
    expect(markerIds).toHaveLength(2);
    expect(new Set(markerIds).size).toBe(2);
    for (const markerId of markerIds) expect(html).toContain(`url(#${markerId})`);
  });

  it("uses the same canonical semantic subjects for hybrid visual and keyboard directory", () => {
    const props = fixture();
    const html = renderToStaticMarkup(<HybridAtlas {...props} selectedKey="docker_container_container_001" />);
    expect(html).toContain('data-atlas-renderer="svg-html-hybrid"');
    expect(html).toContain('aria-label="Atlas directory"');
    expect(html).toContain('aria-current="true"');
    expect((html.match(/container-[0-9]/g) ?? []).length).toBeGreaterThanOrEqual(props.model.subjects.length * 2);
    expect(nextRoutableSubjectKey(props.model, "docker_container_container_000", 1)).toBe("docker_container_container_001");
    expect(nextRoutableSubjectKey(props.model, "docker_container_container_000", -1)).toBe("docker_container_container_004");
  });

  it("makes collision subjects visible but noninteractive in both candidates", () => {
    const model = projectRuntimeMap(collisionFixture()).model;
    const props = { model, layout: layoutAtlas(model), camera: { x: 0, y: 0, zoom: 1 } };
    const native = renderToStaticMarkup(<NativeSvgAtlas {...props} />);
    const hybrid = renderToStaticMarkup(<HybridAtlas {...props} />);
    expect(native).toContain("Ambiguous runtime identity");
    expect(native).toContain('aria-disabled="true"');
    expect(hybrid).toContain("disabled");
    expect(hybrid).not.toContain("docker_container_container_000");
  });

  it("renders bounded projected display text rather than raw source labels or ids", () => {
    const source = runtimeFixture(1);
    source.nodes[0] = { ...source.nodes[0]!, label: `visible ${"long ".repeat(80)}` };
    const model = projectRuntimeMap(source).model;
    const subject = model.subjects[0]!;
    // This mutates a source ref only to prove renderer inputs never expose it.
    if (subject.routability === "routable") (subject.source as { nodeId: string }).nodeId = "raw-source-id-should-never-render";
    const html = renderToStaticMarkup(<HybridAtlas model={model} layout={layoutAtlas(model)} camera={{ x: 0, y: 0, zoom: 1 }} />);
    expect(html).toContain(subject.display);
    expect(html).not.toContain("raw-source-id-should-never-render");
    expect(html).not.toContain("long long long long long long long long long long long long long long long long long long long long");
  });

  it("caps relation/attachment comparison metrics and keeps lanes presentation-only", () => {
    const model = projectRuntimeMap(runtimeFixture(100, "outbound_star", "network")).model;
    const layout = layoutAtlas(model);
    const native = rendererMetrics("native_svg", model, layout);
    const hybrid = rendererMetrics("svg_html_hybrid", model, layout);
    expect(native).toMatchObject({ addedRuntimeDependencies: 0, usesExternalAssets: false, usesSemanticHtmlDirectory: false });
    expect(hybrid).toMatchObject({ addedRuntimeDependencies: 0, usesExternalAssets: false, usesSemanticHtmlDirectory: true });
    expect(native.visibleAttachments).toBeLessThanOrEqual(80);
    expect(model.lanes.every((lane) => lane.presentationOnly)).toBe(true);
    const html = renderToStaticMarkup(<HybridAtlas model={model} layout={layout} camera={{ x: 0, y: 0, zoom: 1 }} />);
    expect(html).toContain("resolved attachments");
    expect(html).not.toContain("presentationOnly");
  });

  it("holds the 250-subject interactive budget without adding external assets", () => {
    const props = fixture(250);
    const metrics = rendererMetrics("svg_html_hybrid", props.model, props.layout);
    expect(metrics.subjectVisuals).toBe(250);
    expect(metrics.interactiveSubjects).toBe(250);
    expect(metrics.usesExternalAssets).toBe(false);
  });

  it("applies local caps before renderer indexing and metrics", () => {
    const props = fixture(250);
    const aggregateSeed = projectRuntimeMap(runtimeFixture(100, "outbound_star", "network")).model.aggregates[0]!;
    const oversized = {
      ...props,
      model: {
        ...props.model,
        subjects: [...props.model.subjects, ...props.model.subjects],
        aggregates: Array.from({ length: 100 }, (_, index) => ({ ...aggregateSeed, key: `atlas:aggregate:${index}` as typeof aggregateSeed.key }))
      },
      layout: { ...props.layout, points: [...props.layout.points, ...props.layout.points] }
    };
    const metrics = rendererMetrics("native_svg", oversized.model, oversized.layout);
    const html = renderToStaticMarkup(<NativeSvgAtlas {...oversized} />);
    expect(metrics.subjectVisuals).toBe(250);
    expect(metrics.visibleAggregates).toBe(80);
    expect((html.match(/data-atlas-subject=/g) ?? [])).toHaveLength(250);
  });
});
