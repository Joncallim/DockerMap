import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import {
  RUST_RESPONSE_SCHEMAS,
  type ProviderSlot,
  type RustResponseSchemaId,
} from "@dockermap/contracts";
import { RUST_ROUTE_RESPONSE_SCHEMAS } from "./rustResponseContracts.js";

/**
 * The complete Rust-owned response contract at the Node-to-browser boundary.
 *
 * Keep this deliberately path-based rather than trusting callers to remember a
 * validator: every successful daemon read passes through `validateDaemonResponse`.
 * Query-bearing paths retain their response root, while all other forms fail
 * closed rather than being treated as an untyped daemon response.
 */
export const DAEMON_RESPONSE_SCHEMA_PATHS = [
  // Health is an explicit Rust dependency of RootHealth, ApiHealth, Status,
  // and SSE snapshots even though those browser responses are Node envelopes.
  { path: "/daemon/health", schema: "HealthResponse" },
  { path: "/daemon/snapshot", routeId: "snapshot", schema: RUST_ROUTE_RESPONSE_SCHEMAS.snapshot },
  { path: "/daemon/graph", routeId: "graph", schema: RUST_ROUTE_RESPONSE_SCHEMAS.graph },
  { path: "/daemon/runtime/map", routeId: "runtime-map", schema: RUST_ROUTE_RESPONSE_SCHEMAS["runtime-map"] },
  { path: "/daemon/containers", routeId: "containers", schema: RUST_ROUTE_RESPONSE_SCHEMAS.containers },
  { path: "/daemon/containers/:name", routeId: "container", schema: RUST_ROUTE_RESPONSE_SCHEMAS.container },
  { path: "/daemon/images", routeId: "images", schema: RUST_ROUTE_RESPONSE_SCHEMAS.images },
  { path: "/daemon/networks", routeId: "networks", schema: RUST_ROUTE_RESPONSE_SCHEMAS.networks },
  { path: "/daemon/volumes", routeId: "volumes", schema: RUST_ROUTE_RESPONSE_SCHEMAS.volumes },
  { path: "/daemon/logs", routeId: "logs", schema: RUST_ROUTE_RESPONSE_SCHEMAS.logs },
  { path: "/daemon/compose/scan", routeId: "compose-scan", schema: RUST_ROUTE_RESPONSE_SCHEMAS["compose-scan"] },
  { path: "/daemon/compose/graph", routeId: "compose-graph", schema: RUST_ROUTE_RESPONSE_SCHEMAS["compose-graph"] },
  { path: "/daemon/compose/edit-plan", routeId: "compose-edit-plan", schema: RUST_ROUTE_RESPONSE_SCHEMAS["compose-edit-plan"] },
] as const satisfies readonly { path: string; schema: RustResponseSchemaId; routeId?: keyof typeof RUST_ROUTE_RESPONSE_SCHEMAS }[];

const ajv = new Ajv2020({ allErrors: true, strict: true, formats: { uint8: true, uint32: true, uint64: true } });
const validators = new Map<RustResponseSchemaId, ValidateFunction>(
  (Object.entries(RUST_RESPONSE_SCHEMAS) as [RustResponseSchemaId, (typeof RUST_RESPONSE_SCHEMAS)[RustResponseSchemaId]][])
    .map(([schema, definition]) => [schema, ajv.compile(definition)]),
);

// JSON Schema bounds the vector length and item shape.  It cannot express the
// finite "each named slot exactly once" invariant, so enforce that one
// generated-contract typed set at the untrusted daemon boundary.  This is not
// a policy surface: provider slots remain daemon-owned and closed-world.
const PROVIDER_STATE_SLOT_SET = {
  network_infrastructure: true,
  host_scoped: true,
  python_processes: true,
  native_processes: true,
  project_npm: true,
} as const satisfies Record<ProviderSlot, true>;
const PROVIDER_STATE_SLOTS = Object.keys(PROVIDER_STATE_SLOT_SET) as ProviderSlot[];
const U32_MAX = 4_294_967_295;

function hasCompleteProviderStateVector(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const providerStates = (payload as { providerStates?: unknown }).providerStates;
  if (!Array.isArray(providerStates) || providerStates.length !== PROVIDER_STATE_SLOTS.length) return false;
  const slots = new Set(
    providerStates.map((state) => state && typeof state === "object" ? (state as { slot?: unknown }).slot : undefined),
  );
  return slots.size === PROVIDER_STATE_SLOTS.length
    && PROVIDER_STATE_SLOTS.every((slot) => slots.has(slot));
}

// JSON Schema deliberately carries the wire shape, while this boundary check
// carries the small cross-field truth table.  Keep it closed and structural:
// no daemon-supplied diagnostic text is accepted as a reason.
function hasCoherentProviderFreshness(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const providerStates = (payload as { providerStates?: unknown }).providerStates;
  if (!Array.isArray(providerStates)) return false;
  return providerStates.every((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const state = candidate as {
      state?: unknown; statusReason?: unknown; lastAttemptMs?: unknown;
      lastSuccessMs?: unknown; lastDurationMs?: unknown;
      consecutiveFailureCount?: unknown; dataRevision?: unknown;
    };
    const attempt = state.lastAttemptMs;
    const success = state.lastSuccessMs;
    const duration = state.lastDurationMs;
    const failures = state.consecutiveFailureCount;
    const revision = state.dataRevision;
    if (typeof failures !== "number" || !Number.isSafeInteger(failures) || failures < 0 || failures > U32_MAX) return false;
    if (![attempt, success, duration].every((value) => value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0))) return false;
    if (!(revision === null || (typeof revision === "string" && revision.length > 0))) return false;
    const attemptedMs = attempt as number | null;
    const successfulMs = success as number | null;
    const durationMs = duration as number | null;
    if (successfulMs !== null && attemptedMs === null) return false;
    // A failed or timed-out retry legitimately has a newer last attempt than
    // its retained last success. Duration belongs to that prior success, not
    // to the current attempt, so only bound it to a possible clock timeline.
    if (durationMs !== null && (successfulMs === null || durationMs > successfulMs)) return false;
    if ((success === null) !== (duration === null)) return false;
    if (revision !== null && success === null) return false;

    switch (state.state) {
      case "fresh": return state.statusReason === null && failures === 0 && successfulMs !== null && attemptedMs !== null && attemptedMs <= successfulMs && revision !== null;
      case "collecting":
        return state.statusReason === "refreshing" && attemptedMs !== null
          && successfulMs === null && durationMs === null && revision === null;
      case "timed_out": return state.statusReason === "collection_timed_out" && failures > 0 && attemptedMs !== null;
      case "disabled": return state.statusReason === "disabled";
      case "stale":
        if (successfulMs === null || revision === null) return false;
        return (state.statusReason === "refreshing" && attemptedMs !== null)
          || (state.statusReason === "collection_failed" && attemptedMs !== null && failures > 0)
          || (state.statusReason === null && attemptedMs !== null && attemptedMs <= successfulMs);
      case "unavailable":
        if (state.statusReason === "collection_failed") {
          return attemptedMs !== null && successfulMs === null && durationMs === null && revision === null && failures > 0;
        }
        return (state.statusReason === null || state.statusReason === "initial" || state.statusReason === "source_reset")
          && attemptedMs === null && successfulMs === null && durationMs === null && revision === null && failures === 0;
      default: return false;
    }
  });
}

export function daemonResponseSchemaId(path: string): RustResponseSchemaId | undefined {
  const pathname = path.split("?", 1)[0];
  if (pathname === "/daemon/containers") return "ContainersResponse";
  const containerName = pathname.slice("/daemon/containers/".length);
  if (pathname.startsWith("/daemon/containers/") && /^[^/]+$/.test(containerName)) {
    return "ContainerDetailResponse";
  }
  if (pathname === "/daemon/logs") return "LogsResponse";
  if (pathname === "/daemon/compose/scan") return "ComposeScan";
  if (pathname === "/daemon/compose/graph") return "ComposeGraph";
  if (pathname === "/daemon/compose/edit-plan") return "ComposeEditPlan";
  return DAEMON_RESPONSE_SCHEMA_PATHS.find((entry) => entry.path === pathname)?.schema;
}

/** A daemon response is syntactically JSON but violates its Rust-owned model. */
export class DaemonResponseValidationError extends Error {
  constructor() {
    // Keep the public error deliberately independent of schema paths/errors:
    // a compromised daemon must not use validator output as an exfiltration channel.
    super("Daemon response did not match its declared contract");
  }
}

/**
 * Validate unmodified daemon bytes before publication/redaction.  This rejects
 * unknown fields instead of silently stripping them, so Rust schemas remain the
 * single authority for browser-visible daemon models.
 */
export function validateDaemonResponse(path: string, payload: unknown) {
  const schema = daemonResponseSchemaId(path);
  const validator = schema && validators.get(schema);
  if (!validator || !validator(payload) || (schema === "RuntimeMap" && (!hasCompleteProviderStateVector(payload) || !hasCoherentProviderFreshness(payload)))) {
    throw new DaemonResponseValidationError();
  }
  return payload;
}
