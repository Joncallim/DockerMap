import type { AtlasAttachment, AtlasEvidenceSources, AtlasKey, AtlasLayout, AtlasModel, AtlasPoint, AtlasRelation } from "./types";

/**
 * Renderer-free, bounded connector planning.  This is deliberately not used by
 * the V1 overview: an overview lens always returns no spatial relations.
 */
export const ATLAS_ROUTING_POLICY = {
  version: "atlas-v1/orthogonal-routing-1",
  evidenceSortVersion: "atlas-v1/evidence-sort-1",
  inputCandidates: 80,
  maxModelRelations: 400,
  maxModelAttachments: 400,
  maxEvidencePerRecord: 8,
  regionWidth: 494,
  regionHeight: 222,
  regionClearance: 18,
  cardWidth: 46,
  cardHeight: 30
} as const;

export type AtlasRoutingLens = "overview" | "connectivity" | "dependencies" | "storage" | "runtime" | "attention";
export type AtlasRouteClass = "declaration" | "network_attachment" | "storage_attachment" | "port_attachment" | "daemon_state_attachment";
export interface AtlasRoutingViewport { x?: number; y?: number; width: number; height: number; }
export interface AtlasRouteSegment { x1: number; y1: number; x2: number; y2: number; }
export interface AtlasPlannedRoute {
  key: string;
  source: AtlasKey;
  target: AtlasKey;
  routeClass: AtlasRouteClass;
  segments: readonly AtlasRouteSegment[];
  bundlePopulation: number;
  selected: boolean;
}
export interface AtlasRoutePopulation { resolved: number; unresolved: number; ambiguous: number; omitted: number; }
export interface AtlasRoutingPlan {
  policyVersion: typeof ATLAS_ROUTING_POLICY.version;
  routes: readonly AtlasPlannedRoute[];
  population: AtlasRoutePopulation;
  metrics: { connectors: number; segments: number; crossings: number; maxRegionConnectors: number; maxRegionSegments: number; maxRegionCrossings: number; viewportConnectors: number; viewportSegments: number; viewportCrossings: number };
}

interface Candidate { source: AtlasKey; target: AtlasKey; routeClass: AtlasRouteClass; evidenceKey: string; selected: boolean; bundlePopulation: number; }
interface Budget { connectors: number; segments: number; crossings: number; }

function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function finite(value: number): number { return Number.isFinite(value) ? value : 0; }
function dataArray<T>(record: object, key: string, cap: number): readonly T[] | null {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !("value" in descriptor) || !Array.isArray(descriptor.value) || descriptor.value.length > cap) return null;
  return descriptor.value as readonly T[];
}
function safePoint(value: unknown): AtlasPoint | null {
  if (!value || typeof value !== "object") return null;
  const point = value as AtlasPoint;
  return typeof point.subject === "string" && [point.x, point.y, point.width, point.height].every(Number.isFinite) && point.width > 0 && point.height > 0 ? point : null;
}
function safeEvidence(value: unknown): value is AtlasEvidenceSources {
  return Array.isArray(value) && value.length > 0 && value.length <= ATLAS_ROUTING_POLICY.maxEvidencePerRecord;
}
function evidenceKey(evidence: AtlasEvidenceSources): string {
  return evidence.map((entry) => JSON.stringify([
    entry.evidence.provider, entry.evidence.kind, entry.evidence.assertionKind, entry.evidence.freshness,
    entry.evidence.id, entry.evidence.providerRevision, entry.evidence.providerSlot ?? "", entry.evidence.subjectRef,
    entry.evidence.summary, String(entry.evidence.collectedAt), String(entry.evidence.version)
  ])).sort(compareText).join("\u0002");
}

function declarationClass(relation: AtlasRelation): AtlasRouteClass | null {
  const evidenceSources = dataArray<AtlasEvidenceSources[number]>(relation, "evidence", ATLAS_ROUTING_POLICY.maxEvidencePerRecord);
  if (relation.rule !== "atlas-v1/evidenced-declaration" || relation.direction !== "forward" || !safeEvidence(evidenceSources)) return null;
  const allowed = (entry: AtlasEvidenceSources[number]): boolean => {
    const evidence = entry.evidence;
    const systemd = evidence.provider === "systemd" && evidence.version === 2 && evidence.assertionKind === "declared" &&
      evidence.providerSlot === "systemd" && evidence.subjectRef === relation.source &&
      ((evidence.kind === "systemd_requires" && entry.relationship === "requires") ||
       (evidence.kind === "systemd_wants" && entry.relationship === "wants") ||
       (evidence.kind === "systemd_part_of" && entry.relationship === "part_of"));
    const docker = evidence.provider === "docker" && evidence.version === 1 && evidence.assertionKind === "observed" &&
      evidence.freshness === "fresh" && (evidence.providerSlot === null || evidence.providerSlot === undefined) &&
      evidence.subjectRef === relation.source && evidence.kind === "docker_compose_depends_on" && entry.relationship === "depends_on";
    return entry.kind === "runtime_edge_evidence" && entry.source === relation.source && entry.target === relation.target && (systemd || docker);
  };
  return evidenceSources.every(allowed) ? "declaration" : null;
}

function attachmentClass(attachment: AtlasAttachment): AtlasRouteClass | null {
  const evidenceSources = dataArray<AtlasEvidenceSources[number]>(attachment, "evidence", ATLAS_ROUTING_POLICY.maxEvidencePerRecord);
  if (attachment.rule !== "atlas-v1/evidenced-context" || !safeEvidence(evidenceSources)) return null;
  const classify = (entry: AtlasEvidenceSources[number]): AtlasRouteClass | null => {
    const evidence = entry.evidence;
    if (entry.kind !== "runtime_edge_evidence" || entry.source !== attachment.subject || entry.target !== attachment.context ||
      evidence.provider !== "docker" || evidence.version !== 1 || evidence.assertionKind !== "observed" || evidence.freshness !== "fresh" ||
      (evidence.providerSlot !== null && evidence.providerSlot !== undefined) || evidence.subjectRef !== attachment.subject) return null;
    if (evidence.kind === "docker_network_membership" && entry.relationship === "connected_to") return "network_attachment";
    if (evidence.kind === "docker_volume_mount" && entry.relationship === "mounts") return "storage_attachment";
    if (evidence.kind === "docker_port_publication" && entry.relationship === "exposes") return "port_attachment";
    if (evidence.kind === "docker_daemon_state_bind_mount" && entry.relationship === "exposes_daemon_state") return "daemon_state_attachment";
    return null;
  };
  const first = classify(evidenceSources[0]!);
  return first && evidenceSources.every((entry) => classify(entry) === first) ? first : null;
}

function lensAccepts(lens: AtlasRoutingLens, routeClass: AtlasRouteClass): boolean {
  if (lens === "overview") return false;
  if (lens === "dependencies") return routeClass === "declaration";
  if (lens === "connectivity") return routeClass === "network_attachment" || routeClass === "port_attachment" || routeClass === "daemon_state_attachment";
  if (lens === "storage") return routeClass === "storage_attachment";
  return true;
}

function caps(subjects: number): Budget {
  return subjects <= 25 ? { connectors: 24, crossings: 4, segments: 72 } : { connectors: 80, crossings: 12, segments: 240 };
}
function regionCaps(subjects: number): Budget {
  return subjects <= 25 ? { connectors: 12, crossings: 2, segments: 36 } : { connectors: 16, crossings: 3, segments: 48 };
}
function regionFor(point: AtlasPoint): string {
  // `x` is the frozen provider×role lane coordinate; no semantics are derived
  // from it. Layout reserves eight full 46+18 column slots plus its 96-unit
  // lane gap (608); the y tile is exactly five fixed 30+18 subject rows.
  return `${Math.floor(finite(point.x) / 608)}:${Math.floor(finite(point.y) / 240)}`;
}
interface Region { key: string; x: number; y: number; width: number; height: number; }
function regionsFor(points: readonly AtlasPoint[]): readonly Region[] {
  const unique = new Map<string, Region>();
  for (const point of points) {
    const key = regionFor(point);
    const [lane, tile] = key.split(":").map(Number);
    unique.set(key, { key, x: lane * 608 - ATLAS_ROUTING_POLICY.regionClearance, y: tile * 240 - ATLAS_ROUTING_POLICY.regionClearance,
      width: ATLAS_ROUTING_POLICY.regionWidth + ATLAS_ROUTING_POLICY.regionClearance * 2, height: ATLAS_ROUTING_POLICY.regionHeight + ATLAS_ROUTING_POLICY.regionClearance * 2 });
  }
  return [...unique.values()].sort((left, right) => compareText(left.key, right.key));
}
function segmentIntersects(segment: AtlasRouteSegment, region: Region): boolean {
  const minX = Math.min(segment.x1, segment.x2), maxX = Math.max(segment.x1, segment.x2), minY = Math.min(segment.y1, segment.y2), maxY = Math.max(segment.y1, segment.y2);
  return maxX >= region.x && minX <= region.x + region.width && maxY >= region.y && minY <= region.y + region.height;
}
function routeRegionUsage(segments: readonly AtlasRouteSegment[], regions: readonly Region[]): Map<string, number> {
  const usage = new Map<string, number>();
  for (const region of regions) {
    const segmentsHere = segments.filter((segment) => segmentIntersects(segment, region)).length;
    if (segmentsHere) usage.set(region.key, segmentsHere);
  }
  return usage;
}
function segmentHitsInterior(segment: AtlasRouteSegment, box: AtlasPoint): boolean {
  // All planner segments are axis-aligned. Strict bounds mean endpoint-card
  // anchors are legal while a third subject's interactive interior is not.
  if (segment.x1 === segment.x2) return segment.x1 > box.x && segment.x1 < box.x + box.width &&
    Math.max(Math.min(segment.y1, segment.y2), box.y) < Math.min(Math.max(segment.y1, segment.y2), box.y + box.height);
  if (segment.y1 === segment.y2) return segment.y1 > box.y && segment.y1 < box.y + box.height &&
    Math.max(Math.min(segment.x1, segment.x2), box.x) < Math.min(Math.max(segment.x1, segment.x2), box.x + box.width);
  return true;
}
function legal(segments: readonly AtlasRouteSegment[], source: AtlasKey, target: AtlasKey, points: ReadonlyMap<string, AtlasPoint>): boolean {
  for (const [key, point] of points) if (key !== source && key !== target && segments.some((segment) => segmentHitsInterior(segment, point))) return false;
  return true;
}
function routeGeometry(source: AtlasPoint, target: AtlasPoint, allPoints: readonly AtlasPoint[], sourceKey: AtlasKey, targetKey: AtlasKey, offset: number): readonly AtlasRouteSegment[] | null {
  const start = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
  const end = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
  const points = new Map(allPoints.map((point) => [point.subject, point]));
  const direct = start.x === end.x || start.y === end.y ? [{ x1: start.x, y1: start.y, x2: end.x, y2: end.y }] : null;
  if (direct && legal(direct, sourceKey, targetKey, points)) return direct;
  const minX = Math.min(...allPoints.map((point) => point.x)) - 18 - offset;
  const maxX = Math.max(...allPoints.map((point) => point.x + point.width)) + 18 + offset;
  const minY = Math.min(...allPoints.map((point) => point.y)) - 18 - offset;
  const maxY = Math.max(...allPoints.map((point) => point.y + point.height)) + 18 + offset;
  const choices: readonly (readonly AtlasRouteSegment[])[] = [
    [{ x1: start.x, y1: start.y, x2: minX, y2: start.y }, { x1: minX, y1: start.y, x2: minX, y2: end.y }, { x1: minX, y1: end.y, x2: end.x, y2: end.y }],
    [{ x1: start.x, y1: start.y, x2: maxX, y2: start.y }, { x1: maxX, y1: start.y, x2: maxX, y2: end.y }, { x1: maxX, y1: end.y, x2: end.x, y2: end.y }],
    [{ x1: start.x, y1: start.y, x2: start.x, y2: minY }, { x1: start.x, y1: minY, x2: end.x, y2: minY }, { x1: end.x, y1: minY, x2: end.x, y2: end.y }],
    [{ x1: start.x, y1: start.y, x2: start.x, y2: maxY }, { x1: start.x, y1: maxY, x2: end.x, y2: maxY }, { x1: end.x, y1: maxY, x2: end.x, y2: end.y }]
  ];
  return choices.find((candidate) => legal(candidate, sourceKey, targetKey, points)) ?? null;
}

function strictBetween(value: number, first: number, second: number): boolean { return value > Math.min(first, second) && value < Math.max(first, second); }
function segmentCrosses(left: AtlasRouteSegment, right: AtlasRouteSegment): boolean {
  const leftVertical = left.x1 === left.x2;
  const rightVertical = right.x1 === right.x2;
  if (leftVertical === rightVertical) return false; // shared/parallel rails are not a crossing.
  const vertical = leftVertical ? left : right;
  const horizontal = leftVertical ? right : left;
  return strictBetween(vertical.x1, horizontal.x1, horizontal.x2) && strictBetween(horizontal.y1, vertical.y1, vertical.y2);
}
function crossingsWith(candidate: readonly AtlasRouteSegment[], routes: readonly AtlasPlannedRoute[]): number {
  let crossings = 0;
  for (const segment of candidate) for (const route of routes) for (const prior of route.segments) if (segmentCrosses(segment, prior)) crossings += 1;
  return crossings;
}
function metrics(routes: readonly AtlasPlannedRoute[], regions: ReadonlyMap<string, Budget>) {
  return {
    connectors: routes.length,
    segments: routes.reduce((sum, route) => sum + route.segments.length, 0),
    crossings: routes.reduce((sum, route, index) => sum + crossingsWith(route.segments, routes.slice(0, index)), 0),
    maxRegionConnectors: Math.max(0, ...[...regions.values()].map((budget) => budget.connectors)),
    maxRegionSegments: Math.max(0, ...[...regions.values()].map((budget) => budget.segments)),
    maxRegionCrossings: Math.max(0, ...[...regions.values()].map((budget) => budget.crossings))
  };
}

/** Pure plan only: it never receives raw runtime data and never creates DOM/SVG. */
export function planAtlasRoutes(model: AtlasModel, layout: AtlasLayout, input: { lens: AtlasRoutingLens; selected?: AtlasKey | null; viewport?: AtlasRoutingViewport }): AtlasRoutingPlan {
  const empty: AtlasRoutingPlan = { policyVersion: ATLAS_ROUTING_POLICY.version, routes: [], population: { resolved: 0, unresolved: 0, ambiguous: 0, omitted: 0 }, metrics: { connectors: 0, segments: 0, crossings: 0, maxRegionConnectors: 0, maxRegionSegments: 0, maxRegionCrossings: 0, viewportConnectors: 0, viewportSegments: 0, viewportCrossings: 0 } };
  if (input.lens === "overview") return empty;
  const subjects = dataArray<AtlasModel["subjects"][number]>(model, "subjects", 250);
  const layoutPoints = dataArray<AtlasPoint>(layout, "points", 250);
  const relations = dataArray<AtlasRelation>(model, "relations", ATLAS_ROUTING_POLICY.maxModelRelations);
  const attachments = dataArray<AtlasAttachment>(model, "attachments", ATLAS_ROUTING_POLICY.maxModelAttachments);
  if (!subjects || !layoutPoints || !relations || !attachments) return empty;
  const routable = new Set(subjects.filter((subject) => subject.routability === "routable" && subject.ambiguity === "none").map((subject) => subject.key));
  const validPoints = layoutPoints.map(safePoint).filter((point): point is AtlasPoint => point !== null);
  if (validPoints.length !== layoutPoints.length) return empty;
  const points = new Map(validPoints.filter((point) => routable.has(point.subject as AtlasKey)).map((point) => [point.subject, point]));
  if (points.size !== routable.size) return empty;
  const candidates: Candidate[] = [];
  let unresolved = 0;
  for (const relation of relations) {
    const routeClass = declarationClass(relation);
    if (!routeClass || !lensAccepts(input.lens, routeClass)) continue;
    if (!routable.has(relation.source) || !routable.has(relation.target) || !points.has(relation.source) || !points.has(relation.target)) { unresolved += 1; continue; }
    const evidence = dataArray<AtlasEvidenceSources[number]>(relation, "evidence", ATLAS_ROUTING_POLICY.maxEvidencePerRecord);
    if (!safeEvidence(evidence)) continue;
    candidates.push({ source: relation.source, target: relation.target, routeClass, evidenceKey: evidenceKey(evidence), selected: input.selected === relation.source || input.selected === relation.target, bundlePopulation: 1 });
  }
  for (const attachment of attachments) {
    const routeClass = attachmentClass(attachment);
    if (!routeClass || !lensAccepts(input.lens, routeClass)) continue;
    if (!routable.has(attachment.subject) || !routable.has(attachment.context) || !points.has(attachment.subject) || !points.has(attachment.context)) { unresolved += 1; continue; }
    const evidence = dataArray<AtlasEvidenceSources[number]>(attachment, "evidence", ATLAS_ROUTING_POLICY.maxEvidencePerRecord);
    if (!safeEvidence(evidence)) continue;
    candidates.push({ source: attachment.subject, target: attachment.context, routeClass, evidenceKey: evidenceKey(evidence), selected: input.selected === attachment.subject || input.selected === attachment.context, bundlePopulation: 1 });
  }
  const ordered = candidates.sort((left, right) => Number(right.selected) - Number(left.selected) || compareText(left.routeClass, right.routeClass) || compareText(left.source, right.source) || compareText(left.target, right.target) || compareText(left.evidenceKey, right.evidenceKey));
  // Bound the merged candidate stream before geometry/allocation. The source
  // collections are independently capped by projection, but routing has its
  // own smaller combined work ceiling.
  const bounded = ordered.slice(0, ATLAS_ROUTING_POLICY.inputCandidates);
  const canonical: Candidate[] = [];
  for (const candidate of bounded) {
    const previous = canonical.at(-1);
    if (previous && previous.routeClass === candidate.routeClass && previous.source === candidate.source && previous.target === candidate.target) {
      previous.bundlePopulation += 1;
      continue;
    }
    canonical.push({ ...candidate });
  }
  const total = caps(subjects.length);
  const regionLimit = regionCaps(subjects.length);
  const logicalRegions = regionsFor(validPoints);
  if (logicalRegions.length === 0) return empty;
  const minX = Math.min(...logicalRegions.map((region) => region.x)), minY = Math.min(...logicalRegions.map((region) => region.y));
  const maxX = Math.max(...logicalRegions.map((region) => region.x + region.width)), maxY = Math.max(...logicalRegions.map((region) => region.y + region.height));
  const viewport: Region = { key: "viewport", x: Number.isFinite(input.viewport?.x) ? input.viewport!.x! : minX, y: Number.isFinite(input.viewport?.y) ? input.viewport!.y! : minY,
    width: input.viewport && Number.isFinite(input.viewport.width) && input.viewport.width > 0 ? input.viewport.width : maxX - minX,
    height: input.viewport && Number.isFinite(input.viewport.height) && input.viewport.height > 0 ? input.viewport.height : maxY - minY };
  const regionUse = new Map<string, Budget>();
  const viewportUse: Budget = { connectors: 0, segments: 0, crossings: 0 };
  const routes: AtlasPlannedRoute[] = [];
  let omitted = ordered.length - canonical.length;
  for (const candidate of canonical) {
    if (routes.length >= total.connectors) { omitted += 1; continue; }
    const source = points.get(candidate.source)!;
    const target = points.get(candidate.target)!;
    const geometry = routeGeometry(source, target, [...points.values()], candidate.source, candidate.target, routes.length % 8 * 3);
    const crossings = geometry ? crossingsWith(geometry, routes) : 0;
    const usage = geometry ? routeRegionUsage(geometry, logicalRegions) : new Map<string, number>();
    const viewportSegments = geometry ? geometry.filter((segment) => segmentIntersects(segment, viewport)).length : 0;
    if ([...usage].some(([key, segments]) => { const current = regionUse.get(key) ?? { connectors: 0, segments: 0, crossings: 0 }; return current.connectors + 1 > regionLimit.connectors || current.segments + segments > regionLimit.segments || current.crossings + crossings > regionLimit.crossings; }) ||
      (viewportSegments > 0 && (viewportUse.connectors + 1 > total.connectors || viewportUse.segments + viewportSegments > total.segments || viewportUse.crossings + crossings > total.crossings))) { omitted += 1; continue; }
    if (!geometry || metrics(routes, regionUse).segments + geometry.length > total.segments ||
      metrics(routes, regionUse).crossings + crossings > total.crossings) { omitted += 1; continue; }
    // Do not place evidence ids/summaries in a renderer-visible key. The
    // ordinal is canonical because the candidate stream is canonical.
    routes.push({ key: `atlas-route:${routes.length}`, source: candidate.source, target: candidate.target, routeClass: candidate.routeClass, segments: geometry, bundlePopulation: candidate.bundlePopulation, selected: candidate.selected });
    for (const [key, segments] of usage) { const current = regionUse.get(key) ?? { connectors: 0, segments: 0, crossings: 0 }; regionUse.set(key, { connectors: current.connectors + 1, segments: current.segments + segments, crossings: current.crossings + crossings }); }
    if (viewportSegments > 0) { viewportUse.connectors += 1; viewportUse.segments += viewportSegments; viewportUse.crossings += crossings; }
  }
  return { policyVersion: ATLAS_ROUTING_POLICY.version, routes, population: { resolved: routes.length, unresolved, ambiguous: 0, omitted }, metrics: { ...metrics(routes, regionUse), viewportConnectors: viewportUse.connectors, viewportSegments: viewportUse.segments, viewportCrossings: viewportUse.crossings } };
}

/** Exported test invariant for renderer harnesses; it does not infer topology. */
export function routeAvoidsSubjectInteriors(route: AtlasPlannedRoute, layout: AtlasLayout): boolean {
  const points = new Map(layout.points.map((point) => [point.subject, point]));
  return legal(route.segments, route.source, route.target, points);
}
