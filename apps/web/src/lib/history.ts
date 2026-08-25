import { evidenceLabel, unavailable } from "./evidence";

/**
 * DockerMap has no change-event collector in any mode. Demo and mock can show
 * tagged samples, but neither records a real deployment, restart, or failure.
 */
const CHANGE_HISTORY_DETAIL = "Change collectors not wired — DockerMap does not record deploy, restart or failure events";
const CAUSAL_CHAIN_DETAIL = "Event causality not reconstructed — DockerMap observes current state, not transitions";

/** The single public claim object for recorded change history. */
export const CHANGE_HISTORY_CLAIM = Object.freeze(unavailable(CHANGE_HISTORY_DETAIL));

/** The single public claim object for causal event reconstruction. */
export const CAUSAL_CHAIN_CLAIM = Object.freeze(unavailable(CAUSAL_CHAIN_DETAIL));

/** Derived evidence label for copilot's mode-independent history claim. */
export const NOT_COLLECTED_LABEL = evidenceLabel(CHANGE_HISTORY_CLAIM.kind).label;

export const SAMPLE_EMPTY_TITLE = "No sample change";
export const SAMPLE_EMPTY_BODY = "The sample topology has no change events right now.";
export const SAMPLE_FILTERED_EMPTY_BODY = "No sample change events match this filter.";
