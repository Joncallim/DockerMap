// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DockerSnapshot, HealthResponse, RuntimeMap } from "@dockermap/contracts";
import AppShell from "../components/AppShell";
import { getDemoResponse } from "../lib/demoData";
import { buildModel, type SystemModel } from "../lib/model";
import type { ModelProvenance } from "../lib/evidence";
import type { Settings } from "../lib/settingsStore";
import Home from "./Home";

const runtime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], lastUpdated: 0 };
const liveSnapshot: DockerSnapshot = { containers: [{ id: "live-api", name: "api", image: "nginx:1", status: "running", role: "api", networks: [], ports: [], mounts: [], dependsOn: [] }], images: [], networks: [], volumes: [], lastUpdated: 0 };
const demoModel = buildModel(getDemoResponse("/api/snapshot"), runtime);
const liveModel = buildModel(liveSnapshot, runtime);

// U12: useSystemModel is generation-guarded in production (a new snapshot
// yields a NEW model object); the mock reads a mutable model so the tests can
// swap generations instead of returning one static const.
const state = vi.hoisted(() => ({ demoMode: true, health: null as HealthResponse | null, model: null as SystemModel | null, modelProvenance: null as ModelProvenance | null }));
vi.mock("../hooks/useSettings", () => ({ useSettings: () => ({ settings: { theme: "system", density: "comfortable", refreshIntervalMs: 2000, defaultRoute: "/", demoMode: state.demoMode, auth: { showStatus: false, provider: "authelia", loginUrl: "", logoutUrl: "" } } satisfies Settings, updateSettings: () => {}, resetSettings: () => {} }) }));
vi.mock("../hooks/useDaemonHeartbeat", () => ({ useDaemonHeartbeat: () => ({ tick: 0, health: state.health }) }));
// The mocked useSystemModel publishes BOTH model fields: provenance travels
// WITH the model, so the pair is driven explicitly alongside each model swap.
vi.mock("../hooks/useSystemModel", () => ({ useSystemModel: () => ({ model: state.model, modelProvenance: state.modelProvenance, loading: false, error: null }) }));
vi.mock("../hooks/useApiResource", () => ({ useApiResource: () => ({ data: null, loading: false, error: null, generation: 0, provenance: null }) }));
let root: Root | null = null; let host: HTMLDivElement | null = null;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = vi.fn(() => ({ matches: false, media: "", onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })) as unknown as typeof window.matchMedia;
});
function shell() {
  return <MemoryRouter><Routes><Route element={<AppShell onBearerSignOut={() => {}} />}><Route index element={<Home />} /></Route></Routes></MemoryRouter>;
}
function render() { state.model = demoModel; state.modelProvenance = "demo"; host = document.createElement("div"); document.body.append(host); root = createRoot(host); act(() => root!.render(shell())); return host; }
afterEach(() => { root?.unmount(); host?.remove(); root = null; host = null; });
function updatesValue(target: HTMLElement): string {
  const value = target.querySelector(".metric-updates .metric-value");
  expect(value).not.toBeNull();
  return value!.textContent!.trim();
}
describe("Updates wiring", () => {
  it("keeps not-collected update copy across a demo-to-live authority flip", () => {
    state.demoMode = true; state.health = { status: "ok", mode: "mock", dockerReachable: true, lastUpdated: 1, snapshotVersion: "demo" };
    const target = render();
    expect(target.querySelector(".conn-mode")!.textContent).toBe("Demo Engine");
    expect(target.querySelector(".metric-updates")!.textContent).toContain("Not collected");
    // U11: the authority flip must happen INSIDE act() so React commits the
    // state change + re-render as one update (no "not wrapped in act" warning).
    act(() => { state.demoMode = false; state.health = { status: "ok", mode: "docker", dockerReachable: true, lastUpdated: 2, snapshotVersion: "live" }; root!.render(shell()); });
    expect(target.querySelector(".conn-mode")!.textContent).toBe("Docker Engine");
    expect(target.querySelector(".metric-updates")!.textContent).toContain("Not collected");
    expect(updatesValue(target)).not.toMatch(/^\d+$/); // V6: never a digit-only Updates value
    expect(target.textContent).not.toContain("Updates available");
  });

  it("keeps not-collected copy across a live-to-demo flip", () => {
    // U12: the reverse transition (G-36 asymmetry) — live authority first,
    // then demo; the claim must not depend on flip direction.
    state.demoMode = false; state.health = { status: "ok", mode: "docker", dockerReachable: true, lastUpdated: 2, snapshotVersion: "live" };
    const target = render();
    expect(target.querySelector(".conn-mode")!.textContent).toBe("Docker Engine");
    expect(target.querySelector(".metric-updates")!.textContent).toContain("Not collected");
    act(() => { state.demoMode = true; state.health = { status: "ok", mode: "mock", dockerReachable: true, lastUpdated: 3, snapshotVersion: "demo" }; root!.render(shell()); });
    expect(target.querySelector(".conn-mode")!.textContent).toBe("Demo Engine");
    expect(target.querySelector(".metric-updates")!.textContent).toContain("Not collected");
    expect(updatesValue(target)).not.toMatch(/^\d+$/);
    expect(target.textContent).not.toContain("Updates available");
  });

  it("keeps not-collected copy across a model generation change", () => {
    // U12: a new snapshot yields a NEW model object (generation change in
    // useSystemModel's generation-checked memo). Swapping the mocked model
    // simulates that transition — the claim is mode-independent and must not
    // depend on which model instance is current.
    state.demoMode = true; state.health = { status: "ok", mode: "mock", dockerReachable: true, lastUpdated: 1, snapshotVersion: "demo" };
    const target = render();
    expect(target.querySelector(".metric-updates")!.textContent).toContain("Not collected");
    act(() => { state.demoMode = false; state.model = liveModel; state.modelProvenance = "live"; state.health = { status: "ok", mode: "docker", dockerReachable: true, lastUpdated: 2, snapshotVersion: "live" }; root!.render(shell()); });
    expect(target.querySelector(".conn-mode")!.textContent).toBe("Docker Engine");
    expect(target.querySelector(".metric-updates")!.textContent).toContain("Not collected");
    expect(updatesValue(target)).not.toMatch(/^\d+$/);
    expect(target.textContent).not.toContain("Updates available");
  });
});
