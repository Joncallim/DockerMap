import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { DockerSnapshot, RuntimeMap } from "@dockermap/contracts";
import { AppContext, type AppContextValue } from "../context";
import type { EvidenceMode } from "../lib/evidence";

import { buildModel } from "../lib/model";
import { visibleText } from "../lib/test-utils";
import Changes from "./Changes";
import Home from "./Home";

const runtime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], lastUpdated: 0 };
const liveSnapshot: DockerSnapshot = { containers: [{ id: "api", name: "api", image: "nginx", status: "running", role: "api", networks: [], ports: [], mounts: [], dependsOn: [] }], images: [], networks: [], volumes: [], lastUpdated: 0 };

const sampleSnapshot: DockerSnapshot = { ...liveSnapshot, containers: [{ ...liveSnapshot.containers[0], status: "Exited (1)" }] };

function renderScreen(path: "/" | "/changes", snapshot: DockerSnapshot, evidenceMode: EvidenceMode | null) {
  const value: AppContextValue = { model: buildModel(snapshot, runtime), loading: false, error: null, health: null, tick: 0, evidenceMode, openCommand: () => {} };
  return renderToStaticMarkup(<AppContext.Provider value={value}><MemoryRouter initialEntries={[path]}><Routes><Route path="/" element={<Home />} /><Route path="/changes" element={<Changes />} /></Routes></MemoryRouter></AppContext.Provider>);
}

describe("history surfaces distinguish sample and non-sample authority", () => {
  it.each([["live", liveSnapshot], [null, liveSnapshot]] as const)("renders no synthetic history under %s authority", (mode, snapshot) => {
    const changes = renderScreen("/changes", snapshot, mode);
    const home = renderScreen("/", snapshot, mode);
    for (const html of [changes, home]) {
      const text = visibleText(html);
      expect(text).toContain("Not collected");
      expect(text).toContain("Change collectors not wired — DockerMap does not record deploy, restart or failure events");
      expect(html).not.toContain("timeline-row");
      expect(html).not.toContain("feed-row");
      expect(html).not.toContain("filter-chip");
      expect(text).not.toMatch(/\d+[smhd] ago/);
      expect(text).not.toMatch(/\bSample\b/);
    }
    expect(visibleText(changes)).toContain("Change Center");
    expect(visibleText(home)).toContain("Event causality not reconstructed — DockerMap observes current state, not transitions");
  });

  it.each([["demo", sampleSnapshot], ["mock", sampleSnapshot]] as const)("renders tagged samples under %s authority", (mode, snapshot) => {
    const changes = renderScreen("/changes", snapshot, mode);
    const home = renderScreen("/", snapshot, mode);
    expect(changes).toContain("timeline-row");
    expect(home).toContain("feed-row");
    expect(changes).toContain("Sample data");
    expect(home).toContain("Sample data");
    expect(changes.match(/filter-chip/g)?.length).toBe(4);
    expect(home).toContain("chain-step");
  });
});
