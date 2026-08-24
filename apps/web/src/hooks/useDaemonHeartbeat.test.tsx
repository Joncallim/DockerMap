// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthResponse } from "@dockermap/contracts";
import { useDaemonHeartbeat } from "./useDaemonHeartbeat";
import { resetSettings, updateSettings } from "../lib/settingsStore";

// P1-1 lock: the demo→live flip must null stale demo health (whose mode claims
// "mock") at the non-demo branch entry, fail-closed Unknown until the first
// real snapshot. AppShell.test.tsx asserts the rendered consequence; this file
// asserts the mechanism — setHealth(null) firing on the transition.

const liveSnapshot: HealthResponse = {
  status: "ok",
  mode: "docker",
  dockerReachable: true,
  lastUpdated: 4,
  snapshotVersion: "live"
};

/** jsdom has no EventSource; stub one that records instances and can fire events. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  private listeners = new Map<string, (event: unknown) => void>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, callback: (event: unknown) => void) {
    this.listeners.set(type, callback);
  }
  close() {
    FakeEventSource.instances = FakeEventSource.instances.filter((instance) => instance !== this);
  }
  fire(type: string, event: unknown) {
    this.listeners.get(type)?.(event);
  }
}

let probeHealth: HealthResponse | null = null;
function Probe() {
  probeHealth = useDaemonHeartbeat().health;
  return null;
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  resetSettings(); // demoMode false, per DEFAULT_SETTINGS
});

afterEach(() => {
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
  vi.unstubAllGlobals();
});

function mountProbe() {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<Probe />);
  });
}

describe("useDaemonHeartbeat demo→live transition (P1-1)", () => {
  it("nulls stale demo health on demo→live and opens a fresh stream; a snapshot then restores live health", () => {
    mountProbe(); // live path from the start: stream #1 open, health null
    expect(probeHealth).toBeNull();
    expect(FakeEventSource.instances.length).toBe(1);

    act(() => {
      updateSettings({ demoMode: true });
    });
    // Demo branch: health becomes demo health, which CLAIMS mode "mock".
    expect(probeHealth?.mode).toBe("mock");
    // The live stream was closed by the effect cleanup when demoMode changed.
    expect(FakeEventSource.instances.length).toBe(0);

    act(() => {
      updateSettings({ demoMode: false });
    });
    // P1-1: setHealth(null) fired at the non-demo branch entry — the stale
    // demo health must NOT survive; mode stays Unknown until a snapshot.
    expect(probeHealth).toBeNull();
    expect(FakeEventSource.instances.length).toBe(1);
    expect(FakeEventSource.instances[0].url).toContain("/api/events/stream");

    act(() => {
      FakeEventSource.instances[0].fire("snapshot", { data: JSON.stringify(liveSnapshot) });
    });
    expect(probeHealth?.mode).toBe("docker");
  });
});
