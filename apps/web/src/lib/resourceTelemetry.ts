import type { ObservedResourceMetric, ObservedResourceTelemetryResponse } from "@dockermap/contracts";
import { unavailable } from "./evidence";
import type { Service, SystemModel } from "./model";

/**
 * Current-only resource values which have passed the browser's independent
 * provenance, model-revision, identity and freshness checks.  The daemon
 * deliberately does not publish a history, and neither does this selector.
 */
export interface ObservedResourceSample {
  cpuPercent: number;
  memoryPercent: number;
  memoryMb: number;
  networkKbps: number;
}

type ObservedResourceClaim =
  | { kind: "observed"; value: ObservedResourceSample }
  | { kind: "unavailable"; value: null; detail: string };

const UNAVAILABLE_DETAIL = "Current Docker resource telemetry is not available for this model.";
const STALE_DETAIL = "Current Docker resource telemetry is stale for this model.";

function ownRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function currentMetric(value: unknown, now: number): number | null {
  const metric = ownRecord(value) as ObservedResourceMetric | null;
  if (!metric
    || !Object.hasOwn(metric, "value")
    || !Object.hasOwn(metric, "observedAtMs")
    || !Object.hasOwn(metric, "expiresAtMs")
    || typeof metric.value !== "number"
    || typeof metric.observedAtMs !== "number"
    || typeof metric.expiresAtMs !== "number"
    || !Number.isFinite(metric.value)
    || !Number.isFinite(metric.observedAtMs)
    || !Number.isFinite(metric.expiresAtMs)
    || metric.value < 0
    || metric.observedAtMs > metric.expiresAtMs
    || metric.expiresAtMs <= now) return null;
  return metric.value;
}

/**
 * Select one current telemetry row.  This is intentionally fail-closed: the
 * live model, response and every numeric envelope must all be current before
 * a resource figure can cross the UI boundary.
 */
export function observedResourceFor(
  service: Service,
  model: SystemModel | null,
  telemetry: ObservedResourceTelemetryResponse | null | undefined,
  now = Date.now()
): ObservedResourceClaim {
  const response = ownRecord(telemetry);
  if (response
    && Object.hasOwn(response, "source") && response.source === "docker"
    && Object.hasOwn(response, "collectionState") && response.collectionState === "stale") {
    return unavailable(STALE_DETAIL);
  }
  if (!model || model.byId.get(service.id) !== service || !response
    || !Object.hasOwn(response, "source") || response.source !== "docker"
    || !Object.hasOwn(response, "collectionState") || response.collectionState !== "fresh"
    || !Object.hasOwn(response, "currentModelRevision") || response.currentModelRevision !== model.modelRevision
    || typeof model.modelRevision !== "string" || model.modelRevision.length === 0
    || !Object.hasOwn(response, "samples") || !Array.isArray(response.samples)) return unavailable(UNAVAILABLE_DETAIL);

  const row = response.samples.find((candidate) => {
    const sample = ownRecord(candidate);
    return sample !== null && Object.hasOwn(sample, "containerId") && sample.containerId === service.id;
  });
  const sample = ownRecord(row);
  if (!sample) return unavailable(UNAVAILABLE_DETAIL);

  const cpuPercent = currentMetric(sample.cpuPercent, now);
  const memoryUsedBytes = currentMetric(sample.memoryUsedBytes, now);
  const memoryLimitBytes = currentMetric(sample.memoryLimitBytes, now);
  const networkRxBytesPerSecond = currentMetric(sample.networkRxBytesPerSecond, now);
  const networkTxBytesPerSecond = currentMetric(sample.networkTxBytesPerSecond, now);
  if (cpuPercent === null || memoryUsedBytes === null || memoryLimitBytes === null
    || networkRxBytesPerSecond === null || networkTxBytesPerSecond === null
    || memoryLimitBytes <= 0 || cpuPercent > 100 || memoryUsedBytes > memoryLimitBytes) return unavailable(UNAVAILABLE_DETAIL);

  return { kind: "observed", value: {
    cpuPercent,
    memoryPercent: memoryUsedBytes / memoryLimitBytes * 100,
    memoryMb: memoryUsedBytes / (1024 * 1024),
    networkKbps: (networkRxBytesPerSecond + networkTxBytesPerSecond) * 8 / 1000
  } };
}

export const RESOURCE_TELEMETRY_UNAVAILABLE_DETAIL = UNAVAILABLE_DETAIL;
export const RESOURCE_TELEMETRY_STALE_DETAIL = STALE_DETAIL;

export function isStaleResourceTelemetry(detail: string): boolean {
  return detail === STALE_DETAIL;
}
