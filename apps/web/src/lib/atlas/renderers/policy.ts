/**
 * Fixture-spike-only renderer policy. It is separate from the projection and
 * layout policy so a later production renderer cannot silently change either.
 */
export const ATLAS_RENDERER_POLICY = {
  version: "atlas-v1/renderer-spike-1",
  maxVisibleRelations: 80,
  maxVisibleAttachments: 80,
  maxVisibleAggregates: 80,
  maxInteractiveSubjects: 250,
  labelCharacters: 96,
  cardPadding: 6,
  focusRingWidth: 2
} as const;

export type AtlasRendererCandidate = "native_svg" | "svg_html_hybrid";
