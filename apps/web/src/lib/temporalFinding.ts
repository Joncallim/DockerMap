import type { Finding } from "@dockermap/contracts";

type TemporalEvidence = {
  eventId: string;
  source: "docker_event_stream";
  kind: "container_died";
  sourceOccurredAtMs: number;
  anchorModelRevision: string;
  anchorObservationRevision: string;
};

const TEMPORAL_RULE = "docker.repeated_container_died_events";
const TEMPORAL_SUMMARY = "A Docker container had three observed die events within five minutes.";
const TEMPORAL_RECOMMENDATION = "Review the container's recent configuration and logs to determine whether the repeated exits are expected.";
const CONTAINER_ID = /^docker_container_[0-9a-f]{64}$/;
const EVENT_ID = /^docker_event_[0-9a-f]{64}$/;
const FINDING_ID = /^finding_docker_repeated_container_died_events_docker_container_[0-9a-f]{64}--[0-9a-f]{64}$/;
const TEMPORAL_WINDOW_MS = 300_000;

/**
 * The temporal advisory is a closed, historical observation. Keep this
 * second browser boundary structural even though the API already validates
 * the response: this renderer must not turn malformed stream material into a
 * current-service conclusion or a link.
 */
export function isCoherentRepeatedContainerDiedFinding(value: unknown): value is Finding {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id", "ruleId", "severity", "summary", "recommendation", "subjectRef", "targetRef", "evidenceRefs", "temporalEvidenceRefs"
  ])) return false;

  if (value.ruleId !== TEMPORAL_RULE
    || value.severity !== "advisory"
    || value.summary !== TEMPORAL_SUMMARY
    || value.recommendation !== TEMPORAL_RECOMMENDATION
    || typeof value.id !== "string"
    || !FINDING_ID.test(value.id)
    || typeof value.subjectRef !== "string"
    || !CONTAINER_ID.test(value.subjectRef)
    || value.targetRef !== "docker_event_stream"
    || !Array.isArray(value.evidenceRefs)
    || value.evidenceRefs.length !== 0
    || !Array.isArray(value.temporalEvidenceRefs)
    || value.temporalEvidenceRefs.length !== 3) return false;

  if (!value.id.startsWith(`finding_docker_repeated_container_died_events_${value.subjectRef}--`)) return false;

  const eventIds = new Set<string>();
  for (const reference of value.temporalEvidenceRefs) {
    if (!isCoherentTemporalEvidence(reference) || eventIds.has(reference.eventId)) return false;
    eventIds.add(reference.eventId);
  }

  const references = value.temporalEvidenceRefs;
  for (let index = 1; index < references.length; index += 1) {
    const prior = references[index - 1]!;
    const current = references[index]!;
    if (current.sourceOccurredAtMs < prior.sourceOccurredAtMs
      || (current.sourceOccurredAtMs === prior.sourceOccurredAtMs && current.eventId <= prior.eventId)) return false;
  }

  return references[2]!.sourceOccurredAtMs - references[0]!.sourceOccurredAtMs <= TEMPORAL_WINDOW_MS;
}

function isCoherentTemporalEvidence(value: unknown): value is TemporalEvidence {
  return isRecord(value)
    && hasExactKeys(value, ["eventId", "source", "kind", "sourceOccurredAtMs", "anchorModelRevision", "anchorObservationRevision"])
    && typeof value.eventId === "string"
    && EVENT_ID.test(value.eventId)
    && value.source === "docker_event_stream"
    && value.kind === "container_died"
    && isTimestamp(value.sourceOccurredAtMs)
    && isRevision(value.anchorModelRevision)
    && isRevision(value.anchorObservationRevision);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRevision(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Array.from(value).length <= 64;
}
