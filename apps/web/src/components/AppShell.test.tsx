// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthResponse } from "@dockermap/contracts";
import AppShell from "./AppShell";
import type { Settings } from "../lib/settingsStore";

// Wiring regression locks (P2-3) for the mode pill and the connection dot.
// These render the REAL AppShell (not modeLabel in isolation) with mocked
// hooks, so they prove the pill is fed by resolveEvidenceMode + the dot by
// connReachable — the wiring through which P1-1's stale demo health used to
// surface as "Mock Engine" after a demo→live flip (12 passes never caught it).

const demoHealth: HealthResponse = {
  status: "ok",
  mode: "mock", // demoData.ts:176 — demo health claims mock mode
  dockerReachable: true, // demoData.ts:177 — NOT trustworthy in demo
  lastUpdated: 1,
  snapshotVersion: "demo"
};
const liveHealth: HealthResponse = {
  status: "ok",
  mode: "docker",
  dockerReachable: true,
  lastUpdated: 2,
  snapshotVersion: "live"
};
const mockHealth: HealthResponse = {
  status: "degraded",
  mode: "mock",
  dockerReachable: false,
  lastUpdated: 3,
  snapshotVersion: "mock"
};

const mocks = vi.hoisted(() => {
  const baseSettings: Settings = {
    theme: "system",
    density: "comfortable",
    refreshIntervalMs: 2_000,
    defaultRoute: "/",
    demoMode: false,
    auth: { showStatus: false, provider: "authelia", loginUrl: "", logoutUrl: "" }
  };
  return {
    baseSettings,
    settings: { demoMode: false },
    heartbeat: { health: null as HealthResponse | null, tick: 0 },
    model: { model: null, loading: false, error: null },
    api: { data: null, error: null, loading: false, generation: 0 }
  };
});

vi.mock("../hooks/useSettings", () => ({
  useSettings: () => ({
    settings: { ...mocks.baseSettings, demoMode: mocks.settings.demoMode },
    updateSettings: () => {},
    resetSettings: () => {}
  })
}));

vi.mock("../hooks/useDaemonHeartbeat", () => ({
  useDaemonHeartbeat: () => ({ tick: mocks.heartbeat.tick, health: mocks.heartbeat.health })
}));

vi.mock("../hooks/useSystemModel", () => ({
  useSystemModel: () => mocks.model
}));

vi.mock("../hooks/useApiResource", () => ({
  useApiResource: () => mocks.api
}));

let host: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  // jsdom does not implement window.matchMedia; AppShell's theme effect needs it.
  window.matchMedia = vi.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
  vi.unstubAllGlobals();
});

function renderAppShell() {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="*" element={<AppShell onBearerSignOut={() => {}} />} />
        </Routes>
      </MemoryRouter>
    );
  });
  return host;
}

/** Re-renders the same tree so the mocked hook values are re-read. */
function rerenderAppShell() {
  act(() => {
    root!.render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="*" element={<AppShell onBearerSignOut={() => {}} />} />
        </Routes>
      </MemoryRouter>
    );
  });
}

const pillText = (hostEl: HTMLDivElement) => hostEl.querySelector(".conn-mode")!.textContent;
const connDot = (hostEl: HTMLDivElement) => hostEl.querySelector<HTMLElement>(".conn .state-dot")!;

describe("AppShell mode-pill and connection-dot wiring", () => {
  it("(a) demo mode renders the Demo pill and a neutral NON-pulsing dot even with dockerReachable: true", () => {
    mocks.settings.demoMode = true;
    mocks.heartbeat.health = demoHealth; // dockerReachable: true must NOT drive the dot (U5)
    const hostEl = renderAppShell();

    expect(pillText(hostEl)).toBe("Demo Engine");
    // No connection can exist in demo (api.ts:30 short-circuits before any
    // fetch), so the dot is neutral unknown — never a pulsing green healthy.
    expect(hostEl.querySelector(".conn")!.classList.contains("conn-down")).toBe(true);
    const dot = connDot(hostEl);
    expect(dot.classList.contains("s-unknown")).toBe(true);
    expect(dot.classList.contains("s-healthy")).toBe(false);
    expect(dot.classList.contains("is-pulse")).toBe(false);
    expect(dot.getAttribute("aria-label")).toBe("Unknown");
  });

  it("(b) mock health renders Mock Engine with an offline dot", () => {
    mocks.settings.demoMode = false;
    mocks.heartbeat.health = mockHealth;
    const hostEl = renderAppShell();

    expect(pillText(hostEl)).toBe("Mock Engine");
    expect(hostEl.querySelector(".conn")!.classList.contains("conn-down")).toBe(true);
    const dot = connDot(hostEl);
    expect(dot.classList.contains("s-offline")).toBe(true);
    expect(dot.classList.contains("is-pulse")).toBe(false);
  });

  it("(b) live health renders Docker Engine with a pulsing reachable dot", () => {
    mocks.settings.demoMode = false;
    mocks.heartbeat.health = liveHealth;
    const hostEl = renderAppShell();

    expect(pillText(hostEl)).toBe("Docker Engine");
    expect(hostEl.querySelector(".conn")!.classList.contains("conn-up")).toBe(true);
    const dot = connDot(hostEl);
    expect(dot.classList.contains("s-healthy")).toBe(true);
    expect(dot.classList.contains("is-pulse")).toBe(true);
  });

  it("(b) null health (authority not established) renders Unknown Engine — never Mock", () => {
    mocks.settings.demoMode = false;
    mocks.heartbeat.health = null;
    const hostEl = renderAppShell();

    expect(pillText(hostEl)).toBe("Unknown Engine");
    expect(pillText(hostEl)).not.toBe("Mock Engine");
    const dot = connDot(hostEl);
    expect(dot.classList.contains("s-offline")).toBe(true);
    expect(dot.classList.contains("is-pulse")).toBe(false);
  });

  it("(c) P1-1: demo→live with no snapshot yet shows Unknown Engine, never Mock from stale demo health", () => {
    // Start in demo with demo health in place (mode "mock", dockerReachable true).
    mocks.settings.demoMode = true;
    mocks.heartbeat.health = demoHealth;
    const hostEl = renderAppShell();
    expect(pillText(hostEl)).toBe("Demo Engine");

    // Flip demo off. The heartbeat's live branch nulls health via setHealth(null)
    // BEFORE the stream opens (useDaemonHeartbeat.ts, P1-1), so until the first
    // real snapshot the mode must be Unknown — stale demo health (which claims
    // mock) must never survive into the live window. The heartbeat-level
    // assertion that setHealth(null) actually fires lives in
    // useDaemonHeartbeat.test.tsx.
    mocks.settings.demoMode = false;
    mocks.heartbeat.health = null; // no snapshot has arrived yet
    rerenderAppShell();

    expect(pillText(hostEl)).toBe("Unknown Engine");
    expect(pillText(hostEl)).not.toBe("Mock Engine");
    const dot = connDot(hostEl);
    expect(dot.classList.contains("s-offline")).toBe(true);
    expect(dot.classList.contains("s-healthy")).toBe(false);
    expect(dot.classList.contains("is-pulse")).toBe(false);
  });
});
