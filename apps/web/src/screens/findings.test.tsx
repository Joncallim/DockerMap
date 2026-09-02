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
});
