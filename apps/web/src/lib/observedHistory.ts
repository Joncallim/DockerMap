import type { ObservedChangeHistoryResponse } from "@dockermap/contracts";
import type { Claim, EvidenceMode, ModelProvenance } from "./evidence";
import { observed, unavailable } from "./evidence";
import type { SystemModel } from "./model";
import type { ChangeEvent } from "./stubs";

/**
 * Observations are deliberately not a Docker event stream. They describe only
 * deltas between two published inventories, so this surface must not turn one
 * into a deploy, restart, failure, recovery, or causal assertion.
 */
const OBSERVED_HISTORY_UNAVAILABLE = unavailable(
  "Observed history requires a coherent live Docker model and history response"
);

function isCoherentLiveHistory(
  model: SystemModel,
  mode: EvidenceMode | null,
  provenance: ModelProvenance | null,
  history: ObservedChangeHistoryResponse | null | undefined
): history is ObservedChangeHistoryResponse {
  return mode === "live"
    && provenance === "live"
    && Object.hasOwn(history ?? {}, "source")
    && history?.source === "docker"
    && Object.hasOwn(history ?? {}, "currentModelRevision")
    && model.modelRevision.length > 0
    && typeof history.currentModelRevision === "string"
    && history.currentModelRevision.length > 0
    && history.currentModelRevision === model.modelRevision;
}

/**
 * Convert the closed daemon vocabulary into presentation-only rows. Container
 * identities are intentionally not service links: there is no proven mapping
 * from a historical runtime node to a current service identity.
 */
export function observedChangeFeed(
  model: SystemModel,
  mode: EvidenceMode | null,
  provenance: ModelProvenance | null,
  history: ObservedChangeHistoryResponse | null | undefined
): Claim<ChangeEvent[]> {
  if (!isCoherentLiveHistory(model, mode, provenance, history)) return OBSERVED_HISTORY_UNAVAILABLE;

  return observed(history.events.map((event) => ({
    id: event.id,
    serviceId: null,
    serviceName: "Observed container",
    routeName: null,
    kind: event.kind,
    summary: summaryFor(event.kind),
    detail: detailFor(event.containerId, event.previousStatus, event.currentStatus),
    at: event.observedAtMs
  })));
}

function summaryFor(kind: ObservedChangeHistoryResponse["events"][number]["kind"]): string {
  switch (kind) {
    case "container_appeared":
      return "Container appeared in observed inventory";
    case "container_disappeared":
      return "Container disappeared from observed inventory";
    case "container_status_changed":
      return "Container status changed in observed inventory";
  }
}

/** Closed, human-readable labels for the daemon's observation vocabulary. */
export function observedChangeKindLabel(kind: ChangeEvent["kind"]): string {
  switch (kind) {
    case "container_appeared":
      return "appeared";
    case "container_disappeared":
      return "disappeared";
    case "container_status_changed":
      return "status changed";
    default:
      return kind;
  }
}

function detailFor(
  containerId: string,
  previousStatus: ObservedChangeHistoryResponse["events"][number]["previousStatus"],
  currentStatus: ObservedChangeHistoryResponse["events"][number]["currentStatus"]
): string {
  const transition = previousStatus === null
    ? `Current status: ${currentStatus ?? "unavailable"}.`
    : currentStatus === null
      ? `Previous status: ${previousStatus}.`
      : `Status: ${previousStatus} to ${currentStatus}.`;
  return `Observed container ${containerId}. ${transition}`;
}
