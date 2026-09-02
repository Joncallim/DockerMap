import { describe, expect, it } from "vitest";
import { presentationForFinding } from "./findingPresentation";

const composeFinding = {
  id: "finding_docker_compose_declared_target_not_active_opaque",
  ruleId: "docker.compose_declared_target_not_active",
  severity: "advisory",
  summary: "A running Docker Compose service declares a dependency whose container is not active.",
  recommendation: "Review the declared dependency and the target container state.",
  subjectRef: "docker_container_source", targetRef: "docker_container_target",
  evidenceRefs: [{ version: 1, provider: "docker", kind: "docker_compose_depends_on", assertionKind: "observed", providerSlot: null, freshness: "fresh", subjectRef: "docker_container_source" }]
};

describe("finding presentation boundary", () => {
  it("admits only the static closed Compose advisory shape", () => {
    expect(presentationForFinding(composeFinding)).toMatchObject({
      title: "Declared Compose dependency needs review", category: "Docker Compose", inspectChanges: true
    });
  });

  it("fails closed for unrecognized, malformed, or stale Compose-shaped data", () => {
    expect(presentationForFinding({ ...composeFinding, ruleId: "server.supplied" })).toBeNull();
    expect(presentationForFinding({ ...composeFinding, summary: "runtime drift detected" })).toBeNull();
    expect(presentationForFinding({ ...composeFinding, evidenceRefs: [{ ...composeFinding.evidenceRefs[0], freshness: "stale" }] })).toBeNull();
    expect(presentationForFinding({ ...composeFinding, subjectRef: "docker_container_same", targetRef: "docker_container_same" })).toBeNull();
  });
});
