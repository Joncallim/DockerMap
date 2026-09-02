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

const mutualComposeFinding = {
  id: "finding_docker_compose_mutual_dependency_opaque",
  ruleId: "docker.compose_mutual_dependency",
  severity: "advisory",
  summary: "Docker recorded mutually declared Compose dependencies between two containers.",
  recommendation: "Review the declared dependencies and remove any unintended mutual dependency.",
  subjectRef: "docker_container_alpha", targetRef: "docker_container_beta",
  evidenceRefs: [
    { version: 1, id: "opaque-forward", provider: "docker", kind: "docker_compose_depends_on", assertionKind: "observed", providerSlot: null, freshness: "fresh", subjectRef: "docker_container_alpha", summary: "Docker recorded Compose dependency declaration", collectedAt: 1, providerRevision: "opaque-revision" },
    { version: 1, id: "opaque-reverse", provider: "docker", kind: "docker_compose_depends_on", assertionKind: "observed", providerSlot: null, freshness: "fresh", subjectRef: "docker_container_beta", summary: "Docker recorded Compose dependency declaration", collectedAt: 1, providerRevision: "opaque-revision" }
  ]
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

  it("admits only the ordered, contemporaneous mutual Compose pair", () => {
    expect(presentationForFinding(mutualComposeFinding)).toMatchObject({
      title: "Mutual Compose declarations need review", category: "Docker Compose", inspectChanges: true
    });

    const omittedSlots = structuredClone(mutualComposeFinding);
    delete (omittedSlots.evidenceRefs[0] as { providerSlot?: unknown }).providerSlot;
    delete (omittedSlots.evidenceRefs[1] as { providerSlot?: unknown }).providerSlot;
    expect(presentationForFinding(omittedSlots)).not.toBeNull();
  });

  it("suppresses malformed, reordered, stale, or mismatched mutual Compose evidence", () => {
    expect(presentationForFinding({ ...mutualComposeFinding, evidenceRefs: [...mutualComposeFinding.evidenceRefs].reverse() })).toBeNull();
    expect(presentationForFinding({ ...mutualComposeFinding, subjectRef: "docker_container_beta", targetRef: "docker_container_alpha" })).toBeNull();
    expect(presentationForFinding({ ...mutualComposeFinding, evidenceRefs: [{ ...mutualComposeFinding.evidenceRefs[0], providerRevision: "different" }, mutualComposeFinding.evidenceRefs[1]] })).toBeNull();
    expect(presentationForFinding({ ...mutualComposeFinding, evidenceRefs: [{ ...mutualComposeFinding.evidenceRefs[0], freshness: "stale" }, mutualComposeFinding.evidenceRefs[1]] })).toBeNull();
    expect(presentationForFinding({ ...mutualComposeFinding, evidenceRefs: [mutualComposeFinding.evidenceRefs[0]] })).toBeNull();
  });
});
