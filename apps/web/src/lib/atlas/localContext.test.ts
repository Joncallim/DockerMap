import { describe, expect, it } from "vitest";
import { collisionFixture, runtimeFixture } from "./fixtures";
import { localAttachmentContext, ATLAS_LOCAL_CONTEXT_POLICY } from "./localContext";
import { projectRuntimeMap } from "./project";
import policyGolden from "./__goldens__/local-attachment-policy.json";

function model(count: number, evidence: "network" | "storage" | "port" = "network") {
  return projectRuntimeMap(runtimeFixture(count, "outbound_star", evidence)).model;
}

function selected(modelValue: ReturnType<typeof model>): typeof modelValue.attachments[number]["subject"] {
  return modelValue.attachments[0]!.subject;
}

describe("Atlas selected local attachment rail", () => {
  it("keeps the named local attachment policy golden exact", () => {
    expect(JSON.stringify({ policyVersion: ATLAS_LOCAL_CONTEXT_POLICY.version, maxModelAttachmentsScanned: ATLAS_LOCAL_CONTEXT_POLICY.maxModelAttachmentsScanned, maxSelectedAttachments: ATLAS_LOCAL_CONTEXT_POLICY.maxSelectedAttachments, maxInputAttachments: ATLAS_LOCAL_CONTEXT_POLICY.maxInputAttachments, maxVisibleItems: ATLAS_LOCAL_CONTEXT_POLICY.maxVisibleItems, maxItemsPerKind: ATLAS_LOCAL_CONTEXT_POLICY.maxItemsPerKind, maxAggregateCoverage: ATLAS_LOCAL_CONTEXT_POLICY.maxAggregateCoverage })).toBe(JSON.stringify(policyGolden));
  });

  it("keeps a single membership as recorded non-causal local context", () => {
    const modelValue = projectRuntimeMap(runtimeFixture(2, "outbound_star", "network")).model;
    const context = localAttachmentContext(modelValue, selected(modelValue));
    expect(context).toMatchObject({ policyVersion: "atlas-v1/local-attachment-rail-1", population: { resolved: 1, unresolved: 0, ambiguous: 0, omitted: 0 } });
    expect(context?.items).toHaveLength(1);
    expect(context?.items[0]?.kind).toBe("network_membership");
    expect(JSON.stringify(context)).not.toContain("fixture_docker_network_membership");
  });

  it("uses the named threshold/cap policy for moderate and high-degree context", () => {
    const moderate = model(5);
    const high = model(50);
    const moderateContext = localAttachmentContext(moderate, selected(moderate));
    const highContext = localAttachmentContext(high, selected(high));
    expect(moderateContext?.items).toHaveLength(4); // one kind's deterministic rail cap
    expect(moderateContext?.population).toEqual({ resolved: 4, unresolved: 0, ambiguous: 0, omitted: 0 });
    expect(highContext?.items).toHaveLength(4);
    expect(highContext?.population).toEqual({ resolved: 49, unresolved: 0, ambiguous: 0, omitted: 45 });
    expect(highContext?.projectionOmitted).toBe(41);
    expect(highContext?.presentationOmitted).toBe(4);
  });

  it("keeps distinct mult-network, storage and port contexts separate without causality or port parsing", () => {
    const ports = model(5, "port");
    const storage = model(5, "storage");
    const hugeStorage = model(50, "storage");
    const portContext = localAttachmentContext(ports, selected(ports));
    const storageContext = localAttachmentContext(storage, selected(storage));
    expect(portContext?.items.every((item) => item.kind === "port_publication")).toBe(true);
    expect(new Set(portContext?.items.map((item) => item.display)).size).toBeGreaterThan(1);
    expect(storageContext?.items.every((item) => item.kind === "storage_attachment")).toBe(true);
    expect(localAttachmentContext(hugeStorage, selected(hugeStorage))?.population.resolved).toBe(49);
    expect(JSON.stringify(portContext)).not.toMatch(/host|reachab|protocol|0\.0\.0\.0/i);
  });

  it("fails closed for collision selection and is invariant to attachment permutation", () => {
    const collision = projectRuntimeMap(collisionFixture()).model;
    const collided = collision.subjects.find((entry) => entry.routability === "non_routable")!;
    expect(localAttachmentContext(collision, collided.key as never)).toBeNull();

    const input = model(5);
    const first = localAttachmentContext(input, selected(input));
    const permuted = { ...input, attachments: [...input.attachments].reverse() };
    const second = localAttachmentContext(permuted, selected(input));
    expect(second).toEqual(first);
  });

  it("caps malicious attachment input before local allocation and keeps state-only changes ordered", () => {
    const source = model(5);
    const seed = source.attachments[0]!;
    const oversized = { ...source, attachments: Array.from({ length: 200 }, () => seed) };
    const context = localAttachmentContext(oversized, seed.subject)!;
    expect(context.items.length).toBeLessThanOrEqual(ATLAS_LOCAL_CONTEXT_POLICY.maxVisibleItems);
    expect(context.items.length).toBeLessThanOrEqual(ATLAS_LOCAL_CONTEXT_POLICY.maxItemsPerKind);
    expect(context.inputOmitted).toBe(120);
    const stateOnly = { ...source, subjects: source.subjects.map((subject, index) => index === 0 ? { ...subject, operationalState: "offline" as const } : subject) };
    expect(localAttachmentContext(stateOnly, selected(source))?.items.map((item) => item.display)).toEqual(localAttachmentContext(source, selected(source))?.items.map((item) => item.display));
  });

  it("keeps a valid late selected record despite unrelated earlier attachments and does not count them as its omission", () => {
    const selectedModel = model(5);
    const selectedAttachment = selectedModel.attachments[0]!;
    const unrelated = { ...selectedAttachment, subject: "docker_container_container_unrelated" as typeof selectedAttachment.subject };
    const mixed = { ...selectedModel, attachments: [...Array.from({ length: 100 }, () => unrelated), selectedAttachment] };
    const context = localAttachmentContext(mixed, selectedAttachment.subject)!;
    expect(context.items).toHaveLength(1);
    expect(context.inputOmitted).toBe(0);
  });

  it("uses all structural evidence fields to order duplicate port variants and rejects forged bindings", () => {
    const ports = model(2, "port");
    const seed = ports.attachments[0]!;
    const evidence = seed.evidence[0]!;
    const laterEvidence = { ...evidence, evidence: { ...evidence.evidence, id: "z-variant", summary: "raw-secret-should-not-render", collectedAt: 2 } };
    const earlierEvidence = { ...evidence, evidence: { ...evidence.evidence, id: "a-variant", summary: "raw-secret-should-not-render", collectedAt: 1 } };
    const duplicateVariants = { ...ports, attachments: [{ ...seed, evidence: [laterEvidence] as unknown as typeof seed.evidence }, { ...seed, evidence: [earlierEvidence] as unknown as typeof seed.evidence }] };
    expect(localAttachmentContext({ ...duplicateVariants, attachments: [...duplicateVariants.attachments].reverse() }, seed.subject)).toEqual(localAttachmentContext(duplicateVariants, seed.subject));
    expect(JSON.stringify(localAttachmentContext(duplicateVariants, seed.subject))).not.toContain("raw-secret-should-not-render");

    const withEvidence = (next: typeof evidence) => ({ ...seed, evidence: [next] as unknown as typeof seed.evidence });
    const forgedEndpoint = withEvidence({ ...evidence, target: "docker_network_forged" as typeof evidence.target });
    const forgedRelationship = withEvidence({ ...evidence, relationship: "connected_to" as typeof evidence.relationship });
    const forgedKind = withEvidence({ ...evidence, evidence: { ...evidence.evidence, kind: "docker_network_membership" as typeof evidence.evidence.kind } });
    const forgedSubject = withEvidence({ ...evidence, evidence: { ...evidence.evidence, subjectRef: "docker_container_forged" as typeof evidence.evidence.subjectRef } });
    const forgedVersion = withEvidence({ ...evidence, evidence: { ...evidence.evidence, version: 2 } });
    const forgedAssertion = withEvidence({ ...evidence, evidence: { ...evidence.evidence, assertionKind: "declared" as typeof evidence.evidence.assertionKind } });
    const forgedSlot = withEvidence({ ...evidence, evidence: { ...evidence.evidence, providerSlot: "systemd" as typeof evidence.evidence.providerSlot } });
    const forgedFreshness = withEvidence({ ...evidence, evidence: { ...evidence.evidence, freshness: "stale" as typeof evidence.evidence.freshness } });
    for (const forged of [forgedEndpoint, forgedRelationship, forgedKind, forgedSubject, forgedVersion, forgedAssertion, forgedSlot, forgedFreshness]) {
      const context = localAttachmentContext({ ...ports, attachments: [forged] }, seed.subject)!;
      expect(context.items).toHaveLength(0);
      expect(context.population.unresolved).toBe(1);
    }
  });
});
