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

const composeMountFinding = {
  id: "finding_compose_declared_mount_missing_at_bound_container_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ruleId: "compose.declared_mount_missing_at_bound_container",
  severity: "warning",
  summary: "A Compose-declared mount is absent from its exactly bound runtime container",
  recommendation: "Inspect the Compose mount declaration and the bound container's current mount configuration.",
  subjectRef: "compose_runtime_binding_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  targetRef: "compose_runtime_binding_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  evidenceRefs: [
    { version: 6, id: "compose_declared_mount_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", provider: "compose", kind: "compose_declared_mount", assertionKind: "declared", summary: "Compose declared a mount for the bound service", subjectRef: "compose_runtime_binding_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", collectedAt: 1, providerRevision: "opaque-observation", freshness: "fresh" },
    { version: 6, id: "docker_compose_runtime_binding_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", provider: "docker", kind: "docker_compose_runtime_binding", assertionKind: "observed", summary: "Docker confirmed an exact Compose project, service, and config binding", subjectRef: "compose_runtime_binding_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", collectedAt: 1, providerRevision: "opaque-observation", freshness: "fresh" }
  ]
};

const unspecifiedAddressFinding = {
  id: "finding_docker_port_published_on_unspecified_address_opaque",
  ruleId: "docker.port_published_on_unspecified_address",
  severity: "advisory",
  summary: "Docker reported a container port published on an unspecified host address.",
  recommendation: "Review whether publishing this container port beyond loopback is intended.",
  subjectRef: "docker_container_redacted", targetRef: "host_risk_docker_unspecified_address_port",
  evidenceRefs: [{ version: 1, id: "opaque-publication", provider: "docker", kind: "docker_unspecified_address_port_publication", assertionKind: "observed", summary: "Docker reported a container port published on an unspecified host address", subjectRef: "docker_container_redacted", collectedAt: 1, providerRevision: "opaque-observation", providerSlot: null, freshness: "fresh" }]
};

const identityCollisionFinding = {
  id: "finding_runtime_identity_collision_detected",
  ruleId: "runtime.identity_collision_detected",
  severity: "advisory",
  summary: "DockerMap detected duplicate runtime identities after publication normalization.",
  recommendation: "Review the duplicate identity condition before relying on topology relationships.",
  subjectRef: "runtime_integrity_scope", targetRef: "runtime_integrity_risk_identity_collision",
  evidenceRefs: [{ version: 7, id: "dockermap_evidence_runtime_identity_collision", provider: "dockermap", kind: "runtime_identity_collision", assertionKind: "observed", summary: "DockerMap detected duplicate runtime identities after publication normalization", subjectRef: "runtime_integrity_scope", collectedAt: 1, providerRevision: "0123456789abcdef0123456789abcdef-1", freshness: "fresh" }]
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

  it("admits only one opaque, paired v6 Compose/runtime mount condition", () => {
    expect(presentationForFinding(composeMountFinding)).toMatchObject({
      title: "Declared Compose mount needs review", category: "Compose runtime drift", inspectChanges: true
    });
  });

  it("suppresses malformed, path-shaped, or stitched v6 Compose/runtime mount evidence", () => {
    expect(presentationForFinding({ ...composeMountFinding, targetRef: "compose_runtime_binding_" + "c".repeat(64) })).toBeNull();
    expect(presentationForFinding({ ...composeMountFinding, evidenceRefs: [...composeMountFinding.evidenceRefs].reverse() })).toBeNull();
    expect(presentationForFinding({ ...composeMountFinding, evidenceRefs: [{ ...composeMountFinding.evidenceRefs[0], id: "/private/compose.yaml" }, composeMountFinding.evidenceRefs[1]] })).toBeNull();
    expect(presentationForFinding({ ...composeMountFinding, evidenceRefs: [composeMountFinding.evidenceRefs[0], { ...composeMountFinding.evidenceRefs[1], providerRevision: "other-observation" }] })).toBeNull();
    expect(presentationForFinding({ ...composeMountFinding, evidenceRefs: [{ ...composeMountFinding.evidenceRefs[0], freshness: "stale" }, composeMountFinding.evidenceRefs[1]] })).toBeNull();
  });

  it("admits only the static unspecified-address Docker publication advisory", () => {
    expect(presentationForFinding(unspecifiedAddressFinding)).toMatchObject({
      title: "Unspecified-address port publication needs review", category: "Host port publication"
    });
    const omittedSlot = structuredClone(unspecifiedAddressFinding);
    delete (omittedSlot.evidenceRefs[0] as { providerSlot?: unknown }).providerSlot;
    expect(presentationForFinding(omittedSlot)).not.toBeNull();
  });

  it("suppresses forged, stale, or address-shaped unspecified-address publication data", () => {
    expect(presentationForFinding({ ...unspecifiedAddressFinding, targetRef: "host_risk_other" })).toBeNull();
    expect(presentationForFinding({ ...unspecifiedAddressFinding, summary: "0.0.0.0:443" })).toBeNull();
    expect(presentationForFinding({ ...unspecifiedAddressFinding, evidenceRefs: [{ ...unspecifiedAddressFinding.evidenceRefs[0], kind: "docker_port_publication" }] })).toBeNull();
    expect(presentationForFinding({ ...unspecifiedAddressFinding, evidenceRefs: [{ ...unspecifiedAddressFinding.evidenceRefs[0], summary: "0.0.0.0:443" }] })).toBeNull();
    expect(presentationForFinding({ ...unspecifiedAddressFinding, evidenceRefs: [{ ...unspecifiedAddressFinding.evidenceRefs[0], providerSlot: "project_npm" }] })).toBeNull();
    expect(presentationForFinding({ ...unspecifiedAddressFinding, evidenceRefs: [{ ...unspecifiedAddressFinding.evidenceRefs[0], freshness: "stale" }] })).toBeNull();
    expect(presentationForFinding({ ...unspecifiedAddressFinding, evidenceRefs: [{ ...unspecifiedAddressFinding.evidenceRefs[0], providerRevision: "1" }] })).toBeNull();
  });

  it("admits only the fixed aggregate identity-collision fact without identities", () => {
    expect(presentationForFinding(identityCollisionFinding)).toMatchObject({
      title: "Runtime identity integrity needs review", category: "Evidence integrity"
    });
    expect(presentationForFinding({ ...identityCollisionFinding, subjectRef: "runtime_integrity_scope_collision_a" })).toBeNull();
    expect(presentationForFinding({ ...identityCollisionFinding, evidenceRefs: [{ ...identityCollisionFinding.evidenceRefs[0], summary: "collision: secret-container" }] })).toBeNull();
    expect(presentationForFinding({ ...identityCollisionFinding, evidenceRefs: [{ ...identityCollisionFinding.evidenceRefs[0], providerRevision: "fixture-revision" }] })).toBeNull();
  });
});
