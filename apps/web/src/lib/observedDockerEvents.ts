import type { ObservedDockerEvent, ObservedDockerEventHistoryResponse } from "@dockermap/contracts";
import type { EvidenceMode, ModelProvenance } from "./evidence";
import type { SystemModel } from "./model";

const EVENT_ID = /^docker_event_[0-9a-f]{64}$/;
const CONTAINER_ID = /^docker_container_[0-9a-f]{64}$/;
const MAX_RENDERABLE_TIMESTAMP_MS = 8_640_000_000_000_000;
const COLLECTION_STATES = new Set<ObservedDockerEventHistoryResponse["collectionState"]>(["connecting", "collecting", "reconnecting"]);
const EVENT_KINDS = new Set<ObservedDockerEvent["kind"]>(["container_created", "container_started", "container_stopped", "container_died", "container_restarted", "container_destroyed", "container_health_starting", "container_health_healthy", "container_health_unhealthy"]);

/** Strict, standalone gate: a historical stream never authorizes a current telemetry claim. */
export function coherentObservedDockerEvents(model: SystemModel | null, mode: EvidenceMode | null, provenance: ModelProvenance | null, history: ObservedDockerEventHistoryResponse | null | undefined): ObservedDockerEventHistoryResponse | null {
  if (mode !== "live" || provenance !== "live" || !model || model.modelRevision.length === 0 || !isRecord(history)
    || !Object.hasOwn(history, "source") || history.source !== "docker"
    || !Object.hasOwn(history, "collectionState") || !COLLECTION_STATES.has(history.collectionState)
    || !Object.hasOwn(history, "currentModelRevision") || !isRevision(history.currentModelRevision) || history.currentModelRevision !== model.modelRevision
    || !Object.hasOwn(history, "currentObservationRevision") || !isRevision(history.currentObservationRevision)
    || !Object.hasOwn(history, "events") || !Array.isArray(history.events) || history.events.length > 64) return null;
  const ids = new Set<string>();
  for (const event of history.events) { if (!isCoherentEvent(event) || ids.has(event.id)) return null; ids.add(event.id); }
  return history;
}

function isCoherentEvent(event: unknown): event is ObservedDockerEvent {
  if (event === null || typeof event !== "object" || Array.isArray(event)) return false;
  const row = event as Record<string, unknown>;
  return Object.hasOwn(row, "id") && typeof row.id === "string" && EVENT_ID.test(row.id)
    && Object.hasOwn(row, "containerId") && typeof row.containerId === "string" && CONTAINER_ID.test(row.containerId)
    && Object.hasOwn(row, "evidenceSource") && row.evidenceSource === "docker_event_stream"
    && Object.hasOwn(row, "kind") && typeof row.kind === "string" && EVENT_KINDS.has(row.kind as ObservedDockerEvent["kind"])
    && Object.hasOwn(row, "observedAtMs") && isTimestamp(row.observedAtMs)
    && Object.hasOwn(row, "sourceOccurredAtMs") && isTimestamp(row.sourceOccurredAtMs) && row.sourceOccurredAtMs <= row.observedAtMs
    && Object.hasOwn(row, "anchorModelRevision") && isRevision(row.anchorModelRevision)
    && Object.hasOwn(row, "anchorObservationRevision") && isRevision(row.anchorObservationRevision);
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function isTimestamp(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_RENDERABLE_TIMESTAMP_MS; }
function isRevision(value: unknown): value is string {
  // Bound UTF-16 units before iterating code points. The second check retains
  // the public character limit without allowing hostile JSON to allocate an
  // unbounded code-point array at this browser boundary.
  return typeof value === "string" && value.length > 0 && value.length <= 128 && Array.from(value).length <= 64;
}
export function observedDockerEventKindToken(kind: ObservedDockerEvent["kind"]): string { return kind; }
