import type {
  RuntimeEvidenceRef,
  FindingsResponse,
  RuntimeMap,
  RuntimeNodeKind,
  RuntimeProviderKind,
  RuntimeRelationshipKind
} from "@dockermap/contracts";

/**
 * Pure, serialisable V1 Atlas vocabulary.  This module deliberately does not
 * import the legacy service-map model: RuntimeMap is the only topology input.
 */
export const ATLAS_PROJECTION_VERSION = 1 as const;
export const ATLAS_RULE_PREFIX = "atlas-v1/" as const;

export const ATLAS_CAPS = {
  /** Reject whole oversized collections before sort/allocation work. */
  inputNodes: 250,
  inputEdges: 400,
  inputFindings: 250,
  subjects: 250,
  relations: 400,
  attachmentsPerSubject: 8,
  edgeEvidence: 8,
  displayLength: 96,
  rawRoutingIdLength: 360,
  statusWindow: 256,
  diagnostics: 250
} as const;

export type AtlasKey = string & { readonly __atlasKey: unique symbol };
export type AtlasDerivedKey = string & { readonly __atlasDerivedKey: unique symbol };
export type ProjectionRuleId = `${typeof ATLAS_RULE_PREFIX}${string}`;

export type AtlasRole = "primary" | "context" | "attachment" | "inspector_only" | "unsupported";
export type AtlasRoutability = "routable" | "non_routable";
export type AtlasOperationalState = "healthy" | "warning" | "degraded" | "offline" | "updating" | "unknown";
export type AtlasFreshness = "fresh" | "stale" | "timed_out" | "unavailable" | "disabled" | "unknown";
export type AtlasAttention = "none" | "advisory" | "warning";
export type AtlasAmbiguity = "none" | "collision" | "unresolved" | "unsupported";
export type AtlasDiagnosticKind = "collision" | "unresolved" | "unsupported" | "disagreement" | "bounded_omission";
export type AtlasLens = "overview" | "connectivity" | "dependencies" | "storage" | "runtime" | "attention";

export interface AtlasNodeSourceRef {
  kind: "runtime_node";
  provider: RuntimeProviderKind;
  nodeId: AtlasKey;
  runtimeKind: RuntimeNodeKind;
}

/**
 * Exact generated, closed daemon evidence shape. Its id is descriptive only
 * and is never used as an Atlas routing key.
 */
export type AtlasPublishedEvidenceRef = RuntimeEvidenceRef;

export interface AtlasEdgeEvidenceSourceRef {
  kind: "runtime_edge_evidence";
  source: AtlasKey;
  target: AtlasKey;
  relationship: RuntimeRelationshipKind;
  evidence: AtlasPublishedEvidenceRef;
}

export type AtlasEvidenceSources = readonly [AtlasEdgeEvidenceSourceRef, ...AtlasEdgeEvidenceSourceRef[]];

export interface AtlasProjectionRef {
  kind: "projection";
  rule: ProjectionRuleId;
}

export interface AtlasSubjectBase {
  role: AtlasRole;
  display: string;
  operationalState: AtlasOperationalState;
  freshness: AtlasFreshness;
  attention: AtlasAttention;
  ambiguity: AtlasAmbiguity;
  rule: ProjectionRuleId;
}

export type AtlasSubject =
  | (AtlasSubjectBase & {
      key: AtlasKey;
      routability: "routable";
      source: AtlasNodeSourceRef;
      runtimeKind: RuntimeNodeKind;
    })
  | (AtlasSubjectBase & {
      key: AtlasDerivedKey;
      routability: "non_routable";
      source: AtlasProjectionRef;
      runtimeKind: RuntimeNodeKind | null;
    });

export interface AtlasGroup {
  key: AtlasDerivedKey;
  memberKeys: readonly AtlasKey[];
  membershipEvidence: AtlasEvidenceSources;
  rule: ProjectionRuleId;
}

/** Presentation scaffolding only: a lane never communicates containment. */
export interface AtlasLane {
  key: AtlasDerivedKey;
  subjectKeys: readonly AtlasKey[];
  presentationOnly: true;
  rule: ProjectionRuleId;
}

export interface AtlasRelation {
  source: AtlasKey;
  target: AtlasKey;
  direction: "forward";
  evidence: AtlasEvidenceSources;
  rule: ProjectionRuleId;
}

export interface AtlasMembership {
  subject: AtlasKey;
  context: AtlasKey;
  evidence: AtlasEvidenceSources;
  rule: ProjectionRuleId;
}

export interface AtlasAttachment {
  subject: AtlasKey;
  context: AtlasKey;
  evidence: AtlasEvidenceSources;
  rule: ProjectionRuleId;
}

export interface AtlasAggregate {
  key: AtlasDerivedKey;
  population: { resolved: number; unresolved: number; ambiguous: number; omitted: number };
  sourceCoverage: AtlasEvidenceSources;
  rule: ProjectionRuleId;
}

export interface AtlasDiagnostic {
  kind: AtlasDiagnosticKind;
  source: AtlasProjectionRef;
  rule: ProjectionRuleId;
}

export interface AtlasStats {
  subjects: number;
  relations: number;
  attachments: number;
  unsupported: number;
  boundedOmissions: number;
}

export interface AtlasModel {
  projectionVersion: typeof ATLAS_PROJECTION_VERSION;
  subjects: readonly AtlasSubject[];
  /** V1 has no trustworthy published grouping fact. This is intentionally [] . */
  groups: readonly AtlasGroup[];
  lanes: readonly AtlasLane[];
  relations: readonly AtlasRelation[];
  memberships: readonly AtlasMembership[];
  attachments: readonly AtlasAttachment[];
  aggregates: readonly AtlasAggregate[];
  diagnostics: readonly AtlasDiagnostic[];
  stats: AtlasStats;
}

/** Revision/provenance belongs outside deterministic semantic/layout payloads. */
export interface AtlasEnvelope {
  sourceRevision: string;
  model: AtlasModel;
}

/**
 * V1 consumes only the coherent generated RuntimeMap shape. Runtime edges
 * already carry bounded `evidenceRefs`; no side table or second response is
 * permitted.
 */
export type AtlasRuntimeMapInput = RuntimeMap;

/** Optional coherent overlay: accepted only when it attests the same revision. */
export interface AtlasProjectionOptions {
  findings?: FindingsResponse;
}

export interface AtlasPoint {
  subject: AtlasKey | AtlasDerivedKey;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AtlasLayout {
  policyVersion: "atlas-v1/local-lanes";
  points: readonly AtlasPoint[];
}

export interface AtlasCamera {
  x: number;
  y: number;
  zoom: number;
}
