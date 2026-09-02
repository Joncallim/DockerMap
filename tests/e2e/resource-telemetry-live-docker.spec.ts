import { expect, test } from "@playwright/test";
import { SkipLiveDockerError, startLiveDockerStack, type Stack } from "./dockermapHarness";

type Metric = { value: number; observedAtMs: number; expiresAtMs: number };
type TelemetrySample = {
  containerId: string;
  cpuPercent: Metric | null;
  memoryUsedBytes: Metric | null;
  memoryLimitBytes: Metric | null;
  networkRxBytesPerSecond: Metric | null;
  networkTxBytesPerSecond: Metric | null;
};
type Telemetry = {
  source: string;
  collectionState: string;
  currentModelRevision: string | null;
  currentObservationRevision: string | null;
  samples: TelemetrySample[];
};

const telemetryPaths = ["/api/resource-telemetry", "/api/v1/resource-telemetry"] as const;
const token = "dockermap-unfiltered-telemetry-e2e-token";

test("collects bounded opaque Docker telemetry through the unfiltered fixture gateway @live-docker @unfiltered-telemetry", async () => {
  test.skip(
    process.env.DOCKERMAP_E2E_LIVE_DOCKER !== "1" || process.env.DOCKERMAP_E2E_UNFILTERED_TELEMETRY !== "1",
    "Set DOCKERMAP_E2E_LIVE_DOCKER=1 and DOCKERMAP_E2E_UNFILTERED_TELEMETRY=1 to run the isolated unfiltered telemetry fixture.",
  );

  let stack: Stack | undefined;
  try {
    try {
      stack = await startLiveDockerStack({ apiToken: token, fixtureProfile: "unfiltered-telemetry" });
    } catch (error) {
      if (error instanceof SkipLiveDockerError) test.skip(true, error.message);
      throw error;
    }
    const headers = { Authorization: `Bearer ${token}` };

    // The browser-facing API and its v1 alias both retain their bearer gate.
    // This never renders or serializes the unfiltered snapshot.
    for (const path of telemetryPaths) {
      expect((await fetch(`${stack.apiUrl}${path}`)).status, `${path} without token`).toBe(401);
      expect(
        (await fetch(`${stack.apiUrl}${path}`, { headers: { Authorization: "Bearer wrong-token" } })).status,
        `${path} with wrong token`,
      ).toBe(401);
    }

    // This helper builds the target itself from the owned fixture's API
    // container, sends exactly the gateway's finite shape, and discards the
    // Docker response body.
    expect(await stack.requestOwnedFixtureStats?.(), "fixed finite gateway stats request").toBe(200);

    const current = await pollTelemetry(stack, telemetryPaths[0], headers);
    assertBoundedOpaqueTelemetry(current);

    const v1 = await getJson<Telemetry>(`${stack.apiUrl}${telemetryPaths[1]}`, headers);
    assertBoundedOpaqueTelemetry(v1);

    // Every public sample must still be attached to the current live model;
    // only opaque node IDs cross this assertion boundary.
    const runtimeMap = await getJson<{ source: string; nodes: Array<{ id: string }> }>(
      `${stack.apiUrl}/api/runtime/map`,
      headers,
    );
    expect(runtimeMap.source).toBe("docker");
    const publicNodeIds = new Set(runtimeMap.nodes.map((node) => node.id));
    for (const sample of current.samples) expect(publicNodeIds.has(sample.containerId)).toBe(true);

    // Closing only this fixture's gateway forces Docker -> mock fallback.
    // The response must clear retained samples and revision anchors instead of
    // relabeling live observations as mock data.
    await stack.stopDockerGateway?.();
    await expect.poll(
      async () => (await getJson<{ mode: string }>(`${stack.apiUrl}/api/health`, headers)).mode,
      { timeout: 15_000 },
    ).toBe("mock");
    for (const path of telemetryPaths) {
      const reset = await getJson<Telemetry>(`${stack.apiUrl}${path}`, headers);
      // Keep reset failures value-free: a regression must not make a CI error
      // report serialize retained opaque IDs or metric values.
      expect(hasExactKeys(reset, [
        "source",
        "collectionState",
        "currentModelRevision",
        "currentObservationRevision",
        "samples",
      ])).toBe(true);
      expect(
        reset.source === "mock"
          && reset.collectionState === "unavailable"
          && reset.currentModelRevision === null
          && reset.currentObservationRevision === null
          && reset.samples.length === 0,
      ).toBe(true);
    }
  } finally {
    await stack?.stop();
  }
});

async function pollTelemetry(stack: Stack, path: string, headers: HeadersInit): Promise<Telemetry> {
  let value: Telemetry | undefined;
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    value = await getJson<Telemetry>(`${stack.apiUrl}${path}`, headers);
    if (value.collectionState === "fresh" && value.samples.length > 0) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  // These closed state facts are safe in a failure report; never attach or
  // serialize the telemetry payload, Docker snapshot, names, or raw IDs.
  throw new Error(`Timed out waiting for fresh telemetry (state=${value?.collectionState ?? "missing"}, samples=${value?.samples.length ?? 0}).`);
}

function assertBoundedOpaqueTelemetry(value: Telemetry) {
  expect(hasExactKeys(value, [
    "source",
    "collectionState",
    "currentModelRevision",
    "currentObservationRevision",
    "samples",
  ])).toBe(true);
  expect(value.source).toBe("docker");
  expect(value.collectionState).toBe("fresh");
  expect(/^\S{1,64}$/.test(value.currentModelRevision ?? "")).toBe(true);
  expect(/^\S{1,64}$/.test(value.currentObservationRevision ?? "")).toBe(true);
  expect(value.samples.length).toBeGreaterThan(0);
  expect(value.samples.length).toBeLessThanOrEqual(16);
  for (const sample of value.samples) {
    expect(hasExactKeys(sample, [
      "containerId",
      "cpuPercent",
      "memoryUsedBytes",
      "memoryLimitBytes",
      "networkRxBytesPerSecond",
      "networkTxBytesPerSecond",
    ])).toBe(true);
    expect(/^docker_container_[0-9a-f]{64}$/.test(sample.containerId)).toBe(true);
    const metrics = [
      sample.cpuPercent,
      sample.memoryUsedBytes,
      sample.memoryLimitBytes,
      sample.networkRxBytesPerSecond,
      sample.networkTxBytesPerSecond,
    ].filter((metric): metric is Metric => metric !== null);
    expect(metrics.length).toBeGreaterThan(0);
    for (const metric of metrics) {
      expect(hasExactKeys(metric, ["value", "observedAtMs", "expiresAtMs"])).toBe(true);
      expect(Number.isSafeInteger(metric.value) && metric.value >= 0).toBe(true);
      expect(Number.isSafeInteger(metric.observedAtMs)).toBe(true);
      expect(metric.expiresAtMs - metric.observedAtMs).toBe(8_000);
    }
  }
}

function hasExactKeys(value: object, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

async function getJson<T>(url: string, headers: HeadersInit): Promise<T> {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`Authenticated fixture request returned ${response.status}.`);
  return await response.json() as T;
}
