import { evidenceLabel, unavailable, type Claim } from "./evidence";

/**
 * DockerMap has no update-evidence source in ANY mode: live never queries a
 * registry (the runtime is network-quiet by design), the mock server emits the
 * same update-free DockerSnapshot, and demo invents containers, not update
 * state. This is PERMANENT non-collection, so the same claim renders under
 * every authority level — including the null-authority heartbeat window
 * (#71 P2-2): the detail below, never the static "does not collect this yet"
 * description, and never a mode branch.
 */

/**
 * Internal only (U3): consumers must read `UPDATE_STATUS_CLAIM.detail`, never
 * a standalone detail constant — a separate exported detail string is a
 * second source of truth that a future collector could update while the claim
 * object drifts (guaranteed drift, L8's U3 root).
 */
const UPDATE_STATUS_DETAIL = "Update checks not wired — DockerMap does not query registries";

/**
 * The single public update claim object (kind/value/detail in ONE shape, U3).
 * Narrowed to the `unavailable` arm so `.detail` is directly accessible;
 * `unavailable()` still validates the detail at construction (fail-closed).
 */
export const UPDATE_STATUS_CLAIM = unavailable(UPDATE_STATUS_DETAIL) as Extract<Claim<never>, { kind: "unavailable" }>;

/** ONE derived display value, used at EVERY update surface (G-19, DM-05). */
export const UPDATE_STATUS_LABEL = evidenceLabel(UPDATE_STATUS_CLAIM.kind).label; // "Not collected"
