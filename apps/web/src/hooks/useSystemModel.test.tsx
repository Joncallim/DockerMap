// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DockerSnapshot, RuntimeMap } from "@dockermap/contracts";
import { useSystemModel } from "./useSystemModel";

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
  lastUpdated: 1
};
const snapV2: DockerSnapshot = {
  ...snapV1,
  containers: [
    { id: "c1", name: "web-v2", image: "nginx:2", status: "running", role: "web", networks: [], ports: [], mounts: [], dependsOn: [] }
  ],
  lastUpdated: 2
};
const runtimeV1: RuntimeMap = { nodes: [], edges: [], diagnostics: [], lastUpdated: 1 };
const runtimeV2: RuntimeMap = { nodes: [], edges: [], diagnostics: [], lastUpdated: 2 };

type PendingRequest = { url: string; resolve: (value: Response) => void; reject: (reason: Error) => void };
const pending: PendingRequest[] = [];

function jsonResponse(data: unknown): Response {
  return { ok: true, json: async () => data } as Response;
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
    const hook = renderHook((tick: number) => useSystemModel(tick), 0 as number);
    await hook.mount();
    expect(pending).toHaveLength(2);
    const [snapshotReq, runtimeReq] = pending.splice(0);
    snapshotReq.resolve(jsonResponse(snapV1));
    runtimeReq.resolve(jsonResponse(runtimeV1));
    await flush();
    expect(hook.result.current.model?.lastUpdated).toBe(1);
    expect(hook.result.current.model?.services[0].name).toBe("web");
    expect(hook.result.current.error).toBeNull();

    // Refresh tick: the snapshot request fails, the runtime map succeeds.
    await hook.rerender(1);
    expect(pending).toHaveLength(2);
    const [snapshotReq2, runtimeReq2] = pending.splice(0);
    snapshotReq2.reject(new Error("snapshot exploded"));
    runtimeReq2.resolve(jsonResponse(runtimeV2));
    await flush();

    // The model is retained with the PRIOR data, and the error is surfaced.
    expect(hook.result.current.model).not.toBeNull();
    expect(hook.result.current.model?.lastUpdated).toBe(1);
    expect(hook.result.current.model?.services[0].name).toBe("web");
    expect(hook.result.current.error).toBe("snapshot exploded");

    // A later successful refresh clears the error and publishes the new model.
    await hook.rerender(2);
    const [snapshotReq3, runtimeReq3] = pending.splice(0);
    snapshotReq3.resolve(jsonResponse(snapV2));
    runtimeReq3.resolve(jsonResponse(runtimeV2));
    await flush();
    expect(hook.result.current.model?.lastUpdated).toBe(2);
    expect(hook.result.current.model?.services[0].name).toBe("web-v2");
    expect(hook.result.current.error).toBeNull();
  });

  it("still shows the error state when the FIRST load fails (no prior model to retain)", async () => {
    const hook = renderHook((tick: number) => useSystemModel(tick), 0 as number);
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
  it("keeps the previous model while one resource settles ahead of the other", async () => {
    const hook = renderHook((tick: number) => useSystemModel(tick), 0 as number);
    await hook.mount();
    const [s1, r1] = pending.splice(0);
    s1.resolve(jsonResponse(snapV1));
    r1.resolve(jsonResponse(runtimeV1));
    await flush();
    expect(hook.result.current.model?.lastUpdated).toBe(1);

    // Refresh: the SNAPSHOT settles first with new data while the runtime map
    // still carries the previous generation — the model must NOT be rebuilt
    // from the mixed pair (new snapshot + old runtime map).
    await hook.rerender(1);
    const [s2, r2] = pending.splice(0);
    s2.resolve(jsonResponse(snapV2));
    await flush();
    expect(hook.result.current.model?.lastUpdated).toBe(1);
    expect(hook.result.current.model?.services[0].name).toBe("web");

    // The runtime map settles on the same generation → atomic replacement.
    r2.resolve(jsonResponse(runtimeV2));
    await flush();
    expect(hook.result.current.model?.lastUpdated).toBe(2);
    expect(hook.result.current.model?.services[0].name).toBe("web-v2");
  });

  it("never pairs a failed resource's stale data with a fresh peer", async () => {
    const hook = renderHook((tick: number) => useSystemModel(tick), 0 as number);
    await hook.mount();
    const [s1, r1] = pending.splice(0);
    s1.resolve(jsonResponse(snapV1));
    r1.resolve(jsonResponse(runtimeV1));
    await flush();
    expect(hook.result.current.model?.lastUpdated).toBe(1);

    // Refresh: the snapshot FAILS (stale gen-1 data retained) while the
    // runtime map succeeds with gen-2 data. The generations differ, so the
    // stale snapshot must never pair with the fresh runtime map.
    await hook.rerender(1);
    const [s2, r2] = pending.splice(0);
    s2.reject(new Error("snapshot exploded"));
    r2.resolve(jsonResponse(runtimeV2));
    await flush();
    expect(hook.result.current.model?.lastUpdated).toBe(1);
    expect(hook.result.current.model?.services[0].name).toBe("web");
    expect(hook.result.current.error).toBe("snapshot exploded");

    // Next refresh succeeds on both sides → the pair realigns atomically.
    await hook.rerender(2);
    const [s3, r3] = pending.splice(0);
    s3.resolve(jsonResponse(snapV2));
    r3.resolve(jsonResponse(runtimeV2));
    await flush();
    expect(hook.result.current.model?.lastUpdated).toBe(2);
    expect(hook.result.current.model?.services[0].name).toBe("web-v2");
    expect(hook.result.current.error).toBeNull();
  });
});
