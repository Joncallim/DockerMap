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
import Changes from "./Changes";
import Home from "./Home";

const runtime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], lastUpdated: 0 };
// Offline live fixture named EXACTLY prod-secret-host (DM-05 sentinel):
// authority-only gating would deterministically fabricate a leaking failure
// row under demo authority; the provenance gate must keep this real host
// name off every sample-labelled surface until demo bytes actually land.
const liveSnapshot: DockerSnapshot = { containers: [{ id: "prod-secret-host", name: "prod-secret-host", image: "nginx:1", status: "Exited (1)", role: "api", networks: [], ports: [], mounts: [], dependsOn: [] }], images: [], networks: [], volumes: [], lastUpdated: 0 };
const demoModel = buildModel(getDemoResponse("/api/snapshot"), runtime);
const liveModel = buildModel(liveSnapshot, runtime);

const state = vi.hoisted(() => ({ demoMode: true, health: null as HealthResponse | null, model: null as SystemModel | null, modelProvenance: null as ModelProvenance | null }));
vi.mock("../hooks/useSettings", () => ({ useSettings: () => ({ settings: { theme: "system", density: "comfortable", refreshIntervalMs: 2000, defaultRoute: "/", demoMode: state.demoMode, auth: { showStatus: false, provider: "authelia", loginUrl: "", logoutUrl: "" } } satisfies Settings, updateSettings: () => {}, resetSettings: () => {} }) }));
vi.mock("../hooks/useDaemonHeartbeat", () => ({ useDaemonHeartbeat: () => ({ tick: 0, health: state.health }) }));
// Mocked useSystemModel publishes BOTH model fields — the provenance travels
// WITH the model, so the test drives the pair explicitly (V2).
vi.mock("../hooks/useSystemModel", () => ({ useSystemModel: () => ({ model: state.model, modelProvenance: state.modelProvenance, loading: false, error: null }) }));
vi.mock("../hooks/useApiResource", () => ({ useApiResource: () => ({ data: null, loading: false, error: null, generation: 0, provenance: null }) }));
let root: Root | null = null; let host: HTMLDivElement | null = null;
beforeEach(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; window.matchMedia = vi.fn(() => ({ matches: false, media: "", onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })) as unknown as typeof window.matchMedia; });
afterEach(() => { root?.unmount(); host?.remove(); root = null; host = null; });
function shell(path: "/" | "/changes") { return <MemoryRouter initialEntries={[path]}><Routes><Route element={<AppShell onBearerSignOut={() => {}} />}><Route path="/" element={<Home />} /><Route path="/changes" element={<Changes />} /></Route></Routes></MemoryRouter>; }
function render(path: "/" | "/changes") { host = document.createElement("div"); document.body.append(host); root = createRoot(host); act(() => root!.render(shell(path))); return host; }
function rerender(path: "/" | "/changes") { act(() => root!.render(shell(path))); }

describe("history wiring — model/provenance held fixed while ONLY the mode flips (G-36)", () => {
  it.each([["/"], ["/changes"]] as const)("live→demo: retained live model stays off the sample surface until demo bytes land (%s)", (path) => {
    state.demoMode = false;
    state.health = { status: "ok", mode: "docker", dockerReachable: true, lastUpdated: 1, snapshotVersion: "live" };
    state.model = liveModel;
    state.modelProvenance = "daemon";
    const target = render(path);
    expect(target.querySelectorAll(".feed-row, .timeline-row").length).toBe(0);
    expect(target.textContent).toContain("Not collected");

    // Flip ONLY demoMode — health, model, and provenance stay the live pair.
    // An authority-only gate would fabricate a prod-secret-host failure row
    // right here; the provenance gate must keep the sample surfaces empty.
    state.demoMode = true;
    rerender(path);
    expect(target.querySelector(".conn-mode")!.textContent).toBe("Demo Engine");
    expect(target.querySelectorAll(".feed-row, .timeline-row").length).toBe(0);
    expect(target.querySelectorAll(".filter-chip").length).toBe(0);
    expect(target.textContent).not.toContain("Sample data");
    expect(target.textContent).toContain("Not collected");
    // DM-06 scoping: Home legitimately renders the RETAINED live model's own
    // (non-sample) surfaces — metrics, attention list, service map — so the
    // real-name sentinel assertion targets the sample-labelled panels only.
    if (path === "/") {
      expect(target.querySelector(".panel-recent-change")!.textContent).not.toContain("prod-secret-host");
      expect(target.querySelector(".panel-causal-chain")!.textContent).not.toContain("prod-secret-host");
    } else {
      expect(target.textContent).not.toContain("prod-secret-host");
    }

    // Separate act(): the demo model + demo provenance publish (mode stays
    // demo) — tagged sample rows resume only now.
    state.model = demoModel;
    state.modelProvenance = "demo";
    rerender(path);
    expect(target.querySelectorAll(".feed-row, .timeline-row").length).toBeGreaterThan(0);
    expect(target.textContent).toContain("Sample data");
  });

  it.each([["/"], ["/changes"]] as const)("demo→live fails closed with the demo model still held (%s)", (path) => {
    state.demoMode = true;
    state.health = { status: "ok", mode: "docker", dockerReachable: true, lastUpdated: 1, snapshotVersion: "live" };
    state.model = demoModel;
    state.modelProvenance = "demo";
    const target = render(path);
    expect(target.querySelectorAll(".feed-row, .timeline-row").length).toBeGreaterThan(0);
    expect(target.textContent).toContain("Sample data");

    // Flip ONLY demoMode — model and provenance stay the demo pair. Live
    // authority (host) must fail closed: no rows, no chips, no Sample label.
    state.demoMode = false;
    rerender(path);
    expect(target.querySelector(".conn-mode")!.textContent).toBe("Docker Engine");
    expect(target.querySelectorAll(".feed-row, .timeline-row").length).toBe(0);
    expect(target.querySelectorAll(".filter-chip").length).toBe(0);
    expect(target.textContent).not.toContain("Sample data");
    expect(target.textContent).toContain("Not collected");
  });

  it("null authority and same-mode generation changes remain unavailable", () => {
    state.demoMode = false; state.health = null; state.model = liveModel; state.modelProvenance = "daemon";
    const target = render("/changes");
    expect(target.textContent).toContain("Not collected");
    expect(target.querySelectorAll(".timeline-row").length).toBe(0);

    // Same-mode generation change under live authority: a fresh model object
    // with the same provenance still has no synthetic history (host arm).
    act(() => { state.model = buildModel({ ...liveSnapshot, lastUpdated: 5 }, runtime); root!.render(shell("/changes")); });
    expect(target.querySelectorAll(".timeline-row").length).toBe(0);
    expect(target.textContent).toContain("Not collected");
  });
});
