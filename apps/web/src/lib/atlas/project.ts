import type { RuntimeEvidenceRef, RuntimeMapEdge, RuntimeMapNode, RuntimeNodeKind, RuntimeRelationshipKind } from "@dockermap/contracts";
import {
  ATLAS_CAPS,
  ATLAS_PROJECTION_VERSION,
  type AtlasAggregate,
  type AtlasAttachment,
  type AtlasDerivedKey,
  type AtlasDiagnostic,
  type AtlasEdgeEvidenceSourceRef,
  type AtlasEnvelope,
  type AtlasEvidenceSources,
  type AtlasFreshness,
  type AtlasKey,
  type AtlasLane,
  type AtlasModel,
  type AtlasOperationalState,
  type AtlasProjectionOptions,
  type AtlasPublishedEvidenceRef,
  type AtlasRelation,
  type AtlasRole,
  type AtlasRuntimeMapInput,
  type AtlasSubject,
  type ProjectionRuleId
} from "./types";

const SUBJECT_RULE = "atlas-v1/runtime-subject" as const satisfies ProjectionRuleId;
const DIAGNOSTIC_RULE = "atlas-v1/non-routable-diagnostic" as const satisfies ProjectionRuleId;
const LANE_RULE = "atlas-v1/presentation-lane" as const satisfies ProjectionRuleId;
const RELATION_RULE = "atlas-v1/evidenced-declaration" as const satisfies ProjectionRuleId;
const ATTACHMENT_RULE = "atlas-v1/evidenced-context" as const satisfies ProjectionRuleId;
const AGGREGATE_RULE = "atlas-v1/high-degree-aggregate" as const satisfies ProjectionRuleId;

const RUNTIME_KINDS = [
  "container", "docker_network", "docker_volume", "host", "host_risk", "service", "systemd_service",
  "scheduled_job", "pm2_app", "tmux_session", "tailnet_node", "reverse_proxy", "local_dns_resolver",
  "dns_provider", "node_application", "python_application", "ai_agent", "package", "storage", "external_api",
  "package_dependency", "database", "worker", "process", "network_listener", "orchestrator_workload"
] as const satisfies readonly RuntimeNodeKind[];

const EVIDENCE_KINDS = [
  "docker_network_membership", "docker_volume_mount", "docker_port_publication", "docker_compose_depends_on",
  "docker_daemon_state_bind_mount", "systemd_requires", "systemd_wants", "systemd_part_of",
  "npm_package_manifest_dependency", "cron_schedule_declaration"
] as const;
const EVIDENCE_PROVIDERS = ["docker", "systemd", "npm", "cron"] as const;
const EVIDENCE_FRESHNESS = ["fresh", "stale", "timed_out"] as const;
const ASSERTION_KINDS = ["observed", "declared"] as const;
const PROVIDER_SLOTS = ["network_infrastructure", "host_scoped", "cron", "systemd", "python_processes", "native_processes", "project_npm", "tmux"] as const;
// Kept below the per-subject attachment cap so aggregate coverage has an
// executable fixture path while the rendered expansion budget remains eight.
const HIGH_DEGREE_THRESHOLD = 6;

type EdgePurpose = "relation" | "attachment" | null;

function includes<T extends readonly string[]>(items: T, value: unknown): value is T[number] {
  return typeof value === "string" && (items as readonly string[]).includes(value);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function safeKey(value: unknown): AtlasKey | null {
  if (typeof value !== "string") return null;
  // Reject before trim: an unbounded whitespace prefix must not turn into
  // potentially expensive routing work or a fallback identity.
  if (value.length === 0 || value.length > ATLAS_CAPS.rawRoutingIdLength) return null;
  const trimmed = value.trim();
  // Published IDs must already be opaque, bounded routing identities. Do not
  // turn an arbitrary label/path into a key merely because it is non-empty.
  if (!/^[A-Za-z0-9:_-]{1,180}$/.test(trimmed)) return null;
  return trimmed as AtlasKey;
}

function derivedKey(kind: string, ordinal: number): AtlasDerivedKey {
  return `atlas:${kind}:${ordinal}` as AtlasDerivedKey;
}

function boundedDisplay(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  // Bound hostile input before normalization and before it can participate in
  // canonical sorting. Four UTF-16 units per display character preserves
  // ordinary surrogate-pair labels while keeping this work fixed.
  const raw = value.slice(0, ATLAS_CAPS.displayLength * 4);
  const normalized = raw.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!normalized) return fallback;
  const characters = Array.from(normalized);
  return characters.length <= ATLAS_CAPS.displayLength
    ? normalized
    : `${characters.slice(0, ATLAS_CAPS.displayLength - 1).join("")}…`;
}

function stateForRuntimeStatus(status: unknown): AtlasOperationalState {
  if (typeof status !== "string") return "unknown";
  // Status is presentation metadata, never a reason to scan arbitrary
  // provider output. Parse a fixed leading window only.
  const first = status.slice(0, ATLAS_CAPS.statusWindow).trim().toLowerCase().split(/[\s(]/)[0];
  switch (first) {
    case "running": case "up": case "healthy": return "healthy";
    case "paused": return "warning";
    case "unhealthy": case "degraded": case "failed": return "degraded";
    case "stopped": case "exited": case "dead": case "down": return "offline";
    case "starting": case "stopping": case "restarting": case "created": case "updating": return "updating";
    default: return "unknown";
  }
}

function roleForKind(kind: RuntimeNodeKind): AtlasRole {
  switch (kind) {
    case "container": case "systemd_service": case "pm2_app": case "node_application":
    case "python_application": case "database": case "worker":
      return "primary";
    case "host": case "tailnet_node": case "reverse_proxy": case "local_dns_resolver":
    case "dns_provider": case "external_api": case "orchestrator_workload":
      return "context";
    case "docker_network": case "docker_volume": case "storage": case "network_listener":
      return "attachment";
    case "scheduled_job": case "tmux_session": case "process": case "package":
    case "package_dependency": case "ai_agent": case "host_risk": case "service":
      return "inspector_only";
    default:
      return "inspector_only";
  }
}

function isRuntimeKind(value: unknown): value is RuntimeNodeKind {
  return includes(RUNTIME_KINDS, value);
}

function isBoundedEvidenceText(value: unknown): value is string {
  // Evidence strings are generated, redacted closed-contract values. They
  // may contain normal prose in `summary`, so do not impose routing syntax.
  // The UTF-16 precheck prevents an attacker from forcing a code-point array
  // allocation for an enormous malformed value. A Unicode scalar needs at
  // most two UTF-16 units, so 518 is a safe hard upper bound for 259 chars.
  return typeof value === "string" && value.length > 0 && value.length <= 259 * 2 && Array.from(value).length <= 259;
}

function evidenceRef(value: unknown): AtlasPublishedEvidenceRef | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    !isBoundedEvidenceText(record.id) || !includes(EVIDENCE_PROVIDERS, record.provider) ||
    !includes(EVIDENCE_KINDS, record.kind) || !includes(ASSERTION_KINDS, record.assertionKind) ||
    !includes(EVIDENCE_FRESHNESS, record.freshness) || !isBoundedEvidenceText(record.providerRevision) ||
    !isBoundedEvidenceText(record.subjectRef) || !isBoundedEvidenceText(record.summary) ||
    typeof record.collectedAt !== "number" || !Number.isSafeInteger(record.collectedAt) || record.collectedAt < 0 ||
    typeof record.version !== "number" || !Number.isSafeInteger(record.version) || record.version < 1 ||
    (record.providerSlot !== undefined && record.providerSlot !== null && !includes(PROVIDER_SLOTS, record.providerSlot))
  ) return null;
  const parsed: RuntimeEvidenceRef = {
    id: record.id,
    provider: record.provider,
    kind: record.kind,
    assertionKind: record.assertionKind,
    freshness: record.freshness,
    providerRevision: record.providerRevision,
    subjectRef: record.subjectRef,
    summary: record.summary,
    collectedAt: record.collectedAt,
    version: record.version
  };
  if (record.providerSlot === null || includes(PROVIDER_SLOTS, record.providerSlot)) parsed.providerSlot = record.providerSlot;
  return parsed;
}

function canonicalEvidenceKey(evidence: AtlasPublishedEvidenceRef): string {
  // JSON array encoding avoids delimiter ambiguity in the curated summary.
  return JSON.stringify([
    evidence.provider, evidence.kind, evidence.assertionKind, evidence.freshness, evidence.id,
    evidence.providerRevision, evidence.providerSlot ?? "", evidence.subjectRef, evidence.summary,
    String(evidence.collectedAt), String(evidence.version)
  ]);
}

function edgeEvidenceKey(edge: RuntimeMapEdge): string {
  // The canonical edge comparator runs before structural validation. Reject
  // malformed arrays by shape here so sorting never walks or allocates from a
  // hostile evidence collection that structuralEvidence will reject anyway.
  if (
    !Array.isArray(edge.evidenceRefs) || edge.evidenceRefs.length === 0 ||
    edge.evidenceRefs.length > ATLAS_CAPS.edgeEvidence
  ) return "invalid";
  return edge.evidenceRefs.map(evidenceRef).filter((value): value is AtlasPublishedEvidenceRef => value !== null)
    .map(canonicalEvidenceKey).sort(compareText).join("\u0002");
}

function canonicalDockerBinding(edge: RuntimeMapEdge, source: AtlasKey, target: AtlasKey, evidence: AtlasPublishedEvidenceRef): boolean {
  if (
    evidence.version !== 1 || evidence.provider !== "docker" || evidence.assertionKind !== "observed" ||
    evidence.freshness !== "fresh" || (evidence.providerSlot !== null && evidence.providerSlot !== undefined) || evidence.subjectRef !== source
  ) return false;
  switch (evidence.kind) {
    case "docker_compose_depends_on":
      return edge.relationship === "depends_on" && source.startsWith("docker_container_") && target.startsWith("docker_container_");
    case "docker_network_membership":
      return edge.relationship === "connected_to" && source.startsWith("docker_container_") && target.startsWith("docker_network_");
    case "docker_volume_mount":
      return edge.relationship === "mounts" && source.startsWith("docker_container_") && target.startsWith("docker_volume_");
    case "docker_port_publication":
      return edge.relationship === "exposes" && source.startsWith("docker_container_") && target.startsWith("network_listener_");
    case "docker_daemon_state_bind_mount":
      return edge.relationship === "exposes_daemon_state" && source.startsWith("docker_container_") && target === "host_risk_docker_daemon_state";
    default:
      return false;
  }
}

function canonicalSystemdBinding(edge: RuntimeMapEdge, source: AtlasKey, target: AtlasKey, evidence: AtlasPublishedEvidenceRef): boolean {
  if (
    evidence.version !== 2 || evidence.provider !== "systemd" || evidence.assertionKind !== "declared" ||
    evidence.providerSlot !== "systemd" || evidence.subjectRef !== source ||
    !["fresh", "stale", "timed_out"].includes(evidence.freshness) ||
    !source.startsWith("systemd_service_") || !target.startsWith("systemd_service_") || source === target
  ) return false;
  return (evidence.kind === "systemd_requires" && edge.relationship === "requires") ||
    (evidence.kind === "systemd_wants" && edge.relationship === "wants") ||
    (evidence.kind === "systemd_part_of" && edge.relationship === "part_of");
}

function structuralEvidence(edge: RuntimeMapEdge, source: AtlasKey, target: AtlasKey): AtlasEvidenceSources | null {
  const values = edge.evidenceRefs;
  if (!Array.isArray(values) || values.length === 0 || values.length > ATLAS_CAPS.edgeEvidence) return null;
  const refs: AtlasEdgeEvidenceSourceRef[] = [];
  for (const value of values) {
    const evidence = evidenceRef(value);
    if (!evidence) return null;
    if (evidence.provider === "docker") {
      if (!canonicalDockerBinding(edge, source, target, evidence)) return null;
    } else if (evidence.provider === "systemd") {
      if (!canonicalSystemdBinding(edge, source, target, evidence)) return null;
    } else return null; // NPM/Cron do not have a V1 Atlas projection rule.
    refs.push({ kind: "runtime_edge_evidence", source, target, relationship: edge.relationship, evidence });
  }
  refs.sort((left, right) => compareText(canonicalEvidenceKey(left.evidence), canonicalEvidenceKey(right.evidence)));
  return refs as unknown as AtlasEvidenceSources;
}

function edgePurpose(evidence: AtlasEvidenceSources, relationship: RuntimeRelationshipKind): EdgePurpose {
  const kinds = new Set(evidence.map((entry) => entry.evidence.kind));
  if (
    (kinds.has("docker_compose_depends_on") && relationship === "depends_on") ||
    (kinds.has("systemd_requires") && relationship === "requires") ||
    (kinds.has("systemd_wants") && relationship === "wants") ||
    (kinds.has("systemd_part_of") && relationship === "part_of")
  ) return "relation";
  if (
    kinds.has("docker_network_membership") || kinds.has("docker_volume_mount") ||
    kinds.has("docker_port_publication") || kinds.has("docker_daemon_state_bind_mount")
  ) return "attachment";
  return null;
}

function freshnessForEvidence(evidence: AtlasEvidenceSources): AtlasFreshness {
  if (evidence.some((entry) => entry.evidence.freshness === "timed_out")) return "timed_out";
  if (evidence.some((entry) => entry.evidence.freshness === "stale")) return "stale";
  return "fresh";
}

function providerFreshnessBySlot(input: AtlasRuntimeMapInput): ReadonlyMap<string, AtlasFreshness> {
  const values: unknown = input.providerStates;
  // RuntimeMap publishes one state for each closed provider-slot table. Read
  // only the array length before rejecting malformed oversized input, then
  // scan the bounded table once rather than calling .find for every node.
  if (!Array.isArray(values) || values.length > PROVIDER_SLOTS.length) return new Map();
  const freshness = new Map<string, AtlasFreshness>();
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    if (!includes(PROVIDER_SLOTS, record.slot) || freshness.has(record.slot)) continue;
    switch (record.state) {
      case "fresh": freshness.set(record.slot, "fresh"); break;
      case "stale": freshness.set(record.slot, "stale"); break;
      case "timed_out": freshness.set(record.slot, "timed_out"); break;
      case "unavailable": freshness.set(record.slot, "unavailable"); break;
      case "disabled": freshness.set(record.slot, "disabled"); break;
      default: freshness.set(record.slot, "unknown"); break;
    }
  }
  return freshness;
}

function freshnessForNode(node: RuntimeMapNode, providerFreshness: ReadonlyMap<string, AtlasFreshness>): AtlasFreshness {
  const slot = node.provider === "systemd" ? "systemd" : node.provider === "npm" ? "project_npm" :
    node.provider === "scheduled_job" ? "cron" : null;
  if (!slot) return "unknown";
  return providerFreshness.get(slot) ?? "unknown";
}

function attentionBySubject(
  input: AtlasRuntimeMapInput,
  options: AtlasProjectionOptions | undefined
): { attention: ReadonlyMap<AtlasKey, "advisory" | "warning">; omitted: number } {
  if (!options?.findings || options.findings.modelRevision !== input.modelRevision) return { attention: new Map(), omitted: 0 };
  // Findings are an optional coherent overlay, not permission to process an
  // unbounded second collection. Reject it whole to avoid insertion-order
  // partial attention and to preserve a stable model revision.
  if (options.findings.findings.length > ATLAS_CAPS.inputFindings) return { attention: new Map(), omitted: options.findings.findings.length };
  const attention = new Map<AtlasKey, "advisory" | "warning">();
  for (const finding of options.findings.findings) {
    const key = safeKey(finding.subjectRef);
    if (!key) continue;
    const next = finding.severity === "warning" ? "warning" : "advisory";
    if (next === "warning" || !attention.has(key)) attention.set(key, next);
  }
  return { attention, omitted: 0 };
}

function boundedSortText(value: unknown): string {
  return typeof value === "string" ? value.slice(0, ATLAS_CAPS.statusWindow) : "";
}

function canonicalNodeSort(a: RuntimeMapNode, b: RuntimeMapNode): number {
  return compareText(boundedSortText(a.id), boundedSortText(b.id)) || compareText(String(a.provider), String(b.provider)) ||
    compareText(String(a.type), String(b.type)) || compareText(boundedDisplay(a.label, "Runtime subject"), boundedDisplay(b.label, "Runtime subject")) ||
    compareText(boundedSortText(a.status), boundedSortText(b.status));
}

function diagnostic(kind: AtlasDiagnostic["kind"]): AtlasDiagnostic {
  return { kind, source: { kind: "projection", rule: DIAGNOSTIC_RULE }, rule: DIAGNOSTIC_RULE };
}

function sorted<T>(values: readonly T[], compare: (a: T, b: T) => number): T[] {
  return [...values].sort(compare);
}

/**
 * Project a single coherent runtime-map publication. Metadata is ignored;
 * only complete structural `evidenceRefs` may prove a semantic link.
 */
export function projectRuntimeMap(input: AtlasRuntimeMapInput, options?: AtlasProjectionOptions): AtlasEnvelope {
  const diagnostics: AtlasDiagnostic[] = [];
  const addDiagnostic = (kind: AtlasDiagnostic["kind"]): void => {
    if (diagnostics.length < ATLAS_CAPS.diagnostics) diagnostics.push(diagnostic(kind));
  };

  // Read collection lengths only before deciding whether the untrusted input
  // is within the fixed work budget. An over-cap collection is omitted as a
  // whole rather than partially accepting insertion-order-dependent records.
  const rejectedNodes = input.nodes.length > ATLAS_CAPS.inputNodes;
  const rejectedEdges = input.edges.length > ATLAS_CAPS.inputEdges;
  const nodes = rejectedNodes ? [] : sorted(input.nodes, canonicalNodeSort);
  const freshnessBySlot = providerFreshnessBySlot(input);
  if (rejectedNodes) addDiagnostic("bounded_omission");
  const findingOverlay = attentionBySubject(input, options);
  if (findingOverlay.omitted > 0) addDiagnostic("bounded_omission");
  const validNodes = new Map<AtlasKey, RuntimeMapNode[]>();
  for (const node of nodes) {
    const key = safeKey(node.id);
    if (!key) {
      addDiagnostic("unresolved");
      continue;
    }
    const records = validNodes.get(key) ?? [];
    records.push(node);
    validNodes.set(key, records);
  }

  const subjects: AtlasSubject[] = [];
  const routable = new Map<AtlasKey, AtlasSubject & { routability: "routable" }>();
  let nonRoutableOrdinal = 0;
  for (const [key, records] of sorted([...validNodes], ([left], [right]) => compareText(left, right))) {
    if (records.length !== 1) {
      // Never pick a duplicate's first/last occurrence. The derived key has
      // no raw collided id, so it cannot accidentally become a route target.
      for (const _ of records) {
        subjects.push({
          key: derivedKey("collision", nonRoutableOrdinal++), routability: "non_routable",
          source: { kind: "projection", rule: DIAGNOSTIC_RULE }, runtimeKind: null,
          role: "unsupported", display: "Ambiguous runtime identity", operationalState: "unknown",
          freshness: "unknown", attention: "none", ambiguity: "collision", rule: DIAGNOSTIC_RULE
        });
      }
      addDiagnostic("collision");
      continue;
    }
    const node = records[0];
    if (!isRuntimeKind(node.type)) {
      subjects.push({
        key: derivedKey("unsupported", nonRoutableOrdinal++), routability: "non_routable",
        source: { kind: "projection", rule: DIAGNOSTIC_RULE }, runtimeKind: null,
        role: "unsupported", display: "Unsupported runtime subject", operationalState: "unknown",
        freshness: "unknown", attention: "none", ambiguity: "unsupported", rule: DIAGNOSTIC_RULE
      });
      addDiagnostic("unsupported");
      continue;
    }
    const subject: AtlasSubject & { routability: "routable" } = {
      key, routability: "routable", source: { kind: "runtime_node", provider: node.provider, nodeId: key, runtimeKind: node.type },
      runtimeKind: node.type, role: roleForKind(node.type), display: boundedDisplay(node.label, "Runtime subject"),
      operationalState: stateForRuntimeStatus(node.status ?? node.service?.status),
      freshness: freshnessForNode(node, freshnessBySlot), attention: findingOverlay.attention.get(key) ?? "none", ambiguity: "none", rule: SUBJECT_RULE
    };
    subjects.push(subject);
    routable.set(key, subject);
  }

  let omittedSubjects = 0;
  if (subjects.length > ATLAS_CAPS.subjects) {
    omittedSubjects = subjects.length - ATLAS_CAPS.subjects;
    subjects.length = ATLAS_CAPS.subjects;
    for (const subject of [...routable.values()]) if (!subjects.includes(subject)) routable.delete(subject.key);
    addDiagnostic("bounded_omission");
  }

  const laneSubjects = new Map<string, AtlasKey[]>();
  for (const subject of subjects) {
    if (subject.routability !== "routable") continue;
    const lane = `lane:${subject.source.provider}:${subject.role}`;
    const keys = laneSubjects.get(lane) ?? [];
    keys.push(subject.key);
    laneSubjects.set(lane, keys);
  }
  const lanes: AtlasLane[] = sorted([...laneSubjects], ([left], [right]) => compareText(left, right)).map(([lane, keys], ordinal) => ({
    key: derivedKey("lane", ordinal), subjectKeys: sorted(keys, compareText), presentationOnly: true, rule: LANE_RULE
  }));

  const relations: AtlasRelation[] = [];
  const attachments: AtlasAttachment[] = [];
  const attachmentCounts = new Map<AtlasKey, number>();
  const attachmentPopulation = new Map<AtlasKey, number>();
  const attachmentOmissions = new Map<AtlasKey, number>();
  const edgeInputs = rejectedEdges ? [] : sorted(input.edges, (left, right) =>
    compareText(String(left.source), String(right.source)) || compareText(String(left.target), String(right.target)) ||
    compareText(String(left.relationship), String(right.relationship)) || compareText(edgeEvidenceKey(left), edgeEvidenceKey(right))
  );
  let omittedEdges = rejectedEdges ? input.edges.length : 0;
  if (rejectedEdges) addDiagnostic("bounded_omission");
  for (const edge of edgeInputs) {
    const source = safeKey(edge.source);
    const target = safeKey(edge.target);
    if (!source || !target || !routable.has(source) || !routable.has(target)) {
      addDiagnostic("unresolved");
      continue;
    }
    const evidence = structuralEvidence(edge, source, target);
    if (!evidence) continue;
    const purpose = edgePurpose(evidence, edge.relationship);
    if (!purpose) {
      addDiagnostic("unsupported");
      continue;
    }
    if (purpose === "relation") {
      if (relations.length >= ATLAS_CAPS.relations) { omittedEdges += 1; continue; }
      relations.push({ source, target, direction: "forward", evidence, rule: RELATION_RULE });
      continue;
    }
    attachmentPopulation.set(source, (attachmentPopulation.get(source) ?? 0) + 1);
    const next = attachmentCounts.get(source) ?? 0;
    if (next >= ATLAS_CAPS.attachmentsPerSubject) {
      attachmentOmissions.set(source, (attachmentOmissions.get(source) ?? 0) + 1);
      omittedEdges += 1;
      continue;
    }
    attachmentCounts.set(source, next + 1);
    attachments.push({ subject: source, context: target, evidence, rule: ATTACHMENT_RULE });
  }
  if (omittedEdges > 0) addDiagnostic("bounded_omission");

  const aggregates: AtlasAggregate[] = [];
  for (const [subject, total] of sorted([...attachmentPopulation], ([left], [right]) => compareText(left, right))) {
    if (total <= HIGH_DEGREE_THRESHOLD) continue;
    const sourceCoverage = attachments.filter((attachment) => attachment.subject === subject).flatMap((attachment) => attachment.evidence)
      .slice(0, ATLAS_CAPS.edgeEvidence) as unknown as AtlasEvidenceSources;
    if (!sourceCoverage.length) continue;
    aggregates.push({
      key: derivedKey("attachment-aggregate", aggregates.length),
      population: { resolved: total, unresolved: 0, ambiguous: 0, omitted: attachmentOmissions.get(subject) ?? 0 }, sourceCoverage, rule: AGGREGATE_RULE
    });
  }

  const model: AtlasModel = {
    projectionVersion: ATLAS_PROJECTION_VERSION,
    subjects: sorted(subjects, (left, right) => compareText(left.key, right.key)),
    groups: [],
    lanes,
    relations: sorted(relations, (left, right) => compareText(left.source, right.source) || compareText(left.target, right.target)),
    memberships: [],
    attachments: sorted(attachments, (left, right) => compareText(left.subject, right.subject) || compareText(left.context, right.context)),
    aggregates,
    diagnostics: sorted(diagnostics, (left, right) => compareText(left.kind, right.kind)),
    stats: {
      subjects: subjects.length, relations: relations.length, attachments: attachments.length,
      unsupported: diagnostics.filter((entry) => entry.kind === "unsupported").length,
      boundedOmissions: (rejectedNodes ? input.nodes.length : 0) + omittedSubjects + omittedEdges + findingOverlay.omitted
    }
  };
  return { sourceRevision: input.modelRevision, model };
}

export function semanticJson(model: AtlasModel): string {
  return JSON.stringify(model);
}

/** Shared authority for canvas order, keyboard traversal and text directory. */
export function canonicalSubjectOrder(model: AtlasModel): readonly AtlasSubject[] {
  return sorted(model.subjects, (left, right) => compareText(left.key, right.key));
}

export interface AtlasSemanticEntry {
  kind: "subject" | "aggregate";
  key: string;
  display: string;
  selectionKey: AtlasKey | null;
}

/**
 * Renderer-independent semantic alternative. It is generated from AtlasModel,
 * including collapsed aggregate coverage, rather than independently deriving
 * a list from raw API records.
 */
export function semanticAlternative(model: AtlasModel): readonly AtlasSemanticEntry[] {
  return [
    ...canonicalSubjectOrder(model).map((subject) => ({
      kind: "subject" as const,
      key: subject.key,
      display: subject.display,
      selectionKey: subject.routability === "routable" ? subject.key : null
    })),
    ...model.aggregates.map((aggregate) => ({
      kind: "aggregate" as const,
      key: aggregate.key,
      display: `${aggregate.population.resolved} resolved · ${aggregate.population.unresolved} unresolved`,
      selectionKey: null
    }))
  ];
}

/** A selection may only name the same safe, routable semantic subject. */
export function selectedSubject(model: AtlasModel, key: string | null): Extract<AtlasSubject, { routability: "routable" }> | null {
  if (!key) return null;
  const subject = model.subjects.find((entry): entry is Extract<AtlasSubject, { routability: "routable" }> =>
    entry.routability === "routable" && entry.key === key
  );
  return subject ?? null;
}

/** Exposed for deterministic fixture assertions; never used to route UI state. */
export function evidenceFreshness(evidence: AtlasEvidenceSources): AtlasFreshness {
  return freshnessForEvidence(evidence);
}
