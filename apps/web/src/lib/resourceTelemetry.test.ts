import { describe, expect, it } from "vitest";
import type { DockerSnapshot, ObservedResourceTelemetryResponse, RuntimeMap } from "@dockermap/contracts";
import { buildModel } from "./model";
import { observedResourceFor, RESOURCE_TELEMETRY_STALE_DETAIL, RESOURCE_TELEMETRY_UNAVAILABLE_DETAIL } from "./resourceTelemetry";
import { testProviderStates } from "./testProviderStates";

const now = 1_710_000_000_000;
const revision = "publication-r42";
const containerId = "docker_container_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const runtime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], modelRevision: revision, providerStates: testProviderStates, lastUpdated: 0 };
const snapshot: DockerSnapshot = { containers: [{ id: containerId, name: "api", image: "nginx", status: "running", role: "api", networks: [], ports: [], mounts: [], dependsOn: [] }], images: [], networks: [], volumes: [], modelRevision: revision, lastUpdated: 0 };
const model = buildModel(snapshot, runtime);
const metric = (value: number) => ({ value, observedAtMs: now - 1000, expiresAtMs: now + 1000 });
const current: ObservedResourceTelemetryResponse = {
  source: "docker", collectionState: "fresh", currentModelRevision: revision, currentObservationRevision: "observation-r42",
  samples: [{ containerId, cpuPercent: metric(40), memoryUsedBytes: metric(128 * 1024 * 1024), memoryLimitBytes: metric(512 * 1024 * 1024), networkRxBytesPerSecond: metric(500), networkTxBytesPerSecond: metric(750) }]
};

describe("current Docker resource telemetry selector", () => {
  it("publishes only sanitized, current figures for the exact live model", () => {
    const claim = observedResourceFor(model.services[0], model, current, now);
    expect(claim).toEqual({ kind: "observed", value: { cpuPercent: 40, memoryPercent: 25, memoryMb: 128, networkKbps: 10 } });
  });

  it.each([
    ["mock source", { ...current, source: "mock" }],
    ["collecting state", { ...current, collectionState: "collecting" }],
    ["different revision", { ...current, currentModelRevision: "other" }],
    ["expired metric", { ...current, samples: [{ ...current.samples[0], cpuPercent: metric(40) && { value: 40, observedAtMs: now - 2000, expiresAtMs: now } }] }],
    ["absent metric", { ...current, samples: [{ ...current.samples[0], networkTxBytesPerSecond: null }] }],
    ["unknown service identity", { ...current, samples: [{ ...current.samples[0], containerId: "docker_container_other" }] }]
  ] as const)("fails closed for %s", (_name, telemetry) => {
    const claim = observedResourceFor(model.services[0], model, telemetry as unknown as ObservedResourceTelemetryResponse, now);
    expect(claim).toEqual({ kind: "unavailable", value: null, detail: RESOURCE_TELEMETRY_UNAVAILABLE_DETAIL });
  });

  it("labels a stale Docker cache explicitly while publishing no metrics", () => {
    expect(observedResourceFor(model.services[0], model, { ...current, collectionState: "stale" }, now))
      .toEqual({ kind: "unavailable", value: null, detail: RESOURCE_TELEMETRY_STALE_DETAIL });
  });

  it("rejects inherited Docker source and invalid envelope values", () => {
    const inherited = Object.assign(Object.create({ source: "docker" }), (({ source: _source, ...rest }) => rest)(current)) as ObservedResourceTelemetryResponse;
    expect(observedResourceFor(model.services[0], model, inherited, now).kind).toBe("unavailable");
    expect(observedResourceFor(model.services[0], model, { ...current, samples: [{ ...current.samples[0]!, cpuPercent: metric(Number.NaN) }] }, now).kind).toBe("unavailable");
  });

  it("does not associate telemetry through a redaction-collided service id", () => {
    const collidedModel = { ...model, byId: new Map<string, typeof model.services[0]>() };
    expect(observedResourceFor(model.services[0], collidedModel, current, now).kind).toBe("unavailable");
  });
});
