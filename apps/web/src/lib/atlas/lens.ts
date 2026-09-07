import { planAtlasRoutes, type AtlasRoutingPlan } from "./routing";
import type { AtlasKey, AtlasLayout, AtlasLens, AtlasModel } from "./types";

/** Closed, presentational Atlas lenses. They do not add any topology facts. */
export const ATLAS_LENSES = ["overview", "connectivity", "dependencies", "storage", "runtime", "attention"] as const satisfies readonly AtlasLens[];
export const ATLAS_DEFAULT_LENS = "overview" as const;
export type AtlasSupportedLens = (typeof ATLAS_LENSES)[number];

export interface AtlasLensView {
  lens: AtlasSupportedLens;
  label: string;
  description: string;
  routes: AtlasRoutingPlan;
}

const COPY: Record<AtlasSupportedLens, Pick<AtlasLensView, "label" | "description">> = {
  overview: { label: "Overview", description: "Orientation only. Recorded relations and attachments are not drawn." },
  dependencies: { label: "Dependencies", description: "Declared relations only. This does not state traffic, readiness, or runtime reachability." },
  connectivity: { label: "Connectivity", description: "Recorded network, port, and daemon-state context only. It does not state host or external reachability." },
  storage: { label: "Storage", description: "Recorded storage context only. It does not state data flow or persistence health." },
  runtime: { label: "Runtime", description: "Independent operational state, freshness, and attention only. No relations are drawn." },
  attention: { label: "Attention", description: "Published attention markers only. No relations are drawn." }
};

export function isAtlasLens(value: string): value is AtlasSupportedLens {
  return (ATLAS_LENSES as readonly string[]).includes(value);
}

/**
 * Lens selection is intentionally constrained to the published Atlas model,
 * frozen layout, selected Atlas key, and bounded routing planner.
 */
export function atlasLensView(model: AtlasModel, layout: AtlasLayout, lens: AtlasSupportedLens, selected: AtlasKey | null = null): AtlasLensView {
  return { lens, ...COPY[lens], routes: planAtlasRoutes(model, layout, { lens, selected }) };
}
