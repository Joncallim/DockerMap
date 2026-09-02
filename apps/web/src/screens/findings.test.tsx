import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { FindingsResponse } from "@dockermap/contracts";
import { AppContext, type AppContextValue } from "../context";
import Findings from "./Findings";

const findings: FindingsResponse = {
  modelRevision: "findings-revision",
  findings: [{
    id: "finding_systemd_requires_target_not_active_test",
    ruleId: "systemd.requires_target_not_active",
    severity: "warning",
    summary: "An active systemd service requires a target that is inactive or failed",
    recommendation: "Inspect the target service state and its declared dependency configuration.",
    subjectRef: "systemd_service_application",
    targetRef: "systemd_service_database",
    evidenceRefs: [{
      version: 2, id: "systemd_requires:systemd_service_application:systemd_service_database",
      provider: "systemd", kind: "systemd_requires", assertionKind: "declared",
      summary: "systemd declared a Requires dependency", subjectRef: "systemd_service_application",
      collectedAt: 1, providerRevision: "test-systemd-observation", providerSlot: "systemd", freshness: "fresh"
    }]
  }]
};

const temporalFinding: FindingsResponse = {
  modelRevision: "findings-revision",
  findings: [{
    id: "finding_docker_repeated_container_died_events_docker_container_dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd--249bd4907c9ebee596f254dc5635c27837d2f00a6c3ed32794af0237fc0fbde0",
    ruleId: "docker.repeated_container_died_events",
    severity: "advisory",
    summary: "A Docker container had three observed die events within five minutes.",
    recommendation: "Review the container's recent configuration and logs to determine whether the repeated exits are expected.",
    subjectRef: "docker_container_dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    targetRef: "docker_event_stream",
    evidenceRefs: [],
    temporalEvidenceRefs: [
      { eventId: "docker_event_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", source: "docker_event_stream", kind: "container_died", sourceOccurredAtMs: 1_710_000_000_000, anchorModelRevision: "anchor-a", anchorObservationRevision: "observed-a" },
      { eventId: "docker_event_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", source: "docker_event_stream", kind: "container_died", sourceOccurredAtMs: 1_710_000_100_000, anchorModelRevision: "anchor-b", anchorObservationRevision: "observed-b" },
      { eventId: "docker_event_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", source: "docker_event_stream", kind: "container_died", sourceOccurredAtMs: 1_710_000_200_000, anchorModelRevision: "anchor-c", anchorObservationRevision: "observed-c" }
    ]
  }]
};

function render(value: Partial<AppContextValue>): string {
  const context: AppContextValue = {
    model: null, modelProvenance: null, loading: false, error: null, health: null,
    findings: null, tick: 0, evidenceMode: null, openCommand: () => {}, ...value
  };
  return renderToStaticMarkup(<AppContext.Provider value={context}><MemoryRouter><Findings /></MemoryRouter></AppContext.Provider>);
}

describe("Findings screen", () => {
  it("renders only the bounded declaration conclusion and its static recommendation", () => {
    const html = render({ findings });
    expect(html).toContain("Declared dependency needs review");
    expect(html).toContain(findings.findings[0].summary);
    expect(html).toContain(findings.findings[0].recommendation);
    expect(html).toContain("Systemd Requires");
    expect(html).toContain("not health, readiness, traffic, Internet-reachability, or security conclusions");
  });

  it("fails closed when a coherent live finding response is unavailable", () => {
    const html = render({ findings: null });
    expect(html).toContain("Live evidence is not established");
    expect(html).toContain("model revision matches the current live Docker model");
  });

  it("describes the Docker internal-network condition without claiming Internet exposure", () => {
    const internalPort = structuredClone(findings);
    internalPort.findings[0] = {
      id: "finding_docker_internal_network_member_publishes_port_test",
      ruleId: "docker.internal_network_member_publishes_port",
      severity: "advisory",
      summary: "A container on an internal Docker network also has a published host port.",
      recommendation: "Review whether the host-port publication is intended for this internal-network service.",
      subjectRef: "docker_container_api",
      targetRef: "docker_network_internal",
      evidenceRefs: [
        { version: 1, id: "network", provider: "docker", kind: "docker_network_membership", assertionKind: "observed", summary: "Docker reported container network membership", subjectRef: "docker_container_api", collectedAt: 1, providerRevision: "opaque", providerSlot: null, freshness: "fresh" },
        { version: 1, id: "port", provider: "docker", kind: "docker_port_publication", assertionKind: "observed", summary: "Docker reported a published container port", subjectRef: "docker_container_api", collectedAt: 1, providerRevision: "opaque", providerSlot: null, freshness: "fresh" }
      ]
    };
    const html = render({ findings: internalPort });
    expect(html).toContain("Internal-network port publication needs review");
    expect(html).toContain("Observed Docker facts");
    expect(html).toContain("2 supporting facts");
    expect(html).not.toContain("Internet exposure");
  });

  it("labels daemon-state access as a bounded authority review without mount details", () => {
    const daemonState = structuredClone(findings);
    daemonState.findings[0] = {
      id: "finding_docker_daemon_state_bind_mount_test",
      ruleId: "docker.daemon_state_bind_mount",
      severity: "warning",
      summary: "A container has Docker daemon state access that may provide Docker daemon API authority.",
      recommendation: "Review whether this container requires Docker daemon API authority.",
      subjectRef: "docker_container_api",
      targetRef: "host_risk_docker_daemon_state",
      evidenceRefs: [{ version: 1, id: "daemon-state", provider: "docker", kind: "docker_daemon_state_bind_mount", assertionKind: "observed", summary: "Docker reported a bind mount exposing Docker daemon state", subjectRef: "docker_container_api", collectedAt: 1, providerRevision: "opaque", providerSlot: null, freshness: "fresh" }]
    };
    const html = render({ findings: daemonState });
    expect(html).toContain("Docker daemon-state access needs review");
    expect(html).toContain("Docker daemon state");
    expect(html).toContain("may provide Docker daemon API authority");
    expect(html).not.toContain("/var/run/docker.sock");
  });

  it("renders the temporal advisory as a generic bounded history link without raw event material or lifecycle conclusions", () => {
    const html = render({ findings: temporalFinding });
    expect(html).toContain("Docker event history needs review");
    expect(html).toContain("Three retained Docker event observations fall within the five-minute review threshold.");
    expect(html).toContain('href="/changes"');
    expect(html).not.toContain('href="/services/');
    expect(html).not.toContain(temporalFinding.findings[0].id);
    expect(html).not.toContain(temporalFinding.findings[0].subjectRef);
    expect(html).not.toContain(temporalFinding.findings[0]!.temporalEvidenceRefs![0]!.eventId);
    expect(html).not.toContain("anchor-a");
    expect(html).not.toContain("1710000000000");
    expect(html).not.toMatch(/crash|restart|current state|cause/i);
  });

  it.each([
    ["wrong evidence kind", (value: FindingsResponse) => { value.findings[0]!.temporalEvidenceRefs![1]!.kind = "container_died_x" as never; }],
    ["out-of-window timestamps", (value: FindingsResponse) => { value.findings[0]!.temporalEvidenceRefs![2]!.sourceOccurredAtMs += 300_001; }],
    ["opaque subject replacement", (value: FindingsResponse) => { value.findings[0]!.subjectRef = "docker_container_api"; }],
    ["unreviewed field", (value: FindingsResponse) => { Object.assign(value.findings[0]!.temporalEvidenceRefs![0]!, { raw: "must-not-render" }); }]
  ])("fails closed for a temporal finding with %s", (_label, mutate) => {
    const malformed = structuredClone(temporalFinding);
    mutate(malformed);
    const html = render({ findings: malformed });
    expect(html).toContain("Live evidence is not established");
    expect(html).not.toContain("Docker event history needs review");
    expect(html).not.toContain("must-not-render");
  });

  it.each([
    ["demo", "demo", "demo"],
    ["mock", "mock", "mock"]
  ] as const)("does not present temporal findings as live while in %s mode", (_label, evidenceMode, modelProvenance) => {
    const html = render({ findings: temporalFinding, evidenceMode, modelProvenance });
    expect(html).toContain("Live evidence is not established");
    expect(html).not.toContain("Docker event history needs review");
  });
});
