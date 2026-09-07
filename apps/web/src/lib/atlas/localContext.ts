import type { AtlasAggregate, AtlasAttachment, AtlasEvidenceSources, AtlasKey, AtlasModel, AtlasSubject } from "./types";

/**
 * Frozen selected-local attachment policy. It is intentionally a rail/list,
 * not a graph-routing heuristic: topology anchors never move for an attachment
 * expansion and all omitted records are stated rather than silently dropped.
 */
export const ATLAS_LOCAL_CONTEXT_POLICY = {
  version: "atlas-v1/local-attachment-rail-1",
  maxModelAttachmentsScanned: 400,
  maxSelectedAttachments: 80,
  maxInputAttachments: 80,
  maxVisibleItems: 6,
  maxItemsPerKind: 4,
  maxAggregateCoverage: 8
} as const;

export type LocalAttachmentKind = "network_membership" | "storage_attachment" | "port_publication" | "daemon_state_context";

export interface AtlasLocalAttachmentItem {
  key: `atlas:local-attachment:${number}`;
  kind: LocalAttachmentKind;
  /** Bounded subject data only; never a raw endpoint, port string, or evidence id. */
  display: string;
  operationalState: AtlasSubject["operationalState"];
  freshness: AtlasSubject["freshness"];
  attention: AtlasSubject["attention"];
  ambiguity: AtlasSubject["ambiguity"];
}

export interface AtlasLocalAttachmentContext {
  policyVersion: typeof ATLAS_LOCAL_CONTEXT_POLICY.version;
  items: readonly AtlasLocalAttachmentItem[];
  population: { resolved: number; unresolved: number; ambiguous: number; omitted: number };
  /** Omitted by this presentational rail, separate from projection omissions. */
  presentationOmitted: number;
  /** Selected records omitted by the named per-selected input cap. */
  inputOmitted: number;
  projectionOmitted: number;
}

function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

function bounded(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 256) : value === null || value === undefined ? "" : String(value).slice(0, 64);
}

function canonicalEvidenceKey(evidence: AtlasEvidenceSources): string {
  return evidence.map((entry) => JSON.stringify([
    bounded(entry.evidence.provider), bounded(entry.evidence.kind), bounded(entry.evidence.assertionKind), bounded(entry.evidence.freshness),
    bounded(entry.evidence.id), bounded(entry.evidence.providerRevision), bounded(entry.evidence.providerSlot), bounded(entry.evidence.subjectRef),
    bounded(entry.evidence.summary), bounded(entry.evidence.collectedAt), bounded(entry.evidence.version), bounded(entry.relationship)
  ])).sort(compareText).join("\u0003");
}

function canonicalDockerAttachment(entry: AtlasEvidenceSources[number], attachment: AtlasAttachment): LocalAttachmentKind | null {
  const evidence = entry.evidence;
  if (
    entry.kind !== "runtime_edge_evidence" || entry.source !== attachment.subject || entry.target !== attachment.context ||
    evidence.version !== 1 || evidence.provider !== "docker" || evidence.assertionKind !== "observed" || evidence.freshness !== "fresh" ||
    (evidence.providerSlot !== null && evidence.providerSlot !== undefined) || evidence.subjectRef !== attachment.subject ||
    !attachment.subject.startsWith("docker_container_")
  ) return null;
  switch (evidence.kind) {
    case "docker_network_membership": return entry.relationship === "connected_to" && attachment.context.startsWith("docker_network_") ? "network_membership" : null;
    case "docker_volume_mount": return entry.relationship === "mounts" && attachment.context.startsWith("docker_volume_") ? "storage_attachment" : null;
    case "docker_port_publication": return entry.relationship === "exposes" && attachment.context.startsWith("network_listener_") ? "port_publication" : null;
    case "docker_daemon_state_bind_mount": return entry.relationship === "exposes_daemon_state" && attachment.context === "host_risk_docker_daemon_state" ? "daemon_state_context" : null;
    default: return null;
  }
}

function kindFor(attachment: AtlasAttachment): LocalAttachmentKind | null {
  const kinds = new Set(attachment.evidence.map((entry) => entry.evidence.kind));
  // Revalidate the closed projection vocabulary at the presentation boundary.
  // A mixed/unknown evidence set is not made legible by guessing a label.
  if (kinds.size !== 1) return null;
  const kind = canonicalDockerAttachment(attachment.evidence[0], attachment);
  return kind && attachment.evidence.every((entry) => canonicalDockerAttachment(entry, attachment) === kind) ? kind : null;
}

function safeDisplay(subject: AtlasSubject): string {
  const bounded = subject.display.slice(0, 384).normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  const characters = Array.from(bounded);
  return characters.length <= 96 ? (bounded || "Runtime subject") : `${characters.slice(0, 95).join("")}…`;
}

function aggregateFor(aggregates: readonly AtlasAggregate[], subject: AtlasKey): AtlasAggregate | undefined {
  return aggregates.slice(0, ATLAS_LOCAL_CONTEXT_POLICY.maxInputAttachments).find((aggregate) =>
    aggregate.sourceCoverage.slice(0, ATLAS_LOCAL_CONTEXT_POLICY.maxAggregateCoverage).some((entry) =>
      entry.source === subject && entry.target !== subject && canonicalDockerAttachment(entry, { subject: entry.source, context: entry.target, evidence: [entry], rule: "atlas-v1/evidenced-context" }) !== null
    )
  );
}

/**
 * Derives one bounded, deterministic non-causal local rail from an AtlasModel.
 * It deliberately accepts no RuntimeMap, Docker record, raw port, metadata or
 * arbitrary endpoint input.
 */
export function localAttachmentContext(model: AtlasModel, selected: AtlasKey | null): AtlasLocalAttachmentContext | null {
  if (!selected) return null;
  const subject = model.subjects.find((entry): entry is Extract<AtlasSubject, { routability: "routable" }> => entry.routability === "routable" && entry.key === selected);
  if (!subject) return null;
  const selectedAttachments: AtlasAttachment[] = [];
  let inputOmitted = 0;
  const scanLimit = Math.min(model.attachments.length, ATLAS_LOCAL_CONTEXT_POLICY.maxModelAttachmentsScanned);
  for (let index = 0; index < scanLimit; index += 1) {
    const attachment = model.attachments[index]!;
    if (attachment.subject !== selected) continue;
    if (selectedAttachments.length < ATLAS_LOCAL_CONTEXT_POLICY.maxSelectedAttachments) selectedAttachments.push(attachment);
    else inputOmitted += 1;
  }
  const candidates = selectedAttachments
    .map((attachment) => ({ attachment, kind: kindFor(attachment), context: model.subjects.find((entry) => entry.key === attachment.context) }))
    .sort((left, right) => compareText(left.kind ?? "", right.kind ?? "") || compareText(left.attachment.context, right.attachment.context) || compareText(canonicalEvidenceKey(left.attachment.evidence), canonicalEvidenceKey(right.attachment.evidence)));

  let unresolved = 0;
  let ambiguous = 0;
  const eligible: Array<{ attachment: AtlasAttachment; kind: LocalAttachmentKind; context: AtlasSubject }> = [];
  for (const candidate of candidates) {
    if (!candidate.kind || !candidate.context) { unresolved += 1; continue; }
    if (candidate.context.routability !== "routable" || candidate.context.ambiguity !== "none") { ambiguous += 1; continue; }
    eligible.push({ attachment: candidate.attachment, kind: candidate.kind, context: candidate.context });
  }
  const countByKind = new Map<LocalAttachmentKind, number>();
  const visible: AtlasLocalAttachmentItem[] = [];
  for (const candidate of eligible) {
    if (visible.length >= ATLAS_LOCAL_CONTEXT_POLICY.maxVisibleItems) continue;
    const count = countByKind.get(candidate.kind) ?? 0;
    if (count >= ATLAS_LOCAL_CONTEXT_POLICY.maxItemsPerKind) continue;
    countByKind.set(candidate.kind, count + 1);
    visible.push({ key: `atlas:local-attachment:${visible.length}`, kind: candidate.kind, display: safeDisplay(candidate.context), operationalState: candidate.context.operationalState, freshness: candidate.context.freshness, attention: candidate.context.attention, ambiguity: candidate.context.ambiguity });
  }
  const aggregate = aggregateFor(model.aggregates, selected);
  const projectionPopulation = aggregate?.population;
  const resolved = projectionPopulation?.resolved ?? eligible.length;
  const projectionOmitted = projectionPopulation?.omitted ?? 0;
  const presentationOmitted = Math.max(0, eligible.length - visible.length);
  return {
    policyVersion: ATLAS_LOCAL_CONTEXT_POLICY.version,
    items: visible,
    population: { resolved, unresolved: (projectionPopulation?.unresolved ?? 0) + unresolved, ambiguous: (projectionPopulation?.ambiguous ?? 0) + ambiguous, omitted: projectionOmitted + presentationOmitted + inputOmitted },
    presentationOmitted,
    projectionOmitted,
    inputOmitted
  };
}
