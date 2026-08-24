// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthResponse, RuntimeMap } from "@dockermap/contracts";
import AppShell from "../components/AppShell";
import { getDemoResponse } from "../lib/demoData";
import { buildModel } from "../lib/model";
import type { Settings } from "../lib/settingsStore";
import Home from "./Home";

const runtime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], lastUpdated: 0 };
const model = buildModel(getDemoResponse("/api/snapshot"), runtime);
const state = vi.hoisted(() => ({ demoMode: true, health: null as HealthResponse | null }));
vi.mock("../hooks/useSettings", () => ({ useSettings: () => ({ settings: { theme: "system", density: "comfortable", refreshIntervalMs: 2000, defaultRoute: "/", demoMode: state.demoMode, auth: { showStatus: false, provider: "authelia", loginUrl: "", logoutUrl: "" } } satisfies Settings, updateSettings: () => {}, resetSettings: () => {} }) }));
vi.mock("../hooks/useDaemonHeartbeat", () => ({ useDaemonHeartbeat: () => ({ tick: 0, health: state.health }) }));
vi.mock("../hooks/useSystemModel", () => ({ useSystemModel: () => ({ model, loading: false, error: null }) }));
vi.mock("../hooks/useApiResource", () => ({ useApiResource: () => ({ data: null, loading: false, error: null, generation: 0 }) }));
let root: Root | null = null; let host: HTMLDivElement | null = null;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = vi.fn(() => ({ matches: false, media: "", onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })) as unknown as typeof window.matchMedia;
});
function render() { host = document.createElement("div"); document.body.append(host); root = createRoot(host); act(() => root!.render(<MemoryRouter><Routes><Route element={<AppShell onBearerSignOut={() => {}} />}><Route index element={<Home />} /></Route></Routes></MemoryRouter>)); return host; }
afterEach(() => { root?.unmount(); host?.remove(); root = null; host = null; });
describe("Updates wiring", () => { it("keeps not-collected update copy across a demo-to-live authority flip", () => { state.demoMode = true; state.health = { status: "ok", mode: "mock", dockerReachable: true, lastUpdated: 1, snapshotVersion: "demo" }; const target = render(); expect(target.querySelector(".conn-mode")!.textContent).toBe("Demo Engine"); expect(target.querySelector(".metric-updates")!.textContent).toContain("Not collected"); state.demoMode = false; state.health = { status: "ok", mode: "docker", dockerReachable: true, lastUpdated: 2, snapshotVersion: "live" }; act(() => root!.render(<MemoryRouter><Routes><Route element={<AppShell onBearerSignOut={() => {}} />}><Route index element={<Home />} /></Route></Routes></MemoryRouter>)); expect(target.querySelector(".conn-mode")!.textContent).toBe("Docker Engine"); expect(target.querySelector(".metric-updates")!.textContent).toContain("Not collected"); expect(target.textContent).not.toContain("Updates available"); }); });
