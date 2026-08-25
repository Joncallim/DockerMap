import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { DockerSnapshot, RuntimeMap } from "@dockermap/contracts";
import { AppContext, type AppContextValue } from "../context";
import type { EvidenceMode, ModelProvenance } from "../lib/evidence";

import { buildModel } from "../lib/model";
import { visibleText } from "../lib/test-utils";
import Changes from "./Changes";
import Home from "./Home";

const runtime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], lastUpdated: 0 };
const liveSnapshot: DockerSnapshot = { containers: [{ id: "api", name: "api", image: "nginx", status: "running", role: "api", networks: [], ports: [], mounts: [], dependsOn: [] }], images: [], networks: [], volumes: [], lastUpdated: 0 };

// Offline container — deterministically emits feed + causal rows under a
// MATCHING sample pair (U15: deliberately used for BOTH sample arms because
// it is stronger than a seed-dependent running-only fixture).
const sampleSnapshot: DockerSnapshot = { ...liveSnapshot, containers: [{ ...liveSnapshot.containers[0], status: "Exited (1)" }] };

// Eventless sample fixture: a healthy running container whose change seed
// (hashString(id + "change")) is <= 0.6, so the sample feed emits zero rows
// and the canonical true-empty copy must render instead.
const eventlessSnapshot: DockerSnapshot = { ...liveSnapshot, containers: [{ ...liveSnapshot.containers[0], id: "quiet" }] };

function renderScreen(path: "/" | "/changes", snapshot: DockerSnapshot, evidenceMode: EvidenceMode | null, modelProvenance: ModelProvenance | null) {
  const value: AppContextValue = { model: buildModel(snapshot, runtime), modelProvenance, loading: false, error: null, health: null, tick: 0, evidenceMode, openCommand: () => {} };
  return renderToStaticMarkup(<AppContext.Provider value={value}><MemoryRouter initialEntries={[path]}><Routes><Route path="/" element={<Home />} /><Route path="/changes" element={<Changes />} /></Routes></MemoryRouter></AppContext.Provider>);
}

describe("history surfaces distinguish sample and non-sample authority", () => {
  // Live+null pairs AND every mode/provenance mismatch: unavailable, zero
  // rows, no sample label, no invented relative time, heading survives.
  it.each([["live", liveSnapshot, "daemon"], [null, liveSnapshot, "daemon"], ["demo", liveSnapshot, "daemon"], ["mock", sampleSnapshot, "demo"]] as const)("renders no synthetic history for pair (%s, %s, %s)", (mode, snapshot, provenance) => {
    const changes = renderScreen("/changes", snapshot, mode, provenance);
    const home = renderScreen("/", snapshot, mode, provenance);
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

  it.each([["demo", sampleSnapshot, "demo"], ["mock", sampleSnapshot, "daemon"]] as const)("renders tagged samples for the matching pair (%s, %s, %s)", (mode, snapshot, provenance) => {
    const changes = renderScreen("/changes", snapshot, mode, provenance);
    const home = renderScreen("/", snapshot, mode, provenance);
    expect(changes).toContain("timeline-row");
    expect(home).toContain("feed-row");
    expect(changes).toContain("Sample data");
    expect(home).toContain("Sample data");
    expect(changes.match(/filter-chip/g)?.length).toBe(4);
    expect(home).toContain("chain-step");
  });

  it("renders the canonical true-empty copy for an eventless matching sample model", () => {
    const changes = renderScreen("/changes", eventlessSnapshot, "demo", "demo");
    expect(visibleText(changes)).toContain("No sample change");
    expect(visibleText(changes)).toContain("The sample topology has no change events right now.");
    expect(changes).not.toContain("timeline-row");
  });
});
