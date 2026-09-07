import { expect, test } from "@playwright/test";
import { setTimeout as delay } from "node:timers/promises";
import { SkipLiveDockerError, startLiveDockerStack, type Stack } from "./dockermapHarness";

type ObservedEvent = {
  id: string;
  containerId: string;
  evidenceSource: string;
  kind: string;
  observedAtMs: number;
  sourceOccurredAtMs: number;
  anchorModelRevision: string;
  anchorObservationRevision: string;
};

type ObservedEventsResponse = {
  source: string;
  collectionState: string;
  currentModelRevision: string | null;
  currentObservationRevision: string | null;
  events: ObservedEvent[];
};

type TemporalFinding = {
  id: string;
  ruleId: string;
  severity: string;
  summary: string;
  recommendation: string;
  evidenceRefs: unknown[];
  temporalEvidence: Array<{ source: string; kind: string }>;
};

type FindingsResponse = { findings: TemporalFinding[]; modelRevision: string };

const temporalRule = "docker.repeated_container_died_events";
const temporalId = "finding_docker_repeated_container_died_events";
const temporalSummary = "Three retained Docker container exit observations need review.";
const temporalRecommendation = "Review the container's recent configuration and logs to determine whether the repeated exits are expected.";
const token = "dockermap-temporal-live-e2e-token";

test.describe("Docker temporal observations", () => {
  let stack: Stack | null = null;

  test.afterEach(async () => {
    await stack?.stop();
    stack = null;
  });

  test("publishes one redacted repeated-die advisory from only its labelled fixture after gateway recovery @live-docker", async () => {
    test.skip(!process.env.DOCKERMAP_E2E_LIVE_DOCKER, "Set DOCKERMAP_E2E_LIVE_DOCKER=1 to create live Docker fixtures.");

    try {
      stack = await startLiveDockerStack({ apiToken: token });
    } catch (error) {
      if (error instanceof SkipLiveDockerError) test.skip(true, error.message);
      throw error;
    }

    expect(stack.apiToken).toBe(token);
    expect(stack.restartFixtureWorker).toBeDefined();
    expect(stack.restartDockerGateway).toBeDefined();
    expect(stack.projectName).toBeTruthy();
    expect(stack.controlContainerName).toBeTruthy();

    const auth = { headers: { Authorization: `Bearer ${token}` } };
    const observedUrl = `${stack.apiUrl}/api/observed-events`;
    const findingsUrl = `${stack.apiUrl}/api/findings`;

    expect((await fetch(observedUrl)).status).toBe(401);
    expect((await fetch(findingsUrl)).status).toBe(401);
    const wrongToken = { headers: { Authorization: "Bearer wrong-temporal-token" } };
    expect((await fetch(observedUrl, wrongToken)).status).toBe(401);
    expect((await fetch(findingsUrl, wrongToken)).status).toBe(401);
    const snapshot = await getJson<{ containers: Array<{ name: string }> }>(`${stack.apiUrl}/api/snapshot`, auth);
    expect(snapshot.containers.some((container) => container.name.includes(stack!.projectName!))).toBe(true);
    expect(snapshot.containers.some((container) => container.name === stack!.controlContainerName)).toBe(false);

    const initial = await pollJson(
      "live Docker event collection",
      () => getJson<ObservedEventsResponse>(observedUrl, auth),
      (response) => response.source === "docker"
        && response.collectionState === "collecting"
        && response.currentModelRevision !== null
        && response.currentObservationRevision !== null,
    );
    expect(Object.keys(initial).sort()).toEqual([
      "collectionState",
      "currentModelRevision",
      "currentObservationRevision",
      "events",
      "source",
    ]);
    assertObservedEventShape(initial);
    const initialDieIds = new Set(initial.events.filter((event) => event.kind === "container_died").map((event) => event.id));
    expect(JSON.stringify(initial)).not.toContain(stack.projectName!);

    // Establish one pre-reset event. A gateway reconnect starts a new
    // continuity epoch, so this row must not be carried into the next one.
    await stack.restartFixtureWorker!();
    const preReset = await waitForNewDiedEvents(observedUrl, auth, initialDieIds, 1);
    const preResetEvent = preReset.events.find((event) => event.kind === "container_died" && !initialDieIds.has(event.id));
    expect(preResetEvent).toBeDefined();
    const preResetId = preResetEvent!.id;

    // Stop only the labelled read gateway and wait for the daemon to observe
    // the broken stream before starting it again. This stable failure signal
    // prevents an immediate stop/start from hiding the source transition.
    await stack.stopDockerGateway!();
    await pollJson(
      "Docker event collection disconnect after filtered gateway stop",
      () => getJson<ObservedEventsResponse>(observedUrl, auth),
      (response) => (
        (response.source === "docker" && response.collectionState === "reconnecting")
        || (response.source === "mock" && response.collectionState === "unavailable")
      )
        && !response.events.some((event) => event.id === preResetId),
    );

    // Start only the labelled read gateway. The daemon must recover its
    // fixed stream; the unlabeled control container remains untouched.
    await stack.restartDockerGateway!();
    const afterReset = await pollJson(
      "Docker event collection after filtered gateway recovery",
      () => getJson<ObservedEventsResponse>(observedUrl, auth),
      (response) => response.source === "docker"
        && response.collectionState === "collecting"
        && !response.events.some((event) => event.id === preResetId),
    );
    assertObservedEventShape(afterReset);
    expect(afterReset.events.some((event) => event.id === preResetId)).toBe(false);
    expect((await getFindingsThroughApi(findingsUrl, stack.daemonUrl, auth)).findings.some((finding) => finding.ruleId === temporalRule)).toBe(false);

    // Count only events first observed after recovery established the new
    // continuity epoch. The pre-reset baseline is intentionally not a
    // threshold baseline: replay/dedupe may retain non-die history safely.
    const postResetBaselineIds = new Set(afterReset.events
      .filter((event) => event.kind === "container_died")
      .map((event) => event.id));
    const postResetDieIds = new Set<string>();
    await stack.restartFixtureWorker!();
    const postResetOne = await waitForNewDiedEvents(observedUrl, auth, postResetBaselineIds, 1);
    addNewDiedIds(postResetDieIds, postResetOne, postResetBaselineIds);
    expect((await getFindingsThroughApi(findingsUrl, stack.daemonUrl, auth)).findings.some((finding) => finding.ruleId === temporalRule)).toBe(false);

    await stack.restartFixtureWorker!();
    const postResetTwo = await waitForNewDiedEvents(observedUrl, auth, postResetBaselineIds, 2);
    addNewDiedIds(postResetDieIds, postResetTwo, postResetBaselineIds);
    expect((await getFindingsThroughApi(findingsUrl, stack.daemonUrl, auth)).findings.some((finding) => finding.ruleId === temporalRule)).toBe(false);

    await stack.restartFixtureWorker!();
    const observed = await waitForNewDiedEvents(observedUrl, auth, postResetBaselineIds, 3);
    assertObservedEventShape(observed);
    addNewDiedIds(postResetDieIds, observed, postResetBaselineIds);
    expect(postResetDieIds.size).toBe(3);
    const newDiedEvents = observed.events.filter((event) => event.kind === "container_died" && !postResetBaselineIds.has(event.id));
    expect(newDiedEvents).toHaveLength(3);
    expect(new Set(newDiedEvents.map((event) => event.id)).size).toBe(3);
    expect(new Set(newDiedEvents.map((event) => event.containerId)).size).toBe(1);
    expect(newDiedEvents.every((event) => event.evidenceSource === "docker_event_stream")).toBe(true);
    expect(newDiedEvents.every((event) => event.kind === "container_died")).toBe(true);
    expect(newDiedEvents.every((event) => /^docker_event_[0-9a-f]{64}$/.test(event.id))).toBe(true);
    expect(newDiedEvents.every((event) => /^docker_container_[0-9a-f]{64}$/.test(event.containerId))).toBe(true);
    expect(newDiedEvents.every((event) => event.anchorModelRevision.length > 0 && event.anchorObservationRevision.length > 0)).toBe(true);
    for (const event of newDiedEvents) {
      expect(Object.keys(event).sort()).toEqual([
        "anchorModelRevision",
        "anchorObservationRevision",
        "containerId",
        "evidenceSource",
        "id",
        "kind",
        "observedAtMs",
        "sourceOccurredAtMs",
      ]);
    }
    expect(JSON.stringify(observed)).not.toContain(stack.projectName!);
    expect(JSON.stringify(observed)).not.toContain(stack.controlContainerName!);

    const findingResponse = await pollFindingsThroughApi(
      "one redacted repeated Docker die-event advisory",
      findingsUrl,
      stack.daemonUrl,
      auth,
      (response) => response.findings.filter((finding) => finding.ruleId === temporalRule).length === 1,
    );
    const temporalFindings = findingResponse.findings.filter((finding) => finding.ruleId === temporalRule);
    expect(temporalFindings).toHaveLength(1);
    const finding = temporalFindings[0]!;
    expect(finding).toEqual({
      id: temporalId,
      ruleId: temporalRule,
      severity: "advisory",
      summary: temporalSummary,
      recommendation: temporalRecommendation,
      evidenceRefs: [],
      temporalEvidence: [
        { source: "docker_event_stream", kind: "container_died" },
        { source: "docker_event_stream", kind: "container_died" },
        { source: "docker_event_stream", kind: "container_died" },
      ],
    });
    expect("subjectRef" in finding).toBe(false);
    expect("targetRef" in finding).toBe(false);
    expect(JSON.stringify(findingResponse)).not.toContain(stack.projectName!);
    expect(JSON.stringify(findingResponse)).not.toContain(stack.controlContainerName!);
  });
});

async function waitForNewDiedEvents(
  observedUrl: string,
  headers: HeadersInit,
  existingIds: Set<string>,
  expectedCount: number,
) {
  return pollJson(
    `${expectedCount} new container_died event observation(s)`,
    () => getJson<ObservedEventsResponse>(observedUrl, headers),
    (response) => response.source === "docker"
      && response.collectionState === "collecting"
      && response.events.filter((event) => event.kind === "container_died" && !existingIds.has(event.id)).length >= expectedCount,
  );
}

function addNewDiedIds(target: Set<string>, response: ObservedEventsResponse, baseline: Set<string>) {
  for (const event of response.events) {
    if (event.kind === "container_died" && !baseline.has(event.id)) target.add(event.id);
  }
}

function assertObservedEventShape(response: ObservedEventsResponse) {
  for (const event of response.events) {
    expect(Object.keys(event).sort()).toEqual([
      "anchorModelRevision",
      "anchorObservationRevision",
      "containerId",
      "evidenceSource",
      "id",
      "kind",
      "observedAtMs",
      "sourceOccurredAtMs",
    ]);
  }
}

async function getJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json() as Promise<T>;
}

async function pollFindingsThroughApi(
  label: string,
  apiUrl: string,
  daemonUrl: string,
  auth: RequestInit,
  predicate: (response: FindingsResponse) => boolean,
  timeoutMs = 45_000,
): Promise<FindingsResponse> {
  const deadline = Date.now() + timeoutMs;
  let lastResponse: FindingsResponse | undefined;
  while (Date.now() < deadline) {
    lastResponse = await getFindingsThroughApi(apiUrl, daemonUrl, auth);
    if (predicate(lastResponse)) return lastResponse;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}: ${lastResponse === undefined ? "no response" : "response did not reach the expected state"}`);
}

async function getFindingsThroughApi(apiUrl: string, daemonUrl: string, auth: RequestInit): Promise<FindingsResponse> {
  const response = await fetch(apiUrl, auth);
  if (response.status === 502) {
    const diagnostic = await daemonFindingsShape(daemonUrl, auth);
    throw new Error(`API findings returned HTTP 502; daemon structural diagnostic: ${diagnostic}`);
  }
  if (!response.ok) throw new Error(`${apiUrl} returned ${response.status}`);
  return response.json() as Promise<FindingsResponse>;
}

async function daemonFindingsShape(daemonUrl: string, auth: RequestInit): Promise<string> {
  try {
    const response = await fetch(`${daemonUrl}/daemon/findings`, auth);
    if (!response.ok) return `daemonStatus=${response.status}`;
    return describeFindingsShape(await response.json());
  } catch {
    return "daemonResponse=unavailable";
  }
}

function describeFindingsShape(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "root=non_object";
  const root = value as Record<string, unknown>;
  const findings = Array.isArray(root.findings) ? root.findings : null;
  if (!findings) return `rootKeys=${safeKeys(root).join(",")};findings=non_array`;
  const rules = findings.map((finding) => {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) return "<non_object>";
    const rule = (finding as Record<string, unknown>).ruleId;
    return typeof rule === "string" ? rule : "<non_string>";
  });
  const findingKeys = findings.map((finding) => {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) return "<non_object>";
    return safeKeys(finding as Record<string, unknown>).join(",");
  });
  return `rootKeys=${safeKeys(root).join(",")};findingCount=${findings.length};rules=${rules.join("|")};findingKeys=${findingKeys.join("|")}`;
}

function safeKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).sort();
}

async function pollJson<T>(label: string, request: () => Promise<T>, predicate: (response: T) => boolean, timeoutMs = 45_000): Promise<T> {
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
  const detail = lastError instanceof Error
    ? "request failed"
    : lastResponse === undefined
      ? "no response"
      : `response did not reach the expected state (${closedPollState(lastResponse)})`;
  throw new Error(`Timed out waiting for ${label}: ${detail}`);
}

// Failure output stays structural: never include a provider response, opaque
// identity, timestamp, revision, or error text in an operator-facing test log.
function closedPollState(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "non_object";
  const response = value as Record<string, unknown>;
  const source = response.source === "docker" || response.source === "mock" ? response.source : "other";
  const state = response.collectionState === "collecting"
    || response.collectionState === "reconnecting"
    || response.collectionState === "unavailable"
    ? response.collectionState
    : "other";
  const eventCount = Array.isArray(response.events) ? response.events.length : null;
  const hasCurrentRevisions = typeof response.currentModelRevision === "string"
    && typeof response.currentObservationRevision === "string";
  return `source=${source};state=${state};events=${eventCount === null ? "non_array" : eventCount};revisions=${hasCurrentRevisions ? "present" : "absent"}`;
}
