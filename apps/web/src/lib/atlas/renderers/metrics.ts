import type { AtlasLayout, AtlasModel } from "../types";
import { ATLAS_RENDERER_POLICY, type AtlasRendererCandidate } from "./policy";
import { cappedPointIndex, renderableAggregates, renderableAttachments, renderableRelations, renderableSubjects } from "./shared";

/** Fixed fixture matrix for recorded, non-threshold renderer comparison evidence. */
export const ATLAS_COMPARISON_SUBJECT_COUNTS = [25, 100, 250] as const;
export const ATLAS_COMPARISON_WARMED_SAMPLES = 15;

export interface AtlasRendererTimingSample {
  projectionMs: number;
  layoutMs: number;
  mountMs: number;
  updateMs: number;
}

export interface AtlasRendererComparisonRecord {
  candidate: AtlasRendererCandidate;
  subjectCount: typeof ATLAS_COMPARISON_SUBJECT_COUNTS[number];
  samples: readonly AtlasRendererTimingSample[];
}

/**
 * Preserve a bounded local measurement record without interpreting duration as
 * a pass/fail performance threshold. The mounted harness supplies real marks.
 */
export function recordRendererComparison(
  candidate: AtlasRendererCandidate,
  subjectCount: typeof ATLAS_COMPARISON_SUBJECT_COUNTS[number],
  samples: readonly AtlasRendererTimingSample[]
): AtlasRendererComparisonRecord {
  return { candidate, subjectCount, samples: samples.slice(0, ATLAS_COMPARISON_WARMED_SAMPLES) };
}

export function hasFiniteRendererSamples(record: AtlasRendererComparisonRecord): boolean {
  return record.samples.length === ATLAS_COMPARISON_WARMED_SAMPLES && record.samples.every((sample) =>
    [sample.projectionMs, sample.layoutMs, sample.mountMs, sample.updateMs].every(Number.isFinite)
  );
}

export interface AtlasRendererMetrics {
  candidate: AtlasRendererCandidate;
  addedRuntimeDependencies: 0;
  subjectVisuals: number;
  interactiveSubjects: number;
  visibleRelations: number;
  visibleAttachments: number;
  visibleAggregates: number;
  nonRoutableSubjects: number;
  usesSemanticHtmlDirectory: boolean;
  usesExternalAssets: false;
}

/** Deterministic comparison harness; it never reads a DOM or network state. */
export function rendererMetrics(candidate: AtlasRendererCandidate, model: AtlasModel, layout: AtlasLayout): AtlasRendererMetrics {
  const points = cappedPointIndex(layout);
  const subjects = renderableSubjects(model, points);
  const relations = renderableRelations(model, points);
  const attachments = renderableAttachments(model, points);
  const aggregates = renderableAggregates(model);
  return {
    candidate,
    addedRuntimeDependencies: 0,
    subjectVisuals: subjects.length,
    interactiveSubjects: subjects.filter((subject) => subject.routability === "routable").length,
    visibleRelations: relations.length,
    visibleAttachments: attachments.length,
    visibleAggregates: aggregates.length,
    nonRoutableSubjects: subjects.filter((subject) => subject.routability === "non_routable").length,
    usesSemanticHtmlDirectory: candidate === "svg_html_hybrid",
    usesExternalAssets: false
  };
}
