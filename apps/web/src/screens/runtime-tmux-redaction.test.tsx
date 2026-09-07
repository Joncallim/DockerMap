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

const rawSessionName = "tmux-session-PRIVATE-7f3d";
const snapshot: DockerSnapshot = { containers: [], images: [], networks: [], volumes: [], lastUpdated: 1, modelRevision: "test-revision" };
const runtime: RuntimeMap = {
  nodes: [{
    id: `tmux_session_${rawSessionName}`,
    provider: "tmux",
    type: "tmux_session",
    label: rawSessionName,
    status: "attached",
    metadata: { sessionName: rawSessionName, windows: "7" }
  }],
  edges: [{
    source: `tmux_session_${rawSessionName}`,
    target: "missing-target",
    relationship: "runs_on",
    metadata: {},
    evidenceRefs: []
  }],
  diagnostics: [],
  lastUpdated: 1,
  modelRevision: "test-revision",
  providerStates: testProviderStates
};

const value: AppContextValue = {
  model: buildModel(snapshot, runtime), modelProvenance: "live", loading: false, error: null,
  health: null, tick: 0, evidenceMode: "live", openCommand: () => {}
};

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("tmux runtime presentation", () => {
  it("keeps a hostile tmux node selectable without rendering its identity or metadata", () => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<AppContext.Provider value={value}><MemoryRouter><RuntimeScreen /></MemoryRouter></AppContext.Provider>));

    expect(host.textContent).toContain("tmux session");
    expect(host.textContent).not.toContain(rawSessionName);

    const session = host.querySelector<HTMLButtonElement>(".runtime-node-btn");
    expect(session).not.toBeNull();
    act(() => session!.click());

    expect(host.textContent).toContain("tmux session");
    expect(host.textContent).not.toContain(rawSessionName);
    expect(host.textContent).not.toContain("Metadata");
    expect(host.textContent).not.toContain("Inspect evidence");
  });
});
