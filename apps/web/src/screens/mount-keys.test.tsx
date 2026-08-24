// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockerSnapshot, RuntimeMap } from "@dockermap/contracts";
import { AppContext, type AppContextValue } from "../context";
import { buildModel } from "../lib/model";
import ServiceDetail from "./ServiceDetail";

// Client-side regression for R6 F3: ServiceDetail Configuration mount rows
// were keyed by the raw ContainerMount.id — an unrestricted string, so the
// fixture's duplicate EMPTY ids produced duplicate keys. React's server
// renderer emits no duplicate-key warning, so this file renders through the
// real client reconciler (react-dom/client under jsdom) and asserts:
//  1. no "same key" warning ever fires, and
//  2. each row keeps its own target association across a re-render
//     (simulated refresh), which duplicate keys can corrupt.

const emptyRuntime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], lastUpdated: 0 };

const fixture: DockerSnapshot = {
  containers: [
    {
      id: "c_empty",
      name: "empty-svc",
      image: "",
      status: "running",
      role: "worker",
      networks: [],
      ports: [],
      mounts: [
        { id: "", kind: "named_volume", source: "vol1", target: "/dup-a", readOnly: false },
        { id: "", kind: "named_volume", source: "vol1", target: "/dup-b", readOnly: false }
      ],
      dependsOn: []
    }
  ],
  images: [],
  networks: [],
  volumes: [{ id: "vol1", name: "vol1", attachedTo: ["empty-svc"] }],
  lastUpdated: 0
};

const model = buildModel(fixture, emptyRuntime);
const contextValue: AppContextValue = {
  model,
  loading: false,
  error: null,
  health: null,
  tick: 0,
  evidenceMode: "live",
  openCommand: () => {}
};

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
});

function mountDetail(): HTMLDivElement {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <AppContext.Provider value={contextValue}>
        <MemoryRouter initialEntries={["/services/empty-svc"]}>
          <Routes>
            <Route path="/services/:name" element={<ServiceDetail defaultTab="config" />} />
          </Routes>
        </MemoryRouter>
      </AppContext.Provider>
    );
  });
  return host;
}

describe("ServiceDetail Configuration mount rows use occurrence-qualified keys", () => {
  it("duplicate EMPTY mount ids never produce a duplicate-key warning and both rows render", () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      const hostEl = mountDetail();
      expect(hostEl.querySelectorAll(".mount-row").length).toBe(2);
      expect(hostEl.textContent).toContain("/dup-a");
      expect(hostEl.textContent).toContain("/dup-b");
    } finally {
      spy.mockRestore();
    }
    expect(errors.filter((message) => message.includes("same key"))).toEqual([]);
  });

  it("rows keep their target association across a re-render (simulated refresh)", () => {
    const hostEl = mountDetail();
    const rows = hostEl.querySelectorAll(".mount-row");
    expect(rows[0]?.textContent).toContain("/dup-a");
    expect(rows[1]?.textContent).toContain("/dup-b");

    // Re-render through the same root: reconciliation must not shuffle rows.
    act(() => {
      root!.render(
        <AppContext.Provider value={contextValue}>
          <MemoryRouter initialEntries={["/services/empty-svc"]}>
            <Routes>
              <Route path="/services/:name" element={<ServiceDetail defaultTab="config" />} />
            </Routes>
          </MemoryRouter>
        </AppContext.Provider>
      );
    });
    const rowsAfter = hostEl.querySelectorAll(".mount-row");
    expect(rowsAfter.length).toBe(2);
    expect(rowsAfter[0]?.textContent).toContain("/dup-a");
    expect(rowsAfter[1]?.textContent).toContain("/dup-b");
  });
});
