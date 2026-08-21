// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockerSnapshot, LogsResponse, RuntimeMap, RuntimeMapNode } from "@dockermap/contracts";
import { AppContext, type AppContextValue } from "../context";
import { buildModel } from "../lib/model";
import Home from "./Home";
import Logs from "./Logs";
import RuntimeScreen from "./Runtime";
import ServiceDetail from "./ServiceDetail";

// Client-side regression for the binding-named collidable key sites (R6 F3
// class): list rows keyed by raw identity strings can collide when the
// contract carries duplicate EMPTY/redacted ids or repeated port strings.
// React's server renderer emits no duplicate-key warning, so this file
// renders EVERY affected list through the real client reconciler
// (react-dom/client under jsdom) and asserts:
//  1. no "same key" warning ever fires, and
//  2. every occurrence of a duplicated identity still renders its own row.
// Covered lists: Home attention rows + change feed, Logs entries (screen and
// ServiceDetail tab), ServiceDetail port tags, Runtime inspector log refs
// and event refs.

const emptyRuntime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], lastUpdated: 0 };

/** Duplicate service ids (redaction can collapse container ids) drive BOTH
 * the Home attention list and the change feed (feed ids embed service.id). */
const homeFixture: DockerSnapshot = {
  containers: [
    {
      id: "c_dup",
      name: "dup-a",
      image: "busybox:latest",
      status: "unhealthy",
      role: "worker",
      networks: [],
      ports: [],
      mounts: [],
      dependsOn: []
    },
    {
      id: "c_dup",
      name: "dup-b",
      image: "busybox:latest",
      status: "unhealthy",
      role: "worker",
      networks: [],
      ports: [],
      mounts: [],
      dependsOn: []
    }
  ],
  images: [],
  networks: [],
  volumes: [],
  lastUpdated: 0
};

const detailFixture: DockerSnapshot = {
  containers: [
    {
      id: "c_web",
      name: "web",
      image: "nginx:1",
      status: "running",
      role: "web",
      networks: [],
      ports: ["8080", "8080", "443"],
      mounts: [],
      dependsOn: []
    }
  ],
  images: [],
  networks: [],
  volumes: [],
  lastUpdated: 0
};

const duplicateLogs: LogsResponse = {
  service: null,
  nextCursor: null,
  entries: [
    { id: "e_dup", timestamp: 1_700_000_000_000, container: "web", level: "info", message: "first duplicate log line" },
    { id: "e_dup", timestamp: 1_700_000_000_001, container: "web", level: "warn", message: "second duplicate log line" }
  ]
};

function runtimeNode(id: string, label: string): RuntimeMapNode {
  return {
    id,
    provider: "docker",
    type: "container",
    label,
    status: "running",
    layer: "container",
    metadata: {},
    service: {
      name: label,
      status: "running",
      dependencies: [],
      dependents: [],
      health: null,
      logs: [
        { id: "l_dup", source: label, level: "info" },
        { id: "l_dup", source: label, level: "warn" }
      ],
      events: [
        { id: "ev_dup", kind: "start", message: "first duplicate event" },
        { id: "ev_dup", kind: "start", message: "second duplicate event" }
      ],
      owner: null,
      location: null
    },
    package: null
  };
}

const runtimeFixture: RuntimeMap = {
  nodes: [runtimeNode("n1", "web")],
  edges: [],
  diagnostics: [],
  lastUpdated: 0
};

function contextFor(fixture: DockerSnapshot, runtime: RuntimeMap): AppContextValue {
  const model = buildModel(fixture, runtime);
  return {
    model,
    loading: false,
    error: null,
    health: null,
    tick: 0,
    openCommand: () => {}
  };
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
  vi.unstubAllGlobals();
});

function mount(element: React.ReactElement): HTMLDivElement {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(element);
  });
  return host;
}

/** Renders through the real client reconciler and returns any React
 * duplicate-key warnings that fired. */
function mountCollectingKeys(element: React.ReactElement): { hostEl: HTMLDivElement; sameKeyErrors: string[] } {
  const sameKeyErrors: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    const message = args.map(String).join(" ");
    if (message.includes("same key")) sameKeyErrors.push(message);
  });
  try {
    return { hostEl: mount(element), sameKeyErrors };
  } finally {
    spy.mockRestore();
  }
}

describe("collidable list keys are occurrence-qualified (client reconciler)", () => {
  it("Home renders every attention row and feed row with duplicate ids without a same-key warning", () => {
    const { hostEl, sameKeyErrors } = mountCollectingKeys(
      <AppContext.Provider value={contextFor(homeFixture, emptyRuntime)}>
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route path="/" element={<Home />} />
          </Routes>
        </MemoryRouter>
      </AppContext.Provider>
    );
    expect(hostEl.querySelectorAll(".svc-list .svc-row").length).toBe(2);
    expect(hostEl.querySelectorAll(".feed-row").length).toBe(2);
    expect(hostEl.textContent).toContain("dup-a");
    expect(hostEl.textContent).toContain("dup-b");
    expect(sameKeyErrors).toEqual([]);
  });

  it("Logs renders every duplicate entry id as its own row without a same-key warning", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => duplicateLogs }))
    );
    const { hostEl, sameKeyErrors } = mountCollectingKeys(
      <AppContext.Provider value={contextFor(homeFixture, emptyRuntime)}>
        <MemoryRouter initialEntries={["/logs"]}>
          <Routes>
            <Route path="/logs" element={<Logs />} />
          </Routes>
        </MemoryRouter>
      </AppContext.Provider>
    );
    await vi.waitFor(() => expect(hostEl.querySelectorAll(".log-line").length).toBe(2));
    expect(hostEl.textContent).toContain("first duplicate log line");
    expect(hostEl.textContent).toContain("second duplicate log line");
    expect(sameKeyErrors).toEqual([]);
  });

  it("ServiceDetail Logs tab renders duplicate entry ids without a same-key warning", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => duplicateLogs }))
    );
    const { hostEl, sameKeyErrors } = mountCollectingKeys(
      <AppContext.Provider value={contextFor(detailFixture, emptyRuntime)}>
        <MemoryRouter initialEntries={["/services/web"]}>
          <Routes>
            <Route path="/services/:name" element={<ServiceDetail defaultTab="logs" />} />
          </Routes>
        </MemoryRouter>
      </AppContext.Provider>
    );
    await vi.waitFor(() => expect(hostEl.querySelectorAll(".log-line").length).toBe(2));
    expect(sameKeyErrors).toEqual([]);
  });

  it("ServiceDetail Configuration renders repeated port strings as distinct tags without a same-key warning", () => {
    const { hostEl, sameKeyErrors } = mountCollectingKeys(
      <AppContext.Provider value={contextFor(detailFixture, emptyRuntime)}>
        <MemoryRouter initialEntries={["/services/web"]}>
          <Routes>
            <Route path="/services/:name" element={<ServiceDetail defaultTab="config" />} />
          </Routes>
        </MemoryRouter>
      </AppContext.Provider>
    );
    const portTags = [...hostEl.querySelectorAll(".tag-wrap .tag")].filter((tag) => tag.textContent === "8080");
    expect(portTags.length).toBe(2);
    expect(hostEl.textContent).toContain("443");
    expect(sameKeyErrors).toEqual([]);
  });

  it("Runtime inspector renders duplicate log and event ref ids as distinct rows without a same-key warning", () => {
    const { hostEl, sameKeyErrors } = mountCollectingKeys(
      <AppContext.Provider value={contextFor({ containers: [], images: [], networks: [], volumes: [], lastUpdated: 0 }, runtimeFixture)}>
        <MemoryRouter initialEntries={["/runtime"]}>
          <Routes>
            <Route path="/runtime" element={<RuntimeScreen />} />
          </Routes>
        </MemoryRouter>
      </AppContext.Provider>
    );
    const nodeButton = hostEl.querySelector<HTMLButtonElement>(".runtime-node-btn");
    expect(nodeButton).not.toBeNull();
    act(() => {
      nodeButton!.click();
    });
    expect(hostEl.querySelectorAll(".runtime-evidence-list li").length).toBe(4);
    expect(hostEl.textContent).toContain("first duplicate event");
    expect(hostEl.textContent).toContain("second duplicate event");
    expect(sameKeyErrors).toEqual([]);
  });
});
