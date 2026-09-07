// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { collisionFixture, runtimeFixture } from "../lib/atlas/fixtures";
import { projectRuntimeMap } from "../lib/atlas/project";
import type { AtlasModel } from "../lib/atlas/types";
import { useAtlasState } from "./useAtlasState";

const model = projectRuntimeMap(runtimeFixture(3)).model;
const subject = model.subjects.find((entry) => entry.routability === "routable")!.key;
const expansionModel = projectRuntimeMap(runtimeFixture(10, "outbound_star", "network")).model;
const expansionSubject = expansionModel.subjects.find((entry) => entry.routability === "routable")!.key;
const aggregate = expansionModel.aggregates[0]!.key;

function Probe({ current }: { current: AtlasModel }) {
  const atlas = useAtlasState(current);
  const location = useLocation();
  const navigate = useNavigate();
  return <>
    <output data-route={location.search} data-selected={atlas.selectedKey ?? ""} data-expanded={atlas.expandedKey ?? ""} data-target={atlas.focusTarget} data-status={atlas.selectionStatus ?? ""} data-focus={atlas.focusRecoveryToken} />
    <button onClick={() => atlas.select(null)}>clear</button>
    <button onClick={() => atlas.expand(aggregate)}>expand</button>
    <button onClick={() => atlas.expand(null)}>collapse</button>
    <button onClick={() => atlas.setLens("overview")}>overview</button>
    <button onClick={() => navigate(-1)}>back</button>
    <button onClick={() => navigate(1)}>forward</button>
  </>;
}

function renderProbe(root: Root, current: AtlasModel, entries = [`/atlas?subject=${subject}`], index?: number) {
  return act(async () => root.render(<MemoryRouter initialEntries={entries} initialIndex={index}><Probe current={current} /></MemoryRouter>));
}

describe("useAtlasState", () => {
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    host?.remove();
    host = null;
    root = null;
  });

  it("keeps URL state as the back/forward history authority", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await renderProbe(root, model);
    expect(host.querySelector("output")?.dataset.selected).toBe(subject);
    await act(async () => host!.querySelector<HTMLButtonElement>("button")!.click());
    expect(host.querySelector("output")?.dataset.route).toBe("");
    await act(async () => host!.querySelectorAll<HTMLButtonElement>("button")[4]!.click());
    expect(host.querySelector("output")?.dataset.selected).toBe(subject);
    await act(async () => host!.querySelectorAll<HTMLButtonElement>("button")[5]!.click());
    expect(host.querySelector("output")?.dataset.route).toBe("");
  });

  it("keeps model-backed expansion in browser history and clears only invalid expansion after a revision", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await renderProbe(root, expansionModel, [`/atlas?subject=${expansionSubject}`]);
    await act(async () => host!.querySelectorAll<HTMLButtonElement>("button")[1]!.click());
    expect(host.querySelector("output")?.dataset.expanded).toBe(aggregate);
    expect(host.querySelector("output")?.dataset.target).toBe("aggregate");
    await act(async () => host!.querySelectorAll<HTMLButtonElement>("button")[2]!.click());
    expect(host.querySelector("output")?.dataset.expanded).toBe("");
    await act(async () => host!.querySelectorAll<HTMLButtonElement>("button")[4]!.click());
    expect(host.querySelector("output")?.dataset.expanded).toBe(aggregate);
    await act(async () => host!.querySelectorAll<HTMLButtonElement>("button")[5]!.click());
    expect(host.querySelector("output")?.dataset.expanded).toBe("");

    const revised = { ...expansionModel, aggregates: [] };
    await act(async () => root!.render(<MemoryRouter initialEntries={[`/atlas?subject=${expansionSubject}&expand=${encodeURIComponent(aggregate)}`]}><Probe current={revised} /></MemoryRouter>));
    const output = host.querySelector("output")!;
    expect(output.dataset.selected).toBe(expansionSubject);
    expect(output.dataset.expanded).toBe("");
    expect(output.dataset.status).toBe("");
  });

  it("keeps a selected subject when the singleton available lens is selected", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await renderProbe(root, model);
    await act(async () => host!.querySelectorAll<HTMLButtonElement>("button")[3]!.click());
    expect(host.querySelector("output")?.dataset.selected).toBe(subject);
    expect(host.querySelector("output")?.dataset.route).toBe(`?subject=${subject}`);
  });

  it("clears unavailable status after a later valid history location", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await renderProbe(root, model, ["/atlas?subject=not-current", `/atlas?subject=${subject}`], 0);
    expect(host.querySelector("output")?.dataset.status).toBe("selection_unavailable");
    await act(async () => host!.querySelectorAll<HTMLButtonElement>("button")[5]!.click());
    expect(host.querySelector("output")?.dataset.selected).toBe(subject);
    expect(host.querySelector("output")?.dataset.status).toBe("");
  });

  it("recovers a subject field after more than the normal parameter cap in an oversized URL", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const oversized = `/atlas?x=1&y=2&zoom=3&other=4&subject=${subject}&padding=${"a".repeat(800)}`;
    await renderProbe(root, model, [oversized]);
    const output = host.querySelector("output")!;
    expect(output.dataset.route).toBe("");
    expect(output.dataset.status).toBe("selection_unavailable");
    expect(output.dataset.focus).toBe("1");
  });

  it("replaces a selection that disappears in a coherent revision and emits bounded recovery", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await renderProbe(root, model);
    const replacement = projectRuntimeMap(collisionFixture()).model;
    await act(async () => root!.render(<MemoryRouter initialEntries={[`/atlas?subject=${subject}`]}><Probe current={replacement} /></MemoryRouter>));
    const output = host.querySelector("output")!;
    expect(output.dataset.route).toBe("");
    expect(output.dataset.selected).toBe("");
    expect(output.dataset.status).toBe("selection_unavailable");
    expect(output.dataset.focus).toBe("1");
  });
});
