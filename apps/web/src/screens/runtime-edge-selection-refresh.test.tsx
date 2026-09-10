// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { DockerSnapshot, RuntimeMap } from "@dockermap/contracts";
import { AppContext, type AppContextValue } from "../context";
import { buildModel } from "../lib/model";
import { testProviderStates } from "../lib/testProviderStates";
import RuntimeScreen from "./Runtime";

const snapshot: DockerSnapshot = {
  containers: [], images: [], networks: [], volumes: [], lastUpdated: 1, modelRevision: "test-revision"
};

function runtimeWithEvidence(summary: string | null): RuntimeMap {
  return {
    nodes: [
      { id: "docker_container_api", provider: "docker", type: "container", label: "api", status: "running", metadata: {} },
      { id: "docker_network_app", provider: "docker", type: "docker_network", label: "app", status: null, metadata: {} },
    ],
    edges: summary === null ? [] : [{
      source: "docker_container_api",
      target: "docker_network_app",
      relationship: "connected_to",
      metadata: {},
      evidenceRefs: [{
        version: 1,
        id: "docker_evidence_network_membership_api_app",
        provider: "docker",
        kind: "docker_network_membership",
        assertionKind: "observed",
        summary,
        subjectRef: "docker_container_api",
        collectedAt: 1,
        providerRevision: "docker-observation-1",
        freshness: "fresh",
      }],
    }],
    diagnostics: [],
    lastUpdated: 1,
    modelRevision: "test-revision",
    providerStates: testProviderStates,
  };
}

function valueFor(runtime: RuntimeMap): AppContextValue {
  return {
    model: buildModel(snapshot, runtime),
    modelProvenance: "live",
    loading: false,
    error: null,
    health: null,
    tick: 0,
    evidenceMode: "live",
    openCommand: () => {},
  };
}

function screen(value: AppContextValue) {
  return <AppContext.Provider value={value}><MemoryRouter><RuntimeScreen /></MemoryRouter></AppContext.Provider>;
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("Runtime edge inspector refresh reconciliation", () => {
  it("resolves selected evidence from the current runtime model and clears it when the edge disappears", () => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    act(() => root!.render(screen(valueFor(runtimeWithEvidence("first current evidence")))));
    const node = [...host.querySelectorAll<HTMLButtonElement>(".runtime-node-btn")]
      .find((candidate) => candidate.textContent?.includes("api"));
    expect(node).toBeDefined();
    act(() => node!.click());
    const inspect = [...host.querySelectorAll<HTMLButtonElement>(".runtime-edge-evidence")]
      .find((candidate) => candidate.textContent === "Inspect evidence");
    expect(inspect).toBeDefined();
    act(() => inspect!.click());
    expect(host.textContent).toContain("first current evidence");

    // The selected key remains stable, but the current model owns the edge
    // object. The inspector must render its refreshed evidence, never the
    // object captured by the click handler before the refresh.
    act(() => root!.render(screen(valueFor(runtimeWithEvidence("second current evidence")))));
    expect(host.textContent).toContain("second current evidence");
    expect(host.textContent).not.toContain("first current evidence");

    act(() => root!.render(screen(valueFor(runtimeWithEvidence(null)))));
    expect(host.textContent).not.toContain("Relationship evidence");
    expect(host.textContent).not.toContain("second current evidence");
  });
});
