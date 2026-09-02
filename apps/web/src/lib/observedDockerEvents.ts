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

  const ids = new Set<string>();
  for (const event of history.events) {
    if (!isCoherentEvent(event) || ids.has(event.id)) return null;
    ids.add(event.id);
  }
  return history;
}

function isCoherentEvent(event: ObservedDockerEvent): boolean {
  return Object.hasOwn(event, "id")
    && EVENT_ID.test(event.id)
    && Object.hasOwn(event, "containerId")
    && CONTAINER_ID.test(event.containerId)
    && Object.hasOwn(event, "evidenceSource")
    && event.evidenceSource === "docker_event_stream"
    && Object.hasOwn(event, "kind")
    && EVENT_KINDS.has(event.kind)
    && Object.hasOwn(event, "observedAtMs")
    && isTimestamp(event.observedAtMs)
    && Object.hasOwn(event, "sourceOccurredAtMs")
    && isTimestamp(event.sourceOccurredAtMs)
    && event.sourceOccurredAtMs <= event.observedAtMs
    && Object.hasOwn(event, "anchorModelRevision")
    && isRevision(event.anchorModelRevision)
    && Object.hasOwn(event, "anchorObservationRevision")
    && isRevision(event.anchorObservationRevision);
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
