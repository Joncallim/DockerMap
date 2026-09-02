import { testProviderStates } from "../lib/testProviderStates";
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DockerSnapshot, HealthResponse, RuntimeMap } from "@dockermap/contracts";
import AppShell from "../components/AppShell";
import { buildModel, type SystemModel } from "../lib/model";
import type { ModelProvenance } from "../lib/evidence";
import type { Settings } from "../lib/settingsStore";
import Home from "./Home";
import ServiceDetail from "./ServiceDetail";

const runtime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], modelRevision: "test-revision", providerStates: testProviderStates, lastUpdated: 0 };
const fixture = (status: string): DockerSnapshot => ({ containers: [{ id: "prod-secret-host", name: "prod-secret-host", image: "nginx", status, role: "api", networks: [], ports: [], mounts: [], dependsOn: [] }], images: [], networks: [], volumes: [], modelRevision: "test-revision", lastUpdated: 0 });
const liveModel = buildModel(fixture("Exited (1)"), runtime);
const demoModel = buildModel(fixture("Exited (1)"), runtime);
const state = vi.hoisted(() => ({ demoMode: false, health: null as HealthResponse | null, model: null as SystemModel | null, modelProvenance: null as ModelProvenance | null }));
vi.mock("../hooks/useSettings", () => ({ useSettings: () => ({ settings: { theme: "system", density: "comfortable", refreshIntervalMs: 2000, defaultRoute: "/", demoMode: state.demoMode, auth: { showStatus: false, provider: "authelia", loginUrl: "", logoutUrl: "" } } satisfies Settings, updateSettings: () => {}, resetSettings: () => {} }) }));
vi.mock("../hooks/useDaemonHeartbeat", () => ({ useDaemonHeartbeat: () => ({ tick: 0, health: state.health }) }));
vi.mock("../hooks/useSystemModel", () => ({ useSystemModel: () => ({ model: state.model, modelProvenance: state.modelProvenance, loading: false, error: null }) }));
vi.mock("../hooks/useApiResource", () => ({ useApiResource: () => ({ data: null, loading: false, error: null, generation: 0, provenance: null }) }));
let root: Root | null = null; let host: HTMLDivElement | null = null;
function shell(path: "/" | "/services/prod-secret-host") { return <MemoryRouter initialEntries={[path]}><Routes><Route element={<AppShell onBearerSignOut={() => {}} />}><Route path="/" element={<Home />} /><Route path="/services/:name" element={<ServiceDetail />} /></Route></Routes></MemoryRouter>; }
function render(path: "/" | "/services/prod-secret-host") { host = document.createElement("div"); document.body.append(host); root = createRoot(host); act(() => root!.render(shell(path))); return host; }
function rerender(path: "/" | "/services/prod-secret-host") { act(() => root!.render(shell(path))); }
beforeEach(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; window.matchMedia = vi.fn(() => ({ matches: false, media: "", onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })) as unknown as typeof window.matchMedia; });
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });

describe("resource wiring holds model provenance through mode flips", () => {
  it("does not relabel retained live bytes, resumes only after demo pair publishes, and rejects mock", () => {
    state.demoMode = false; state.health = { status: "ok", mode: "docker", dockerReachable: true, lastUpdated: 1, modelRevision: "test-revision", snapshotVersion: "live" }; state.model = liveModel; state.modelProvenance = "live";
    const target = render("/");
    expect(target.querySelector(".svc-res")!.textContent).toBe("CPU not collected");
    expect(target.querySelectorAll(".svc-res .bar")).toHaveLength(0);
    // live→demo flip, pair held
    act(() => { state.demoMode = true; root!.render(shell("/")); });
    expect(target.querySelector(".conn-mode")!.textContent).toBe("Demo Engine");
    expect(target.querySelectorAll(".svc-res .bar")).toHaveLength(0);
    expect(target.textContent).not.toContain("Sample data");
    expect(target.querySelector(".svc-res")!.textContent).toBe("CPU not collected"); // G-15: unavailable persists
    // separate act: publish demo pair — resumption
    act(() => { state.model = demoModel; state.modelProvenance = "demo"; root!.render(shell("/")); });
    expect(target.querySelectorAll(".svc-res .bar").length).toBeGreaterThan(0);
    expect(target.textContent).toContain("Sample data");
    // demo→live: bar/caption gone, unavailable back
    act(() => { state.demoMode = false; root!.render(shell("/")); });
    expect(target.querySelectorAll(".svc-res .bar")).toHaveLength(0);
    expect(target.querySelector(".svc-res")!.textContent).toBe("CPU not collected"); // G-15
  });

  it("rejects mock bytes under any authority, including dynamic docker→mock fallback", () => {
    // retained live pair, health alone flips docker→mock (G-38 scenario)
    state.demoMode = false; state.health = { status: "ok", mode: "docker", dockerReachable: true, lastUpdated: 1, modelRevision: "test-revision", snapshotVersion: "live" }; state.model = liveModel; state.modelProvenance = "live";
    const target = render("/");
    expect(target.querySelector(".svc-res")!.textContent).toBe("CPU not collected");
    act(() => { state.health = { status: "ok", mode: "mock", dockerReachable: false, lastUpdated: 2, modelRevision: "test-revision", snapshotVersion: "mock" }; root!.render(shell("/")); });
    expect(target.querySelector(".conn-mode")!.textContent).toBe("Mock Engine");
    expect(target.querySelectorAll(".svc-res .bar")).toHaveLength(0);
    expect(target.querySelector(".svc-res")!.textContent).toBe("CPU not collected"); // G-15: unavailable persists
    // publish matching (mock,mock) — still unavailable per explicit-demo-only policy
    act(() => { state.modelProvenance = "mock"; state.model = liveModel; root!.render(shell("/")); });
    expect(target.querySelectorAll(".svc-res .bar")).toHaveLength(0);
    expect(target.querySelector(".svc-res")!.textContent).toBe("CPU not collected");
    expect(target.querySelector(".svc-res")!.textContent).not.toContain("Sample data");
  });

  it("renders unavailable while authority is null and recovers", () => {
    state.demoMode = false; state.health = null; state.model = liveModel; state.modelProvenance = null;
    const target = render("/");
    expect(target.querySelector(".svc-res")!.textContent).toBe("CPU not collected");
    expect(target.querySelectorAll(".svc-res .bar")).toHaveLength(0);
    // authority arrives — stays unavailable because mock
    act(() => { state.health = { status: "ok", mode: "mock", dockerReachable: false, lastUpdated: 2, modelRevision: "test-revision", snapshotVersion: "mock" }; state.modelProvenance = "mock"; root!.render(shell("/")); });
    expect(target.querySelectorAll(".svc-res .bar")).toHaveLength(0);
    expect(target.querySelector(".svc-res")!.textContent).toBe("CPU not collected");
  });

  it("opens the Resources tab by interaction and renders non-collection", () => {
    state.demoMode = false; state.health = { status: "ok", mode: "docker", dockerReachable: true, lastUpdated: 1, modelRevision: "test-revision", snapshotVersion: "live" }; state.model = liveModel; state.modelProvenance = "live";
    const target = render("/services/prod-secret-host");
    expect(target.querySelector(".panel-resources")).toBeNull();
    const tab = Array.from(target.querySelectorAll<HTMLButtonElement>("[role=tab]")).find((button) => button.textContent?.includes("Resources"));
    act(() => tab!.click());
    expect(target.querySelector(".panel-resources")!.textContent).toContain("Current Docker resource telemetry is not available for this model.");
    expect(target.querySelectorAll(".panel-resources .bar, .panel-resources .spark")).toHaveLength(0);
  });
});
