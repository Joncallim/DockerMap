import type { ObservedDockerEvent, ObservedDockerEventHistoryResponse } from "@dockermap/contracts";
import type { EvidenceMode, ModelProvenance } from "./evidence";
import type { SystemModel } from "./model";

const EVENT_ID = /^docker_event_[0-9a-f]{64}$/;
const CONTAINER_ID = /^docker_container_[0-9a-f]{64}$/;
// Date#toISOString rejects values beyond this range. The API contract admits
// safe integers, so the renderer independently excludes non-renderable dates
// before it creates a <time> element.
const MAX_RENDERABLE_TIMESTAMP_MS = 8_640_000_000_000_000;
const COLLECTION_STATES = new Set<ObservedDockerEventHistoryResponse["collectionState"]>([
  "connecting",
  "collecting",
  "reconnecting"
]);
const EVENT_KINDS = new Set<ObservedDockerEvent["kind"]>([
  "container_created",
  "container_started",
  "container_stopped",
  "container_died",
  "container_restarted",
  "container_destroyed",
  "container_health_starting",
  "container_health_healthy",
  "container_health_unhealthy"
]);

/**
 * The event stream has a separate lifecycle from inventory-delta history.
 * Rendering requires an exact current Docker model match and validates every
 * retained row again at the browser boundary. In particular, stream records
 * stay deliberately non-routable: their digest subjects cannot prove a safe
 * link to a current service.
 */
export function coherentObservedDockerEvents(
  model: SystemModel | null,
  mode: EvidenceMode | null,
  provenance: ModelProvenance | null,
  history: ObservedDockerEventHistoryResponse | null | undefined
): ObservedDockerEventHistoryResponse | null {
  if (mode !== "live" || provenance !== "live" || !model || model.modelRevision.length === 0) return null;
  if (!history || !Object.hasOwn(history, "source") || history.source !== "docker") return null;
  if (!COLLECTION_STATES.has(history.collectionState)) return null;
  if (!isRevision(history.currentModelRevision) || history.currentModelRevision !== model.modelRevision) return null;
  if (!isRevision(history.currentObservationRevision) || !Array.isArray(history.events)) return null;
  if (history.events.length > 64) return null;

  const ids = new Set<string>();
  for (const event of history.events) {
    if (!isCoherentEvent(event) || ids.has(event.id)) return null;
    ids.add(event.id);
  }
  return history;
}

function isCoherentEvent(event: unknown): event is ObservedDockerEvent {
  // API JSON is untrusted at this boundary. `Object.hasOwn` accepts only
  // objects, so reject every non-record (including arrays) before inspecting
  // fields; no malformed event row may throw or fail open during rendering.
  if (event === null || typeof event !== "object" || Array.isArray(event)) return false;
  const row = event as Record<string, unknown>;

  return Object.hasOwn(row, "id")
    && typeof row.id === "string"
    && EVENT_ID.test(row.id)
    && Object.hasOwn(row, "containerId")
    && typeof row.containerId === "string"
    && CONTAINER_ID.test(row.containerId)
    && Object.hasOwn(row, "evidenceSource")
    && row.evidenceSource === "docker_event_stream"
    && Object.hasOwn(row, "kind")
    && typeof row.kind === "string"
    && EVENT_KINDS.has(row.kind as ObservedDockerEvent["kind"])
    && Object.hasOwn(row, "observedAtMs")
    && isTimestamp(row.observedAtMs)
    && Object.hasOwn(row, "sourceOccurredAtMs")
    && isTimestamp(row.sourceOccurredAtMs)
    && row.sourceOccurredAtMs <= row.observedAtMs
    && Object.hasOwn(row, "anchorModelRevision")
    && isRevision(row.anchorModelRevision)
    && Object.hasOwn(row, "anchorObservationRevision")
    && isRevision(row.anchorObservationRevision);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_RENDERABLE_TIMESTAMP_MS;
}

function isRevision(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Array.from(value).length <= 64;
}

/** A closed token, shown verbatim rather than converted into a causal claim. */
export function observedDockerEventKindToken(kind: ObservedDockerEvent["kind"]): string {
  return kind;
}
