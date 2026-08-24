import { evidenceLabel, unavailable } from "./evidence";

/**
 * DockerMap has no update-evidence source in ANY mode: live never queries a
 * registry (the runtime is network-quiet by design), the mock server emits the
 * same update-free DockerSnapshot, and demo invents containers, not update
 * state. This is PERMANENT non-collection, so the same claim renders under
 * every authority level — including the null-authority heartbeat window
 * (#71 P2-2): the detail below, never the static "does not collect this yet"
 * description, and never a mode branch.
 */
export const UPDATE_STATUS_DETAIL = "Update checks not wired — DockerMap does not query registries";

export const UPDATE_STATUS_CLAIM = unavailable(UPDATE_STATUS_DETAIL);

/** ONE derived display value, used at EVERY update surface (G-19, DM-05). */
export const UPDATE_STATUS_LABEL = evidenceLabel(UPDATE_STATUS_CLAIM.kind).label; // "Not collected"
