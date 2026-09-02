import { expect, test } from "@playwright/test";
import { setTimeout as delay } from "node:timers/promises";
import { SkipLiveDockerError, startLiveDockerStack, type Stack } from "./dockermapHarness";

type ObservedEvent = {
  id: string;
  containerId: string;
  evidenceSource: string;
  kind: string;
  sourceOccurredAtMs: number;
};

type ObservedEventsResponse = {
  source: string;
  collectionState: string;
  currentModelRevision: string | null;
  currentObservationRevision: string | null;
  events: ObservedEvent[];
};

type TemporalFinding = {
  ruleId: string;
  severity: string;
  subjectRef: string;
  targetRef: string;
  evidenceRefs: unknown[];
  temporalEvidenceRefs: Array<{
    eventId: string;
    source: string;
    kind: string;
    sourceOccurredAtMs: number;
    anchorModelRevision: string;
    anchorObservationRevision: string;
  }>;
};

type FindingsResponse = { findings: TemporalFinding[]; modelRevision: string };

const temporalRule = "docker.repeated_container_died_events";

test.describe("Docker temporal observations", () => {
  let stack: Stack | null = null;

  test.afterEach(async () => {
    await stack?.stop();
    stack = null;
  });

  test("bounds polling timeout diagnostics without serializing API payloads", async () => {
    const sentinel = "DOCKERMAP_TEST_TIMEOUT_PAYLOAD_MUST_NOT_APPEAR";
    const timeout = await pollingFailure(
      () => pollJson(
        "safe timeout",
        async () => ({
          source: "docker",
          collectionState: "collecting",
          events: [{ raw: sentinel }],
          findings: [{ raw: sentinel }]
        }),
        () => false,
        1,
      ),
    );
    expect(timeout.message).toContain("source=docker");
    expect(timeout.message).toContain("collectionState=collecting");
    expect(timeout.message).toContain("eventCount=1");
    expect(timeout.message).toContain("findingCount=1");
    expect(timeout.message).not.toContain(sentinel);

    const requestFailure = await pollingFailure(
      () => pollJson(
        "safe request failure",
        async () => { throw new Error(`${sentinel}: http://private.example/`); },
        () => false,
        1,
      ),
    );
    expect(requestFailure.message).toContain("request failed");
    expect(requestFailure.message).not.toContain(sentinel);
  });

  test("publishes one authenticated repeated-die advisory from only its labelled fixture after gateway reconnect @live-docker", async () => {
    test.skip(!process.env.DOCKERMAP_E2E_LIVE_DOCKER, "Set DOCKERMAP_E2E_LIVE_DOCKER=1 to create live Docker fixtures.");

    try {
      stack = await startLiveDockerStack({ apiToken: "dockermap-temporal-live-e2e-token" });
    } catch (error) {
      if (error instanceof SkipLiveDockerError) test.skip(true, error.message);
      throw error;
    }

    const liveStack = stack;
    expect(liveStack.apiToken).toBeTruthy();
    expect(liveStack.restartFixtureWorker).toBeDefined();
    expect(liveStack.restartDockerGateway).toBeDefined();
    const auth = { Authorization: `Bearer ${liveStack.apiToken!}` };
    const observedUrl = `${liveStack.apiUrl}/api/observed-events`;
    const findingsUrl = `${liveStack.apiUrl}/api/findings`;

    // The endpoint is browser-facing but must retain its bearer boundary when
    // configured. The fixture token is static test data, not a host secret.
    expect((await fetch(observedUrl)).status).toBe(401);

    const initial = await pollJson<ObservedEventsResponse>(
      "live Docker event collection",
      () => getJson<ObservedEventsResponse>(observedUrl, auth),
      (response) => response.source === "docker"
        && response.collectionState === "collecting"
        && response.currentModelRevision !== null
        && response.currentObservationRevision !== null,
    );
    const initialDieIds = new Set(initial.events.filter((event) => event.kind === "container_died").map((event) => event.id));
    expect(JSON.stringify(initial)).not.toContain(liveStack.projectName!);

    // Each action is a closed compose restart of this test's labelled worker.
    // No broad Docker stop/restart, ID lookup, or unrelated resource command
    // is exposed to the spec.
    await liveStack.restartFixtureWorker!();
    await waitForNewDiedEvents(observedUrl, auth, initialDieIds, 1);
    await liveStack.restartFixtureWorker!();
    await waitForNewDiedEvents(observedUrl, auth, initialDieIds, 2);

    // Restarting only the fixture's filtered gateway forces the daemon's
    // long-lived Unix stream to reconnect. The transient reconnecting state is
    // intentionally not sampled: a polling assertion could miss it and turn
    // evidence into a timing race. A new accepted event after collection
    // returns to collecting proves the replacement stream is usable.
    await liveStack.restartDockerGateway!();
    await pollJson<ObservedEventsResponse>(
      "Docker event collection after its fixture gateway reconnects",
      () => getJson<ObservedEventsResponse>(observedUrl, auth),
      (response) => response.source === "docker" && response.collectionState === "collecting",
    );
    await liveStack.restartFixtureWorker!();

    const observed = await waitForNewDiedEvents(observedUrl, auth, initialDieIds, 3);
    const newDiedEvents = observed.events.filter((event) => event.kind === "container_died" && !initialDieIds.has(event.id));
    expect(newDiedEvents).toHaveLength(3);
    expect(new Set(newDiedEvents.map((event) => event.id)).size).toBe(3);
    expect(new Set(newDiedEvents.map((event) => event.containerId)).size).toBe(1);
    expect(newDiedEvents.every((event) => event.evidenceSource === "docker_event_stream")).toBe(true);
    expect(newDiedEvents.every((event) => /^docker_event_[0-9a-f]{64}$/.test(event.id))).toBe(true);
    expect(newDiedEvents.every((event) => /^docker_container_[0-9a-f]{64}$/.test(event.containerId))).toBe(true);
    expect(JSON.stringify(observed)).not.toContain(liveStack.projectName!);

    const findingResponse = await pollJson<FindingsResponse>(
      "one repeated Docker die-event advisory",
      () => getJson<FindingsResponse>(findingsUrl, auth),
      (response) => response.findings.filter((finding) => finding.ruleId === temporalRule).length === 1,
    );
    const temporalFindings = findingResponse.findings.filter((finding) => finding.ruleId === temporalRule);
    expect(temporalFindings).toHaveLength(1);
    const [finding] = temporalFindings;
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("advisory");
    expect(finding!.subjectRef).toBe(newDiedEvents[0]!.containerId);
    expect(finding!.targetRef).toBe("docker_event_stream");
    expect(finding!.evidenceRefs).toEqual([]);
    expect(finding!.temporalEvidenceRefs).toHaveLength(3);
    expect(finding!.temporalEvidenceRefs.map((reference) => reference.eventId).sort())
      .toEqual(newDiedEvents.map((event) => event.id).sort());
    expect(finding!.temporalEvidenceRefs.every((reference) =>
      reference.source === "docker_event_stream"
      && reference.kind === "container_died"
      && reference.anchorModelRevision.length > 0
      && reference.anchorObservationRevision.length > 0
    )).toBe(true);
    expect(JSON.stringify(findingResponse)).not.toContain(liveStack.projectName!);
  });
});

async function waitForNewDiedEvents(
  observedUrl: string,
  headers: HeadersInit,
  existingIds: Set<string>,
  expectedCount: number,
) {
  return pollJson<ObservedEventsResponse>(
    `${expectedCount} new container_died event observation(s)`,
    () => getJson<ObservedEventsResponse>(observedUrl, headers),
    (response) => response.source === "docker"
      && response.collectionState === "collecting"
      && response.events.filter((event) => event.kind === "container_died" && !existingIds.has(event.id)).length >= expectedCount,
  );
}

async function getJson<T>(url: string, headers: HeadersInit): Promise<T> {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json() as Promise<T>;
}

async function pollJson<T>(
  label: string,
  request: () => Promise<T>,
  predicate: (response: T) => boolean,
  timeoutMs = 45_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastResponse: T | undefined;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await request();
      lastResponse = response;
      if (predicate(response)) return response;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  const detail = lastError === undefined
    ? lastResponse === undefined
      ? "no response"
      : pollingResponseMetadata(lastResponse)
    : pollingRequestErrorMetadata(lastError);
  throw new Error(`Timed out waiting for ${label}: ${detail}`);
}

function pollingResponseMetadata(value: unknown): string {
  if (!value || typeof value !== "object") return "response metadata unavailable";
  const response = value as Record<string, unknown>;
  const details: string[] = [];
  if (response.source === "docker" || response.source === "mock") details.push(`source=${response.source}`);
  if (response.collectionState === "connecting" || response.collectionState === "collecting" || response.collectionState === "reconnecting" || response.collectionState === "unavailable") {
    details.push(`collectionState=${response.collectionState}`);
  }
  if (Array.isArray(response.events)) details.push(`eventCount=${boundedCount(response.events.length)}`);
  if (Array.isArray(response.findings)) details.push(`findingCount=${boundedCount(response.findings.length)}`);
  return details.length === 0 ? "response metadata received" : `response metadata (${details.join(", ")})`;
}

function pollingRequestErrorMetadata(error: unknown): string {
  if (!(error instanceof Error)) return "request failed";
  const status = / returned ([1-5]\d{2})$/.exec(error.message)?.[1];
  return status ? `HTTP ${status}` : "request failed";
}

function boundedCount(count: number) {
  return Math.min(Math.max(0, count), 10_000);
}

async function pollingFailure(request: () => Promise<unknown>) {
  try {
    await request();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("Expected polling request to time out");
}
