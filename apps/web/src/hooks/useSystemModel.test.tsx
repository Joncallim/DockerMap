// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DockerSnapshot, RuntimeMap } from "@dockermap/contracts";
import type { Settings } from "../lib/settingsStore";
import { answer } from "../lib/copilot";
import { useSystemModel } from "./useSystemModel";

// Settings demoMode is hoisted so a test can flip the transport mid-run and
// prove that a split snapshot/runtime provenance pair publishes NO model pair.
const settings = vi.hoisted(() => ({ demoMode: false }));
vi.mock("./useSettings", () => ({
  useSettings: () => ({
    settings: { theme: "system", density: "comfortable", refreshIntervalMs: 2000, defaultRoute: "/", demoMode: settings.demoMode, auth: { showStatus: false, provider: "authelia", loginUrl: "", logoutUrl: "" } } satisfies Settings,
    updateSettings: () => {},
    resetSettings: () => {}
  })
}));

/**
 * Hook-level regression tests for the atomic-refresh contract:
 *
 * - A TRANSIENT refresh failure must retain the LAST successful data (error
 *   set, model kept) — only a FIRST load failure clears the model.
 * - The snapshot and runtime-map requests settle independently, so the model
 *   must only be rebuilt from a SAME-GENERATION pair; a mismatched pair keeps
 *   the previous model instead of publishing one NEW + one OLD resource.
 */

const snapV1: DockerSnapshot = {
  containers: [
    { id: "c1", name: "web", image: "nginx:1", status: "running", role: "web", networks: [], ports: [], mounts: [], dependsOn: [] }
  ],
  images: [],
  networks: [],
  volumes: [],
  lastUpdated: 1,
  modelRevision: "revision-1"
};
const snapV2: DockerSnapshot = {
  ...snapV1,
  containers: [
    { id: "c1", name: "web-v2", image: "nginx:2", status: "running", role: "web", networks: [], ports: [], mounts: [], dependsOn: [] }
  ],
  lastUpdated: 2,
  modelRevision: "revision-2"
};
const runtimeV1: RuntimeMap = { nodes: [], edges: [], diagnostics: [], lastUpdated: 1, modelRevision: "revision-1", providerStates: [] };
const runtimeV2: RuntimeMap = { nodes: [], edges: [], diagnostics: [], lastUpdated: 2, modelRevision: "revision-2", providerStates: [] };

type PendingRequest = { url: string; resolve: (value: Response) => void; reject: (reason: Error) => void };
const pending: PendingRequest[] = [];

function jsonResponse(data: unknown): Response {
  return { ok: true, json: async () => data } as Response;
}

/** Normal non-demo model fixtures must attest the daemon bytes they model. */
function dockerResponse(data: object): Response {
  return jsonResponse({ ...data, source: "docker" });
}

function mockResponse(data: object): Response {
  return jsonResponse({ ...data, source: "mock" });
}

function renderHook<Props, Result>(hook: (props: Props) => Result, initialProps: Props) {
  const result: { current: Result } = { current: undefined as unknown as Result };
  // Props flow through a ref so the wrapper component itself stays
  // prop-less (avoids generic JSX/createElement inference in the test).
  const propsRef: { current: Props } = { current: initialProps };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const Wrapper = () => {
    result.current = hook(propsRef.current);
    return null;
  };
  return {
    result,
    async mount() {
      await act(async () => {
        root.render(createElement(Wrapper));
      });
    },
    async rerender(props: Props) {
      propsRef.current = props;
      await act(async () => {
        root.render(createElement(Wrapper));
      });
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  pending.length = 0;
  settings.demoMode = false;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      return new Promise<Response>((resolve, reject) => {
        pending.push({ url, resolve, reject });
      });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useSystemModel retains the last model across refresh failures", () => {
  it("keeps model + prior data and sets the error when a REFRESH fails after an initial success", async () => {
    const hook = renderHook((tick: number) => useSystemModel(tick, "live"), 0 as number);
    await hook.mount();
    expect(pending).toHaveLength(2);
    const [snapshotReq, runtimeReq] = pending.splice(0);
    snapshotReq.resolve(dockerResponse(snapV1));
    runtimeReq.resolve(dockerResponse(runtimeV1));
    await flush();
    expect(hook.result.current.model?.lastUpdated).toBe(1);
    expect(hook.result.current.model?.services[0].name).toBe("web");
    expect(hook.result.current.error).toBeNull();

    // Refresh tick: the snapshot request fails, the runtime map succeeds.
    await hook.rerender(1);
    expect(pending).toHaveLength(2);
    const [snapshotReq2, runtimeReq2] = pending.splice(0);
    snapshotReq2.reject(new Error("snapshot exploded"));
    runtimeReq2.resolve(dockerResponse(runtimeV2));
    await flush();

    // The model is retained with the PRIOR data, and the error is surfaced.
    expect(hook.result.current.model).not.toBeNull();
    expect(hook.result.current.model?.lastUpdated).toBe(1);
    expect(hook.result.current.model?.services[0].name).toBe("web");
    expect(hook.result.current.error).toBe("snapshot exploded");

    // A later successful refresh clears the error and publishes the new model.
    await hook.rerender(2);
    const [snapshotReq3, runtimeReq3] = pending.splice(0);
    snapshotReq3.resolve(dockerResponse(snapV2));
    runtimeReq3.resolve(dockerResponse(runtimeV2));
    await flush();
    expect(hook.result.current.model?.lastUpdated).toBe(2);
    expect(hook.result.current.model?.services[0].name).toBe("web-v2");
    expect(hook.result.current.error).toBeNull();
  });

  it("still shows the error state when the FIRST load fails with unresolved source (no prior model to retain)", async () => {
    const hook = renderHook((tick: number) => useSystemModel(tick, null), 0 as number);
    await hook.mount();
    const [snapshotReq, runtimeReq] = pending.splice(0);
    snapshotReq.resolve(jsonResponse(snapV1));
    runtimeReq.reject(new Error("runtime exploded"));
    await flush();

    expect(hook.result.current.model).toBeNull();
    expect(hook.result.current.error).toBe("runtime exploded");
    expect(hook.result.current.loading).toBe(false);
  });
});

describe("useSystemModel rebuilds only from a same-generation pair", () => {
  it("requires equal non-empty daemon model revisions without changing fetch cadence", async () => {
    const hook = renderHook((tick: number) => useSystemModel(tick, "live"), 0 as number);
    await hook.mount();
    expect(pending).toHaveLength(2);
    const [s1, r1] = pending.splice(0);
    s1.resolve(dockerResponse(snapV1));
    r1.resolve(dockerResponse({ ...runtimeV1, modelRevision: "different" }));
    await flush();
    expect(hook.result.current.model).toBeNull();

    await hook.rerender(1);
    // Revisions gate publication only; both resources keep their normal
    // request cadence and are fetched again together.
    expect(pending).toHaveLength(2);
    const [s2, r2] = pending.splice(0);
    s2.resolve(dockerResponse({ ...snapV2, modelRevision: "" }));
    r2.resolve(dockerResponse(runtimeV2));
    await flush();
    expect(hook.result.current.model).toBeNull();
  });

  it("keeps the previous model while one resource settles ahead of the other", async () => {
    const hook = renderHook((tick: number) => useSystemModel(tick, "live"), 0 as number);
    await hook.mount();
    const [s1, r1] = pending.splice(0);
    s1.resolve(dockerResponse(snapV1));
    r1.resolve(dockerResponse(runtimeV1));
    await flush();
    expect(hook.result.current.model?.lastUpdated).toBe(1);

    // Refresh: the SNAPSHOT settles first with new data while the runtime map
    // still carries the previous generation — the model must NOT be rebuilt
    // from the mixed pair (new snapshot + old runtime map).
    await hook.rerender(1);
    const [s2, r2] = pending.splice(0);
    s2.resolve(dockerResponse(snapV2));
    await flush();
    expect(hook.result.current.model?.lastUpdated).toBe(1);
    expect(hook.result.current.model?.services[0].name).toBe("web");

    // The runtime map settles on the same generation → atomic replacement.
    r2.resolve(dockerResponse(runtimeV2));
    await flush();
    expect(hook.result.current.model?.lastUpdated).toBe(2);
    expect(hook.result.current.model?.services[0].name).toBe("web-v2");
  });

  it("retains the live model/source stamp until a complete mock pair settles", async () => {
    type Props = { tick: number; mode: "live" | "mock" };
    const hook = renderHook(({ tick, mode }: Props) => useSystemModel(tick, mode), { tick: 0, mode: "live" });
    await hook.mount();
    const [s1, r1] = pending.splice(0);
    s1.resolve(dockerResponse(snapV1));
    r1.resolve(dockerResponse(runtimeV1));
    await flush();
    expect(hook.result.current.model?.services[0].name).toBe("web");
    expect(hook.result.current.modelProvenance).toBe("live");

    // Health/mode changes first: requests restart for mock, while the retained
    // real model remains stamped live and therefore fails the sample gate.
    await hook.rerender({ tick: 0, mode: "mock" });
    expect(pending).toHaveLength(2);
    expect(hook.result.current.model?.services[0].name).toBe("web");
    expect(hook.result.current.modelProvenance).toBe("live");

    const [s2, r2] = pending.splice(0);
    s2.resolve(mockResponse(snapV2));
    await flush();
    expect(hook.result.current.model?.services[0].name).toBe("web");
    expect(hook.result.current.modelProvenance).toBe("live");

    r2.resolve(mockResponse(runtimeV2));
    await flush();
    expect(hook.result.current.model?.services[0].name).toBe("web-v2");
    expect(hook.result.current.modelProvenance).toBe("mock");
  });

  it("never pairs a failed resource's stale data with a fresh peer", async () => {
    const hook = renderHook((tick: number) => useSystemModel(tick, "live"), 0 as number);
    await hook.mount();
    const [s1, r1] = pending.splice(0);
    s1.resolve(dockerResponse(snapV1));
    r1.resolve(dockerResponse(runtimeV1));
    await flush();
    expect(hook.result.current.model?.lastUpdated).toBe(1);

    // Refresh: the snapshot FAILS (stale gen-1 data retained) while the
    // runtime map succeeds with gen-2 data. The generations differ, so the
    // stale snapshot must never pair with the fresh runtime map.
    await hook.rerender(1);
    const [s2, r2] = pending.splice(0);
    s2.reject(new Error("snapshot exploded"));
    r2.resolve(dockerResponse(runtimeV2));
    await flush();
    expect(hook.result.current.model?.lastUpdated).toBe(1);
    expect(hook.result.current.model?.services[0].name).toBe("web");
    expect(hook.result.current.error).toBe("snapshot exploded");

    // Next refresh succeeds on both sides → the pair realigns atomically.
    await hook.rerender(2);
    const [s3, r3] = pending.splice(0);
    s3.resolve(dockerResponse(snapV2));
    r3.resolve(dockerResponse(runtimeV2));
    await flush();
    expect(hook.result.current.model?.lastUpdated).toBe(2);
    expect(hook.result.current.model?.services[0].name).toBe("web-v2");
    expect(hook.result.current.error).toBeNull();
  });

  it("retains the prior attested pair while a refresh races into unresolved provenance", async () => {
    const hook = renderHook((tick: number) => useSystemModel(tick, "live"), 0 as number);
    await hook.mount();
    const [s1, r1] = pending.splice(0);
    s1.resolve(jsonResponse({ ...snapV1, source: "docker" }));
    r1.resolve(jsonResponse({ ...runtimeV1, source: "docker" }));
    await flush();
    expect(hook.result.current.model?.lastUpdated).toBe(1);
    expect(hook.result.current.modelProvenance).toBe("live");

    // The snapshot settles first without a stamp.  It must not combine with
    // the older attested runtime response or relabel that newer snapshot as
    // live while the pair is in flight.
    await hook.rerender(1);
    const [s2, r2] = pending.splice(0);
    s2.resolve(jsonResponse(snapV2));
    await flush();
    expect(hook.result.current.model?.lastUpdated).toBe(1);
    expect(hook.result.current.modelProvenance).toBe("live");

    // Once the matching un-stamped peer lands, the new bytes publish only as
    // unresolved and Copilot refuses to make a host claim from them.
    r2.resolve(jsonResponse(runtimeV2));
    await flush();
    expect(hook.result.current.model?.lastUpdated).toBe(2);
    expect(hook.result.current.modelProvenance).toBeNull();
    expect(answer(hook.result.current.model!, "show unhealthy services", "live", hook.result.current.modelProvenance).authorityUnresolved).toBe(true);
  });

  it("stamps route-local mock bytes as mock even when live was requested", async () => {
    // A3 (#85): the Node API can substitute getMockResponse() per route when
    // DOCKERMAP_ALLOW_MOCK=true. The RESPONSE attests its actual source via
    // `source: "mock"`; a live-requested fetch that resolves to fabricated
    // bytes must be stamped mock, never live — otherwise the model would be
    // mislabelled host data and pass the Copilot host-authority gate.
    const hook = renderHook((tick: number) => useSystemModel(tick, "live"), 0 as number);
    await hook.mount();
    const [s1, r1] = pending.splice(0);
    s1.resolve(jsonResponse({ ...snapV1, source: "mock" }));
    r1.resolve(jsonResponse({ ...runtimeV1, source: "mock" }));
    await flush();
    expect(hook.result.current.modelProvenance).toBe("mock");
    expect(hook.result.current.model?.services[0].name).toBe("web");
  });

  it("keeps live provenance when the response attests docker", async () => {
    const hook = renderHook((tick: number) => useSystemModel(tick, "live"), 0 as number);
    await hook.mount();
    const [s1, r1] = pending.splice(0);
    s1.resolve(jsonResponse({ ...snapV1, source: "docker" }));
    r1.resolve(jsonResponse({ ...runtimeV1, source: "docker" }));
    await flush();
    expect(hook.result.current.modelProvenance).toBe("live");
  });

  it.each([
    ["missing", undefined],
    ["invalid", "docker-ish"]
  ] as const)("fails closed when a live model response has a %s source stamp", async (_kind, source) => {
    // A requested live mode is only transport intent.  A response without an
    // exact daemon source stamp must remain renderable but unresolved, so it
    // cannot become a live-labelled Copilot claim (#165).
    const hook = renderHook((tick: number) => useSystemModel(tick, "live"), 0 as number);
    await hook.mount();
    const [snapshotRequest, runtimeRequest] = pending.splice(0);
    snapshotRequest.resolve(jsonResponse({ ...snapV1, ...(source === undefined ? {} : { source }) }));
    runtimeRequest.resolve(jsonResponse({ ...runtimeV1, ...(source === undefined ? {} : { source }) }));
    await flush();

    expect(hook.result.current.model).not.toBeNull();
    expect(hook.result.current.modelProvenance).toBeNull();
    const response = answer(hook.result.current.model!, "show unhealthy services", "live", hook.result.current.modelProvenance);
    expect(response.authorityUnresolved).toBe(true);
    expect(response.evidence).toBe("unavailable");
  });

  it("rejects a prototype-provided docker stamp", async () => {
    const hook = renderHook((tick: number) => useSystemModel(tick, "live"), 0 as number);
    await hook.mount();
    const [snapshotRequest, runtimeRequest] = pending.splice(0);
    const inheritedSnapshot = Object.assign(Object.create({ source: "docker" }), snapV1);
    const inheritedRuntime = Object.assign(Object.create({ source: "docker" }), runtimeV1);
    snapshotRequest.resolve(jsonResponse(inheritedSnapshot));
    runtimeRequest.resolve(jsonResponse(inheritedRuntime));
    await flush();

    expect(hook.result.current.modelProvenance).toBeNull();
    expect(answer(hook.result.current.model!, "show unhealthy services", "live", hook.result.current.modelProvenance).authorityUnresolved).toBe(true);
  });

  it("keeps Demo Mode deterministic when its fixture does not carry a daemon source stamp", async () => {
    settings.demoMode = true;
    const hook = renderHook((tick: number) => useSystemModel(tick, "demo"), 0 as number);
    await hook.mount();
    const [snapshotRequest, runtimeRequest] = pending.splice(0);
    snapshotRequest.resolve(jsonResponse(snapV1));
    runtimeRequest.resolve(jsonResponse(runtimeV1));
    await flush();

    expect(hook.result.current.model).not.toBeNull();
    expect(hook.result.current.modelProvenance).toBe("demo");
  });

  it("does not relabel an in-flight live response as demo when settings change", async () => {
    const hook = renderHook((tick: number) => useSystemModel(tick, "live"), 0 as number);
    await hook.mount();
    const [snapshotRequest, runtimeRequest] = pending.splice(0);

    // Model the setting changing after the request began but before its
    // callbacks settle.  The request's captured source context remains live;
    // response bytes must never acquire a Demo label merely because the UI has
    // started transitioning.
    settings.demoMode = true;
    snapshotRequest.resolve(dockerResponse(snapV1));
    runtimeRequest.resolve(dockerResponse(runtimeV1));
    await flush();

    expect(hook.result.current.modelProvenance).toBe("live");
  });
});
