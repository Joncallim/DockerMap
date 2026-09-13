import type { ObservedChangeHistoryResponse } from "@dockermap/contracts";
import type { Claim, EvidenceMode, ModelProvenance } from "./evidence";
import { observed, unavailable } from "./evidence";
import type { SystemModel } from "./model";
import type { ChangeEvent } from "./stubs";

const UNAVAILABLE = unavailable("Observed history requires a coherent live Docker model and retained inventory baseline");
const EVENT_KEYS = ["containerId", "currentStatus", "id", "kind", "observedAtMs", "previousStatus"] as const;
const STATUS = new Set(["running", "stopped", "other"]);
const EVENT_ID = /^([0-9a-f]{32})-([1-9][0-9]{0,19})$/;
const CONTAINER_ID = /^docker_container_[0-9a-f]{64}$/;
const MAX_SEQUENCE = 18_446_744_073_709_551_615n;

/** Snapshot deltas are observations, not Docker events or causal history. */
export function coherentObservedHistory(
  model: SystemModel | null,
  mode: EvidenceMode | null,
  provenance: ModelProvenance | null,
  history: ObservedChangeHistoryResponse | null | undefined
): ObservedChangeHistoryResponse | null {
  if (!model || mode !== "live" || provenance !== "live" || !ownRecord(history)
    || !Object.hasOwn(history, "source") || history.source !== "docker"
    || !Object.hasOwn(history, "baselineEstablished") || history.baselineEstablished !== true
    || !Object.hasOwn(history, "currentModelRevision") || !nonEmptyRevision(history.currentModelRevision)
    || history.currentModelRevision !== model.modelRevision
    || !Object.hasOwn(history, "observedRevision") || !nonEmptyRevision(history.observedRevision)
    || !Object.hasOwn(history, "events") || !validEvents(history.events)) return null;
  return history;
}

export function observedChangeFeed(
  model: SystemModel,
  mode: EvidenceMode | null,
  provenance: ModelProvenance | null,
  history: ObservedChangeHistoryResponse | null | undefined
): Claim<ChangeEvent[]> {
  const coherent = coherentObservedHistory(model, mode, provenance, history);
  if (!coherent) return UNAVAILABLE;
  return observed(coherent.events.map((event) => ({
    id: event.id,
    serviceId: null,
    serviceName: "Observed container",
    routeName: null,
    kind: event.kind,
    summary: summaryFor(event.kind),
    detail: detailFor(event.previousStatus, event.currentStatus),
    at: event.observedAtMs
  })));
}

function ownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyRevision(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Defend the browser boundary too: intercepted or malformed JSON must not become a claim. */
function validEvents(value: unknown): value is ObservedChangeHistoryResponse["events"] {
  if (!Array.isArray(value) || value.length > 64) return false;
  const ids = new Set<string>();
  let epoch: string | null = null;
  let priorAt = Number.POSITIVE_INFINITY;
  let priorSequence: bigint | null = null;
  return value.every((candidate) => {
    if (!ownRecord(candidate) || Object.keys(candidate).length !== EVENT_KEYS.length
      || EVENT_KEYS.some((key) => !Object.hasOwn(candidate, key))) return false;
    const id = candidate.id;
    if (typeof id !== "string") return false;
    const idMatch = EVENT_ID.exec(id);
    if (!idMatch || ids.has(id) || !CONTAINER_ID.test(String(candidate.containerId))) return false;
    const sequence = BigInt(idMatch[2]);
    if (sequence > MAX_SEQUENCE || (epoch !== null && idMatch[1] !== epoch)
      || (priorSequence !== null && sequence >= priorSequence)) return false;
    if (!Number.isSafeInteger(candidate.observedAtMs) || (candidate.observedAtMs as number) < 0
      || (candidate.observedAtMs as number) > priorAt) return false;

    const previous = candidate.previousStatus;
    const current = candidate.currentStatus;
    const previousValid = previous === null || (typeof previous === "string" && STATUS.has(previous));
    const currentValid = current === null || (typeof current === "string" && STATUS.has(current));
    if (!previousValid || !currentValid) return false;
    const transitionValid = candidate.kind === "container_appeared"
      ? previous === null && current !== null
      : candidate.kind === "container_disappeared"
        ? previous !== null && current === null
        : candidate.kind === "container_status_changed"
          && previous !== null && current !== null && previous !== current;
    if (!transitionValid) return false;

    ids.add(id);
    epoch = idMatch[1];
    priorSequence = sequence;
    priorAt = candidate.observedAtMs as number;
    return true;
  });
}

function summaryFor(kind: ObservedChangeHistoryResponse["events"][number]["kind"]): string {
  switch (kind) {
    case "container_appeared": return "A container appeared in the published inventory";
    case "container_disappeared": return "A container disappeared from the published inventory";
    case "container_status_changed": return "A container observation changed status";
  }
}

function detailFor(
  previous: ObservedChangeHistoryResponse["events"][number]["previousStatus"],
  current: ObservedChangeHistoryResponse["events"][number]["currentStatus"]
): string {
  if (previous === null) return `Observed status: ${current ?? "unavailable"}.`;
  if (current === null) return `Previously observed status: ${previous}.`;
  return `Observed status transition: ${previous} to ${current}.`;
}
