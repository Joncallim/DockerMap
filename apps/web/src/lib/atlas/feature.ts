/**
 * Build-time-only kill switch for the parallel Atlas route.  It intentionally
 * has no settings/UI control and defaults off in every artifact.
 */
export const ATLAS_OVERVIEW_ENABLED = import.meta.env.VITE_ENABLE_ATLAS_OVERVIEW === "true";
