import { describe, expect, it } from "vitest";
import type { FindingsResponse, RuntimeEvidenceRef, RuntimeMapEdge } from "@dockermap/contracts";
import daemonRuntimeMapFixture from "../../../../../tests/fixtures/contracts/runtime-map-daemon-emitted.json";
import semanticGolden from "./__goldens__/two-container-semantic.json";
import layoutGolden from "./__goldens__/two-container-layout.json";
import {
  atlasFixtureMatrix,
  collisionFixture,
  crossSourceLookalikeFixture,
  daemonStateAttachmentFixture,
  malformedIdentityFixture,
  matrixFixture,
  mutateStateOnly,
  opaquePortFixture,
  permutation,
  runtimeFixture,
  unsupportedKindFixture
} from "./fixtures";
import { ATLAS_CAMERA_POLICY, focusCamera, initialAtlasCamera, layoutAtlas, layoutJson, pointFor, preserveCamera, rectanglesOverlap } from "./layout";
import {
  canonicalSubjectOrder,
  projectRuntimeMap,
  selectedSubject,
  semanticAlternative,
  semanticJson
} from "./project";
import { ATLAS_CAPS, type AtlasRuntimeMapInput, type AtlasSubject } from "./types";

function modelFor(count: number, topology: Parameters<typeof runtimeFixture>[1] = "none", evidence: Parameters<typeof runtimeFixture>[2] = "none") {
  return projectRuntimeMap(runtimeFixture(count, topology, evidence)).model;
}

function pointsBySubject(model: ReturnType<typeof modelFor>) {
  return new Map(layoutAtlas(model).points.map((point) => [point.subject, point]));
}

describe("Atlas V1 fixture matrix", () => {
  it("matches checked-in exact semantic and logical-layout goldens", () => {
    const model = projectRuntimeMap(runtimeFixture(2, "chain", "dependency")).model;
    expect(model).toEqual(semanticGolden);
    expect(layoutAtlas(model)).toEqual(layoutGolden);
  });

  it.each(atlasFixtureMatrix)("projects $name deterministically", (scenario) => {
    const input = matrixFixture(scenario);
    const first = projectRuntimeMap(input).model;
    const second = projectRuntimeMap({ ...input, nodes: permutation(input.nodes), edges: permutation(input.edges) }).model;
    expect(first.subjects.length).toBeLessThanOrEqual(250);
    expect(first.groups).toEqual([]); // V1 must not promote fixture/group labels to semantic grouping.
    expect(first.lanes.every((lane) => lane.presentationOnly)).toBe(true);
    expect(semanticJson(second)).toBe(semanticJson(first));
    expect(layoutJson(layoutAtlas(second))).toBe(layoutJson(layoutAtlas(first)));
  });

  it("covers the exact 0..250 stress cardinalities", () => {
    expect(atlasFixtureMatrix.map((scenario) => scenario.subjectCount)).toEqual(expect.arrayContaining([0, 1, 5, 25, 50, 100, 250]));
  });
});

describe("Atlas truth and collision properties", () => {
  it("never creates a relation from legacy metadata, opaque ports, or an edge lacking structural evidence", () => {
    const model = projectRuntimeMap(opaquePortFixture()).model;
    expect(model.relations).toEqual([]);
    expect(model.attachments).toEqual([]);
    expect(semanticJson(model)).not.toContain("0.0.0.0");
    expect(semanticJson(model)).not.toContain("opaque");
  });

  it("requires full edge-scoped structural evidence and keeps network context non-causal", () => {
    const dependency = modelFor(5, "chain", "dependency");
    const network = modelFor(5, "star", "network");
    expect(dependency.relations).not.toHaveLength(0);
    expect(dependency.relations.every((relation) => relation.evidence.length > 0 && relation.direction === "forward")).toBe(true);
    expect(network.relations).toEqual([]);
    expect(network.attachments).not.toHaveLength(0);
    expect(network.memberships).toEqual([]);
  });

  it("projects canonical daemon-state evidence as an attachment rather than causality", () => {
    const model = projectRuntimeMap(daemonStateAttachmentFixture()).model;
    expect(model.relations).toEqual([]);
    expect(model.attachments).toHaveLength(1);
    expect(model.attachments[0]).toMatchObject({
      subject: "docker_container_container_daemon_client", context: "host_risk_docker_daemon_state"
    });
  });

  it("fails closed for collision, malformed and unknown identities without routing their raw values", () => {
    const collision = projectRuntimeMap(collisionFixture()).model;
    const malformed = projectRuntimeMap(malformedIdentityFixture()).model;
    const unsupported = projectRuntimeMap(unsupportedKindFixture()).model;
    expect(collision.subjects.some((subject) => subject.ambiguity === "collision" && subject.routability === "non_routable")).toBe(true);
    expect(collision.subjects.some((subject) => subject.key.includes("docker_container_container_000"))).toBe(false);
    expect(semanticJson(malformed)).not.toContain("unsafe path");
    expect(unsupported.subjects[0]).toMatchObject({ routability: "non_routable", ambiguity: "unsupported" });
    expect(selectedSubject(collision, "runtime_subject_000")).toBeNull();
  });

  it("retains independently evidenced disagreements instead of selecting a last write", () => {
    const input = runtimeFixture(2, "chain", "dependency");
    const original = input.edges[0]!;
    const refs = original.evidenceRefs;
    const first = refs[0] as RuntimeEvidenceRef;
    input.edges = [
      original,
      { ...original, evidenceRefs: [{ ...first, id: "evidence_disagreement", providerRevision: "revision_two" }] }
    ];
    const model = projectRuntimeMap(input).model;
    expect(model.relations).toHaveLength(2);
    expect(model.diagnostics.filter((entry) => entry.kind === "disagreement")).toHaveLength(0);
  });

  it("uses full structural evidence as a canonical same-endpoint tie-breaker", () => {
    const input = runtimeFixture(2, "chain", "dependency");
    const first = input.edges[0]!;
    const evidence = first.evidenceRefs[0] as RuntimeEvidenceRef;
    const second = { ...first, evidenceRefs: [{ ...evidence, id: "evidence_second", providerRevision: "revision_two" }] as [RuntimeEvidenceRef] };
    const ordered = projectRuntimeMap({ ...input, edges: [second, first] }).model;
    const reversed = projectRuntimeMap({ ...input, edges: [first, second] }).model;
    expect(semanticJson(ordered)).toBe(semanticJson(reversed));
  });

  it("rejects oversized node or edge collections before sorting/processing them", () => {
    const oversizedNodes = projectRuntimeMap(runtimeFixture(251)).model;
    expect(oversizedNodes.subjects).toEqual([]);
    expect(oversizedNodes.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "bounded_omission" })]));
    expect(oversizedNodes.stats.boundedOmissions).toBe(251);

    const edgeFixture = runtimeFixture(2, "chain", "dependency");
    edgeFixture.edges = Array.from({ length: 401 }, () => edgeFixture.edges[0]!);
    const oversizedEdges = projectRuntimeMap(edgeFixture).model;
    expect(oversizedEdges.relations).toEqual([]);
    expect(oversizedEdges.stats.boundedOmissions).toBe(401);
  });

  it("preserves distinct source-scoped records despite lookalike labels", () => {
    const input = runtimeFixture(2);
    input.nodes = input.nodes.map((node) => ({ ...node, label: "same-looking" }));
    const model = projectRuntimeMap(input).model;
    expect(model.subjects.filter((subject) => subject.routability === "routable")).toHaveLength(2);
    expect(new Set(model.subjects.map((subject) => subject.key)).size).toBe(2);
  });

  it("does not merge same-looking cross-source subjects without an explicit correlation key", () => {
    const model = projectRuntimeMap(crossSourceLookalikeFixture()).model;
    expect(model.subjects.filter((subject) => subject.routability === "routable").map((subject) => subject.key)).toEqual([
      "docker_container_container_same_entity", "systemd_service_same_entity"
    ]);
  });

  it("projects the canonical daemon fixture only through contract-valid evidence endpoints", () => {
    const model = projectRuntimeMap(daemonRuntimeMapFixture as unknown as AtlasRuntimeMapInput).model;
    const dependency = model.relations.find((relation) => relation.source === "docker_container_container_api");
    expect(dependency).toMatchObject({ target: "docker_container_container_db", direction: "forward" });
    expect(dependency?.evidence[0]?.evidence).toMatchObject({
      kind: "docker_compose_depends_on", assertionKind: "observed", subjectRef: "docker_container_container_api"
    });
    expect(model.attachments.some((attachment) => attachment.context === "docker_network_network_app")).toBe(true);
    expect(model.relations.some((relation) => relation.target === "docker_network_network_app")).toBe(false);
  });

  it("retains total outbound attachment population and reports cap omissions in its aggregate", () => {
    const model = modelFor(10, "outbound_star", "network");
    expect(model.attachments).toHaveLength(8);
    expect(model.aggregates).toHaveLength(1);
    expect(model.aggregates[0]?.population).toEqual({ resolved: 9, unresolved: 0, ambiguous: 0, omitted: 1 });
    expect(model.stats.boundedOmissions).toBe(1);
  });

  it("accepts only the closed Systemd V2 table and rejects a forged scheduler binding", () => {
    const input = runtimeFixture(2);
    const source = "systemd_service_alpha";
    const target = "systemd_service_beta";
    input.nodes = [
      { id: source, provider: "systemd", type: "systemd_service", layer: "service", label: "alpha", status: "running", metadata: {} },
      { id: target, provider: "systemd", type: "systemd_service", layer: "service", label: "beta", status: "running", metadata: {} }
    ];
    const evidence: RuntimeEvidenceRef = {
      version: 2, id: "systemd-evidence", provider: "systemd", kind: "systemd_requires", assertionKind: "declared",
      freshness: "stale", providerRevision: "systemd-revision", providerSlot: "systemd", subjectRef: source,
      summary: "systemd declared requirement", collectedAt: 1
    };
    const edge: RuntimeMapEdge = { source, target, relationship: "requires", metadata: {}, evidenceRefs: [evidence] };
    expect(projectRuntimeMap({ ...input, edges: [edge] }).model.relations).toHaveLength(1);
    const forged = { ...edge, evidenceRefs: [{ ...evidence, providerSlot: "project_npm" }] as [RuntimeEvidenceRef] };
    expect(projectRuntimeMap({ ...input, edges: [forged] }).model.relations).toEqual([]);
  });

  it("rejects V1 Docker daemon-state evidence unless its target is the one exact published risk node", () => {
    const input = runtimeFixture(2);
    const source = "docker_container_container_daemon_client";
    const target = "host_other";
    input.nodes = [
      { id: source, provider: "docker", type: "container", layer: "container", label: "client", status: "running", metadata: {} },
      { id: target, provider: "host", type: "host", layer: "host", label: "other", status: "running", metadata: {} }
    ];
    input.edges = [{
      source, target, relationship: "exposes_daemon_state", metadata: {}, evidenceRefs: [{
        version: 1, id: "daemon-state", provider: "docker", kind: "docker_daemon_state_bind_mount", assertionKind: "observed",
        freshness: "fresh", providerRevision: "docker-r1", subjectRef: source, summary: "daemon state observation", collectedAt: 1
      }]
    } as RuntimeMapEdge];
    expect(projectRuntimeMap(input).model.attachments).toEqual([]);
  });

  it("ignores valid NPM evidence until a V1 Atlas projection rule explicitly permits it", () => {
    const input = runtimeFixture(2);
    const source = "npm_project_example";
    const target = "npm_package_example_1_0_0";
    input.nodes = [
      { id: source, provider: "npm", type: "package", layer: "package", label: "example", status: null, metadata: {} },
      { id: target, provider: "npm", type: "package_dependency", layer: "package", label: "dependency", status: null, metadata: {} }
    ];
    input.edges = [{
      source, target, relationship: "depends_on", metadata: {}, evidenceRefs: [{
        version: 3, id: "npm-evidence", provider: "npm", kind: "npm_package_manifest_dependency", assertionKind: "declared",
        freshness: "fresh", providerRevision: "npm-r1", providerSlot: "project_npm", subjectRef: source,
        summary: "manifest declared dependency", collectedAt: 1
      }]
    } as RuntimeMapEdge];
    expect(projectRuntimeMap(input).model.relations).toEqual([]);
  });

  it("bounds raw labels before normalization and canonical sorting", () => {
    const input = runtimeFixture(2);
    input.nodes = input.nodes.map((node, index) => ({ ...node, label: `${"x".repeat(20_000)}-${index}` }));
    const first = projectRuntimeMap(input).model;
    const second = projectRuntimeMap({ ...input, nodes: permutation(input.nodes) }).model;
    expect(semanticJson(first)).toBe(semanticJson(second));
    expect(first.subjects.every((subject) => Array.from(subject.display).length <= 96)).toBe(true);
  });

  it("keeps provider freshness and coherent Findings attention orthogonal across stale/timed-out/unavailable states", () => {
    const source = "systemd_service_same_entity";
    const evidence: RuntimeEvidenceRef = {
      version: 2, id: "systemd-finding-evidence", provider: "systemd", kind: "systemd_requires", assertionKind: "declared",
      freshness: "stale", providerRevision: "systemd-r1", providerSlot: "systemd", subjectRef: source,
      summary: "systemd declared requirement", collectedAt: 1
    };
    for (const state of ["stale", "timed_out", "unavailable"] as const) {
      const input = crossSourceLookalikeFixture();
      input.providerStates = input.providerStates.map((entry) => entry.slot === "systemd"
        ? { ...entry, state, statusReason: state === "timed_out" ? "collection_timed_out" : state === "unavailable" ? "collection_failed" : "collection_failed" }
        : entry
      ) as typeof input.providerStates;
      const findings: FindingsResponse = {
        modelRevision: input.modelRevision,
        findings: [{
          id: `finding-${state}`, ruleId: "systemd.requires_target_not_active", severity: "warning",
          summary: "safe finding", recommendation: "inspect safely", subjectRef: source, targetRef: "systemd_service_target", evidenceRefs: [evidence]
        }]
      };
      const subject = projectRuntimeMap(input, { findings }).model.subjects.find((entry) => entry.key === source);
      expect(subject).toMatchObject({ freshness: state, attention: "warning", operationalState: "healthy" });
    }
    const mismatch = crossSourceLookalikeFixture();
    const subject = projectRuntimeMap(mismatch, { findings: { modelRevision: "different", findings: [] } }).model.subjects.find((entry) => entry.key === source);
    expect(subject).toMatchObject({ attention: "none" });

    const oversizedInput = crossSourceLookalikeFixture();
    const oversizedFinding = {
      id: "oversized-finding", ruleId: "systemd.requires_target_not_active" as const, severity: "warning" as const,
      summary: "safe finding", recommendation: "inspect safely", subjectRef: source, targetRef: "systemd_service_target", evidenceRefs: [evidence] as [RuntimeEvidenceRef]
    };
    const oversized = projectRuntimeMap(oversizedInput, {
      findings: { modelRevision: oversizedInput.modelRevision, findings: Array.from({ length: 251 }, (_, index) => ({ ...oversizedFinding, id: `oversized-${index}` })) }
    }).model;
    expect(oversized.subjects.find((entry) => entry.key === source)).toMatchObject({ attention: "none" });
    expect(oversized.stats.boundedOmissions).toBe(251);
    expect(oversized.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "bounded_omission" })]));
  });

  it("rejects an oversized evidence string before code-point expansion or edge projection", () => {
    const input = runtimeFixture(2, "chain", "dependency");
    const edge = input.edges[0]!;
    const evidence = edge.evidenceRefs[0] as RuntimeEvidenceRef;
    input.edges = [{ ...edge, evidenceRefs: [{ ...evidence, summary: "x".repeat(100_000) }] as [RuntimeEvidenceRef] }];
    expect(projectRuntimeMap(input).model.relations).toEqual([]);
  });

  it("rejects oversized edge evidence before inspecting members and keeps valid-edge ordering deterministic", () => {
    const input = runtimeFixture(2, "chain", "dependency");
    const valid = input.edges[0]!;
    let inspected = 0;
    const hostileEvidence = new Array(ATLAS_CAPS.edgeEvidence + 1);
    for (let index = 0; index < hostileEvidence.length; index += 1) {
      Object.defineProperty(hostileEvidence, index, {
        enumerable: true,
        get: () => {
          inspected += 1;
          throw new Error("oversized evidence must not be inspected");
        }
      });
    }
    const malformed: RuntimeMapEdge = {
      ...valid,
      evidenceRefs: hostileEvidence as unknown as RuntimeMapEdge["evidenceRefs"]
    };
    const first = projectRuntimeMap({ ...input, edges: [malformed, valid] }).model;
    const second = projectRuntimeMap({ ...input, edges: [valid, malformed] }).model;
    expect(inspected).toBe(0);
    expect(first.relations).toHaveLength(1);
    expect(semanticJson(second)).toBe(semanticJson(first));
  });

  it("rejects oversized provider-state arrays before inspecting members while retaining safe unknown freshness", () => {
    const input = crossSourceLookalikeFixture();
    let inspected = 0;
    const hostileStates = new Array(8);
    for (let index = 0; index < hostileStates.length; index += 1) {
      Object.defineProperty(hostileStates, index, {
        enumerable: true,
        get: () => {
          inspected += 1;
          throw new Error("oversized provider states must not be inspected");
        }
      });
    }
    const malformed = {
      ...input,
      providerStates: hostileStates as unknown as typeof input.providerStates
    };
    const first = projectRuntimeMap(malformed).model;
    const second = projectRuntimeMap({ ...malformed, nodes: permutation(malformed.nodes) }).model;
    expect(inspected).toBe(0);
    expect(first.subjects.find((subject) => subject.key === "systemd_service_same_entity")).toMatchObject({ freshness: "unknown" });
    expect(semanticJson(second)).toBe(semanticJson(first));
  });

  it("fails closed for a giant raw ID and bounds status parsing/sorting across the 250-subject cap", () => {
    const input = runtimeFixture(250);
    const giant = " ".repeat(100_000);
    input.nodes = input.nodes.map((node, index) => ({
      ...node,
      id: index === 0 ? `${giant}unsafe-id` : node.id,
      status: `${giant}running`
    }));
    const first = projectRuntimeMap(input).model;
    const second = projectRuntimeMap({ ...input, nodes: permutation(input.nodes) }).model;
    expect(first.subjects).toHaveLength(249);
    expect(first.subjects.every((subject) => subject.operationalState === "unknown")).toBe(true);
    expect(semanticJson(first)).toBe(semanticJson(second));
  });
});

describe("Atlas logical layout and camera properties", () => {
  it("keeps every current subject anchor fixed across state-only and relation-only revisions", () => {
    const base = runtimeFixture(25, "chain", "dependency");
    const stateOnly = mutateStateOnly(base);
    const relationOnly: AtlasRuntimeMapInput = { ...base, edges: [] };
    const before = pointsBySubject(projectRuntimeMap(base).model);
    for (const change of [stateOnly, relationOnly]) {
      const after = pointsBySubject(projectRuntimeMap(change).model);
      for (const [key, point] of before) expect(after.get(key)).toEqual(point);
    }
  });

  it("keeps unrelated provider/lane anchors fixed and has no global normalization", () => {
    const base = runtimeFixture(25);
    const changed: AtlasRuntimeMapInput = {
      ...base,
      nodes: [...base.nodes, {
        id: "runtime_host_context", provider: "host", type: "host", layer: "host", label: "host", status: "running", metadata: {}
      }]
    };
    const before = pointsBySubject(projectRuntimeMap(base).model);
    const after = pointsBySubject(projectRuntimeMap(changed).model);
    for (const [key, point] of before) expect(after.get(key)).toEqual(point);
  });

  it("uses fixed geometry without interactive card overlap at the 250-object cap", () => {
    const points = layoutAtlas(modelFor(250)).points;
    for (let left = 0; left < points.length; left += 1) {
      for (let right = left + 1; right < points.length; right += 1) {
        expect(rectanglesOverlap(points[left], points[right])).toBe(false);
      }
    }
  });

  it("preserves camera across routine revisions and bounds explicit focus", () => {
    const camera = { x: 4, y: -9, zoom: 1.5 };
    expect(ATLAS_CAMERA_POLICY.preserveOn).toEqual(["state", "relation", "attachment", "unrelated_structure", "lens"]);
    expect(initialAtlasCamera()).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(preserveCamera(camera)).toEqual(camera);
    const point = pointFor(layoutAtlas(modelFor(1)), "runtime_subject_000");
    expect(point).toBeDefined();
    const focused = focusCamera(camera, point!, { width: 800, height: 600 });
    expect(focused).toMatchObject({ zoom: 1.5 });
    expect(Math.abs(focused.x)).toBeLessThanOrEqual(100_000);
    expect(Math.abs(focused.y)).toBeLessThanOrEqual(100_000);
  });
});

describe("Atlas semantic-order parity", () => {
  it("derives keyboard, text alternative and selection from one canonical model order", () => {
    const model = modelFor(25, "chain", "dependency");
    const canonical = canonicalSubjectOrder(model);
    const directory = semanticAlternative(model).filter((entry) => entry.kind === "subject");
    expect(directory.map((entry) => entry.key)).toEqual(canonical.map((subject) => subject.key));
    for (const subject of canonical) {
      const selected = selectedSubject(model, subject.key);
      if (subject.routability === "routable") expect(selected?.key).toBe(subject.key);
      else expect(selected).toBeNull();
    }
  });

  it("keeps orthogonal health, freshness, attention and ambiguity fields separate", () => {
    const subject = modelFor(1).subjects[0] as AtlasSubject;
    const variants = ["healthy", "warning", "degraded", "offline", "updating", "unknown"] as const;
    for (const operationalState of variants) {
      const changed = { ...subject, operationalState, freshness: "stale" as const, attention: "warning" as const, ambiguity: "unresolved" as const };
      expect(changed.operationalState).toBe(operationalState);
      expect(changed.freshness).toBe("stale");
      expect(changed.attention).toBe("warning");
      expect(changed.ambiguity).toBe("unresolved");
    }
  });
});
