// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DockerSnapshot, HealthResponse, RuntimeMap } from "@dockermap/contracts";
import AppShell from "../components/AppShell";
import { getDemoResponse } from "../lib/demoData";
import { buildModel, type SystemModel } from "../lib/model";
import type { Settings } from "../lib/settingsStore";
import Changes from "./Changes";
import Home from "./Home";

const runtime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], lastUpdated: 0 };
const liveSnapshot: DockerSnapshot = { containers: [{ id: "live-api", name: "api", image: "nginx:1", status: "running", role: "api", networks: [], ports: [], mounts: [], dependsOn: [] }], images: [], networks: [], volumes: [], lastUpdated: 0 };
const demoModel = buildModel(getDemoResponse("/api/snapshot"), runtime);
const liveModel = buildModel(liveSnapshot, runtime);
const state = vi.hoisted(() => ({ demoMode: true, health: null as HealthResponse | null, model: null as SystemModel | null }));
vi.mock("../hooks/useSettings", () => ({ useSettings: () => ({ settings: { theme: "system", density: "comfortable", refreshIntervalMs: 2000, defaultRoute: "/", demoMode: state.demoMode, auth: { showStatus: false, provider: "authelia", loginUrl: "", logoutUrl: "" } } satisfies Settings, updateSettings: () => {}, resetSettings: () => {} }) }));
vi.mock("../hooks/useDaemonHeartbeat", () => ({ useDaemonHeartbeat: () => ({ tick: 0, health: state.health }) }));
vi.mock("../hooks/useSystemModel", () => ({ useSystemModel: () => ({ model: state.model, loading: false, error: null }) }));
vi.mock("../hooks/useApiResource", () => ({ useApiResource: () => ({ data: null, loading: false, error: null, generation: 0 }) }));
let root: Root | null = null; let host: HTMLDivElement | null = null;
beforeEach(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; window.matchMedia = vi.fn(() => ({ matches: false, media: "", onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })) as unknown as typeof window.matchMedia; });
afterEach(() => { root?.unmount(); host?.remove(); root = null; host = null; });
function shell(path: "/" | "/changes") { return <MemoryRouter initialEntries={[path]}><Routes><Route element={<AppShell onBearerSignOut={() => {}} />}><Route path="/" element={<Home />} /><Route path="/changes" element={<Changes />} /></Route></Routes></MemoryRouter>; }
function render(path: "/" | "/changes") { state.model = demoModel; host = document.createElement("div"); document.body.append(host); root = createRoot(host); act(() => root!.render(shell(path))); return host; }
function setLive(path: "/" | "/changes", model = liveModel) { act(() => { state.demoMode = false; state.health = { status: "ok", mode: "docker", dockerReachable: true, lastUpdated: 2, snapshotVersion: "live" }; state.model = model; root!.render(shell(path)); }); }
function setDemo(path: "/" | "/changes") { act(() => { state.demoMode = true; state.health = { status: "ok", mode: "mock", dockerReachable: true, lastUpdated: 3, snapshotVersion: "demo" }; state.model = demoModel; root!.render(shell(path)); }); }

describe("history wiring", () => {
  it("flips Home history from demo to live and back without stale rows", () => {
    state.demoMode = true; state.health = { status: "ok", mode: "mock", dockerReachable: true, lastUpdated: 1, snapshotVersion: "demo" };
    const target = render("/");
    expect(target.querySelectorAll(".feed-row").length).toBeGreaterThan(0);
    setLive("/");
    expect(target.querySelector(".conn-mode")!.textContent).toBe("Docker Engine"); expect(target.querySelectorAll(".feed-row").length).toBe(0); expect(target.textContent).toContain("Not collected");
    setDemo("/");
    expect(target.querySelector(".conn-mode")!.textContent).toBe("Demo Engine"); expect(target.querySelectorAll(".feed-row").length).toBeGreaterThan(0);
  });
  it("flips Change Center, including filter controls, in both directions and fails closed before health", () => {
    state.demoMode = false; state.health = { status: "ok", mode: "docker", dockerReachable: true, lastUpdated: 1, snapshotVersion: "live" };
    const target = render("/changes");
    expect(target.querySelectorAll(".timeline-row").length).toBe(0); expect(target.querySelectorAll(".filter-chip").length).toBe(0);
    setDemo("/changes");
    expect(target.querySelectorAll(".timeline-row").length).toBeGreaterThan(0); expect(target.querySelectorAll(".filter-chip").length).toBe(4);
    setLive("/changes", buildModel({ ...liveSnapshot, lastUpdated: 4 }, runtime));
    expect(target.querySelectorAll(".timeline-row").length).toBe(0); expect(target.querySelectorAll(".filter-chip").length).toBe(0);
    act(() => { state.health = null; root!.render(shell("/changes")); });
    expect(target.textContent).toContain("Not collected"); expect(target.querySelectorAll(".timeline-row").length).toBe(0);
  });
});
