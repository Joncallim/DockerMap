import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
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
  { path: "/daemon/findings", routeId: "findings", schema: RUST_ROUTE_RESPONSE_SCHEMAS.findings },
  { path: "/daemon/history", routeId: "history", schema: RUST_ROUTE_RESPONSE_SCHEMAS.history },
  { path: "/daemon/observed-events", routeId: "observed-events", schema: RUST_ROUTE_RESPONSE_SCHEMAS["observed-events"] },
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
  systemd: true,
  python_processes: true,
  native_processes: true,
  project_npm: true,
} as const satisfies Record<ProviderSlot, true>;
const PROVIDER_STATE_SLOTS = Object.keys(PROVIDER_STATE_SLOT_SET) as ProviderSlot[];
const U32_MAX = 4_294_967_295;
const SYSTEMD_REQUIRES_FINDING_RULE = "systemd.requires_target_not_active";
const SYSTEMD_REQUIRES_FINDING_SUMMARY = "An active systemd service requires a target that is inactive or failed";
const SYSTEMD_REQUIRES_FINDING_RECOMMENDATION = "Inspect the target service state and its declared dependency configuration.";
const INTERNAL_NETWORK_PORT_FINDING_RULE = "docker.internal_network_member_publishes_port";
const INTERNAL_NETWORK_PORT_FINDING_SUMMARY = "A container on an internal Docker network also has a published host port.";
const INTERNAL_NETWORK_PORT_FINDING_RECOMMENDATION = "Review whether the host-port publication is intended for this internal-network service.";
const DOCKER_DAEMON_STATE_FINDING_RULE = "docker.daemon_state_bind_mount";
const DOCKER_DAEMON_STATE_FINDING_SUMMARY = "A container has Docker daemon state access that may provide Docker daemon API authority.";
const DOCKER_DAEMON_STATE_FINDING_RECOMMENDATION = "Review whether this container requires Docker daemon API authority.";
const REPEATED_CONTAINER_DIED_EVENTS_FINDING_RULE = "docker.repeated_container_died_events";
const REPEATED_CONTAINER_DIED_EVENTS_FINDING_SUMMARY = "A Docker container had three observed die events within five minutes.";
const REPEATED_CONTAINER_DIED_EVENTS_RECOMMENDATION = "Review the container's recent configuration and logs to determine whether the repeated exits are expected.";
const REPEATED_CONTAINER_DIED_EVENTS_WINDOW_MS = 300_000;
const OPAQUE_DOCKER_CONTAINER_ID = /^docker_container_[0-9a-f]{64}$/;
const OPAQUE_DOCKER_EVENT_ID = /^docker_event_[0-9a-f]{64}$/;

// Version-one evidence is intentionally a discriminated Docker observation,
// not a generic provenance bag. JSON Schema owns each field's closed enum;
// this small cross-field table binds an emitted fact to the relationship it
// can actually support. A later evidence version must add an explicit row.
const V1_EVIDENCE_EDGE = {
  docker_network_membership: { relationship: "connected_to", sourcePrefix: "docker_container_", targetPrefix: "docker_network_" },
  docker_volume_mount: { relationship: "mounts", sourcePrefix: "docker_container_", targetPrefix: "docker_volume_" },
  docker_port_publication: { relationship: "exposes", sourcePrefix: "docker_container_", targetPrefix: "network_listener_" },
  docker_compose_depends_on: { relationship: "depends_on", sourcePrefix: "docker_container_", targetPrefix: "docker_container_" },
  docker_daemon_state_bind_mount: { relationship: "exposes_daemon_state", sourcePrefix: "docker_container_", targetPrefix: "host_risk_docker_daemon_state" },
} as const;

// Version two is the intentionally narrow systemd declaration vocabulary.
// It is tied to Systemd's independently scheduled slot, rather than to the
// broader host collection, so retained freshness stays attributable.
const V2_EVIDENCE_EDGE = {
  systemd_requires: { relationship: "requires", sourcePrefix: "systemd_service_", targetPrefix: "systemd_service_" },
  systemd_wants: { relationship: "wants", sourcePrefix: "systemd_service_", targetPrefix: "systemd_service_" },
  systemd_part_of: { relationship: "part_of", sourcePrefix: "systemd_service_", targetPrefix: "systemd_service_" },
} as const;

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

function hasCoherentRuntimeEvidence(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const edges = (payload as { edges?: unknown }).edges;
  if (!Array.isArray(edges)) return false;
  return edges.every((edge) => {
    if (!edge || typeof edge !== "object") return false;
    const candidate = edge as { source?: unknown; target?: unknown; relationship?: unknown; evidenceRefs?: unknown };
    if (!Array.isArray(candidate.evidenceRefs)) return false;
    return candidate.evidenceRefs.every((evidence) => {
      if (!evidence || typeof evidence !== "object") return false;
      const value = evidence as {
        version?: unknown; provider?: unknown; kind?: unknown; assertionKind?: unknown;
        freshness?: unknown; providerRevision?: unknown; collectedAt?: unknown; subjectRef?: unknown;
        providerSlot?: unknown;
      };
      const isV1 = value.version === 1
        && value.provider === "docker"
        && value.assertionKind === "observed"
        && value.freshness === "fresh"
        && (value.providerSlot === null || value.providerSlot === undefined);
      const isV2 = value.version === 2
        && value.provider === "systemd"
        && value.assertionKind === "declared"
        && value.providerSlot === "systemd"
        && (value.freshness === "fresh" || value.freshness === "stale" || value.freshness === "timed_out");
      if (!isV1 && !isV2) return false;
      const expected = typeof value.kind === "string"
        ? (isV1
          ? V1_EVIDENCE_EDGE[value.kind as keyof typeof V1_EVIDENCE_EDGE]
          : V2_EVIDENCE_EDGE[value.kind as keyof typeof V2_EVIDENCE_EDGE])
        : undefined;
      if (!expected || candidate.relationship !== expected.relationship || typeof candidate.source !== "string" || typeof candidate.target !== "string") return false;
      if (value.subjectRef !== candidate.source || !candidate.source.startsWith(expected.sourcePrefix) || !candidate.target.startsWith(expected.targetPrefix)) return false;
      if (value.kind === "docker_daemon_state_bind_mount" && candidate.target !== "host_risk_docker_daemon_state") return false;
      if (candidate.source === candidate.target) return false;
      // An opaque observation token must never be the collection timestamp
      // re-labelled as a revision. The daemon produces it independently.
      return typeof value.providerRevision === "string" && value.providerRevision !== String(value.collectedAt);
    });
  });
}

// Findings are a deliberately tiny conclusion vocabulary, not a daemon-supplied
// diagnostics channel. The generated schema owns field shape; this exact rule
// table prevents a compromised daemon from inventing mutable claims or copying
// arbitrary strings through the new endpoint.
function hasCoherentFindings(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const findings = (payload as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return false;
  return findings.every((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const finding = candidate as Record<string, unknown>;
    if (finding.ruleId === REPEATED_CONTAINER_DIED_EVENTS_FINDING_RULE) return finding.severity === "advisory"
      && finding.summary === REPEATED_CONTAINER_DIED_EVENTS_FINDING_SUMMARY
      && finding.recommendation === REPEATED_CONTAINER_DIED_EVENTS_RECOMMENDATION
      && typeof finding.id === "string"
      // This is a temporal-only opaque subject, not a runtime-map entity that
      // a browser may resolve or link to. The fixed stream target says only
      // where the three retained observations came from.
      && typeof finding.subjectRef === "string"
      && OPAQUE_DOCKER_CONTAINER_ID.test(finding.subjectRef)
      && finding.id === `finding_docker_repeated_container_died_events_${collisionResistantIdComponent(finding.subjectRef)}`
      && finding.targetRef === "docker_event_stream"
      && Array.isArray(finding.evidenceRefs)
      && finding.evidenceRefs.length === 0
      && hasCoherentRepeatedContainerDiedEvidence(finding.temporalEvidenceRefs);
    if (finding.ruleId === SYSTEMD_REQUIRES_FINDING_RULE) return finding.severity === "warning"
      && finding.summary === SYSTEMD_REQUIRES_FINDING_SUMMARY
      && finding.recommendation === SYSTEMD_REQUIRES_FINDING_RECOMMENDATION
      && typeof finding.id === "string"
      && finding.id.startsWith("finding_systemd_requires_target_not_active_")
      && typeof finding.subjectRef === "string"
      && finding.subjectRef.startsWith("systemd_service_")
      && typeof finding.targetRef === "string"
      && finding.targetRef.startsWith("systemd_service_")
      && finding.subjectRef !== finding.targetRef
      && Array.isArray(finding.evidenceRefs)
      && finding.evidenceRefs.length === 1
      && finding.temporalEvidenceRefs === undefined
      && (() => {
        const candidateEvidence = finding.evidenceRefs[0];
        if (!candidateEvidence || typeof candidateEvidence !== "object") return false;
        const evidence = candidateEvidence as Record<string, unknown>;
        return evidence.version === 2
          && evidence.provider === "systemd"
          && evidence.kind === "systemd_requires"
          && evidence.assertionKind === "declared"
          && evidence.providerSlot === "systemd"
          && evidence.freshness === "fresh"
          && evidence.subjectRef === finding.subjectRef;
      })();
    if (finding.ruleId === DOCKER_DAEMON_STATE_FINDING_RULE) return finding.severity === "warning"
      && finding.summary === DOCKER_DAEMON_STATE_FINDING_SUMMARY
      && finding.recommendation === DOCKER_DAEMON_STATE_FINDING_RECOMMENDATION
      && typeof finding.id === "string"
      && finding.id.startsWith("finding_docker_daemon_state_bind_mount_")
      && typeof finding.subjectRef === "string"
      && finding.subjectRef.startsWith("docker_container_")
      && finding.targetRef === "host_risk_docker_daemon_state"
      && Array.isArray(finding.evidenceRefs)
      && finding.evidenceRefs.length === 1
      && finding.temporalEvidenceRefs === undefined
      && (() => {
        const candidateEvidence = finding.evidenceRefs[0];
        if (!candidateEvidence || typeof candidateEvidence !== "object") return false;
        const evidence = candidateEvidence as Record<string, unknown>;
        return evidence.version === 1
          && evidence.provider === "docker"
          && evidence.kind === "docker_daemon_state_bind_mount"
          && evidence.assertionKind === "observed"
          && evidence.summary === "Docker reported a bind mount exposing Docker daemon state"
          && evidence.subjectRef === finding.subjectRef
          && evidence.providerSlot === null
          && evidence.freshness === "fresh"
          && typeof evidence.providerRevision === "string"
          && evidence.providerRevision !== String(evidence.collectedAt);
      })();
    if (finding.ruleId !== INTERNAL_NETWORK_PORT_FINDING_RULE) return false;
    return finding.severity === "advisory"
      && finding.summary === INTERNAL_NETWORK_PORT_FINDING_SUMMARY
      && finding.recommendation === INTERNAL_NETWORK_PORT_FINDING_RECOMMENDATION
      && typeof finding.id === "string"
      && finding.id.startsWith("finding_docker_internal_network_member_publishes_port_")
      && typeof finding.subjectRef === "string"
      && finding.subjectRef.startsWith("docker_container_")
      && typeof finding.targetRef === "string"
      && finding.targetRef.startsWith("docker_network_")
      && Array.isArray(finding.evidenceRefs)
      && finding.evidenceRefs.length === 2
      && finding.temporalEvidenceRefs === undefined
      && (() => {
        const [membership, port] = finding.evidenceRefs;
        if (!membership || typeof membership !== "object" || !port || typeof port !== "object") return false;
        const networkEvidence = membership as Record<string, unknown>;
        const portEvidence = port as Record<string, unknown>;
        return networkEvidence.version === 1
          && networkEvidence.provider === "docker"
          && networkEvidence.kind === "docker_network_membership"
          && networkEvidence.assertionKind === "observed"
          && networkEvidence.freshness === "fresh"
          && networkEvidence.providerSlot === null
          && networkEvidence.subjectRef === finding.subjectRef
          && typeof networkEvidence.providerRevision === "string"
          && networkEvidence.providerRevision !== String(networkEvidence.collectedAt)
          && portEvidence.version === 1
          && portEvidence.provider === "docker"
          && portEvidence.kind === "docker_port_publication"
          && portEvidence.assertionKind === "observed"
          && portEvidence.freshness === "fresh"
          && portEvidence.providerSlot === null
          && portEvidence.subjectRef === finding.subjectRef
          && typeof portEvidence.providerRevision === "string"
          && portEvidence.providerRevision !== String(portEvidence.collectedAt);
      })();
  });
}

// Keep this byte-for-byte aligned with core's `collision_resistant_id_component`.
// Temporal subjects are currently ASCII-only digests, but retaining the complete
// routine here prevents a future vocabulary expansion from weakening the
// browser boundary through a readable-slug collision.
function collisionResistantIdComponent(value: string): string {
  let slug = "";
  let emittedSeparator = false;
  for (const character of value) {
    if (/^[A-Za-z0-9_.-]$/.test(character)) {
      slug += character;
      emittedSeparator = false;
    } else if (!emittedSeparator) {
      slug += "-";
      emittedSeparator = true;
    }
  }
  const trimmed = slug.replace(/^-+|-+$/g, "");
  const readable = trimmed.length === 0 ? "identity" : Array.from(trimmed).slice(0, 48).join("");
  const digest = createHash("sha256").update(value, "utf8").digest("hex");
  return `${readable}--${digest}`;
}

function hasCoherentRepeatedContainerDiedEvidence(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 3) return false;

  const evidence = value as Record<string, unknown>[];
  const eventIds = new Set<string>();
  for (const reference of evidence) {
    if (!reference
      || typeof reference.eventId !== "string"
      || !OPAQUE_DOCKER_EVENT_ID.test(reference.eventId)
      || eventIds.has(reference.eventId)
      || reference.source !== "docker_event_stream"
      || reference.kind !== "container_died"
      || typeof reference.sourceOccurredAtMs !== "number"
      || !Number.isSafeInteger(reference.sourceOccurredAtMs)
      || reference.sourceOccurredAtMs < 0
      || !isBoundedObservedEventRevision(reference.anchorModelRevision)
      || !isBoundedObservedEventRevision(reference.anchorObservationRevision)) {
      return false;
    }
    eventIds.add(reference.eventId);
  }
  const sourceTimes = evidence.map((reference) => reference.sourceOccurredAtMs as number);
  const orderedEventIds = evidence.map((reference) => reference.eventId as string);

  // Core orders this fixed three-observation window by source time and then
  // opaque event identity. A Finding response carries no runtime subject in
  // these refs, deliberately preventing a temporal observation from being
  // promoted into a current container link.
  if (!evidence.slice(1).every((_, index) => {
    const currentTime = sourceTimes[index + 1];
    const previousTime = sourceTimes[index];
    return currentTime > previousTime
      || (currentTime === previousTime && orderedEventIds[index + 1] > orderedEventIds[index]);
  })) return false;

  return sourceTimes[2] - sourceTimes[0]
    <= REPEATED_CONTAINER_DIED_EVENTS_WINDOW_MS;
}

// History is a deliberately narrow observation envelope. In particular mock
// mode cannot inherit a Docker baseline, revisions, or events. Schema checks
// field types; this binds the fields into the only supported state machine.
function hasCoherentObservedHistory(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const history = payload as Record<string, unknown>;
  const source = history.source;
  const baseline = history.baselineEstablished;
  const currentRevision = history.currentModelRevision;
  const observedRevision = history.observedRevision;
  const events = history.events;
  if ((source !== "docker" && source !== "mock") || typeof baseline !== "boolean" || !Array.isArray(events)) return false;
  if (source === "mock" || !baseline) return currentRevision === null && observedRevision === null && events.length === 0;
  if (typeof currentRevision !== "string" || !currentRevision || typeof observedRevision !== "string" || !observedRevision) return false;
  return events.every((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const event = candidate as Record<string, unknown>;
    if (typeof event.id !== "string" || !event.id
      || typeof event.containerId !== "string"
      || !/^docker_container_[0-9a-f]{64}$/.test(event.containerId)) return false;
    const previous = event.previousStatus;
    const current = event.currentStatus;
    if (event.kind === "container_appeared") return previous === null && typeof current === "string";
    if (event.kind === "container_disappeared") return typeof previous === "string" && current === null;
    return event.kind === "container_status_changed" && typeof previous === "string" && typeof current === "string" && previous !== current;
  });
}

// Docker stream evidence has a distinct lifecycle from snapshot-derived
// history. The generated schema owns its closed vocabulary and field bounds;
// this mirrors the Rust state machine so a syntactically valid 2xx cannot
// claim usable stream evidence while the collector is unavailable or mocked.
function hasCoherentObservedDockerEventHistory(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const history = payload as Record<string, unknown>;
  const source = history.source;
  const collectionState = history.collectionState;
  const currentModelRevision = history.currentModelRevision;
  const currentObservationRevision = history.currentObservationRevision;
  const events = history.events;
  if ((source !== "docker" && source !== "mock") || !Array.isArray(events)) return false;

  const unavailable = collectionState === "unavailable";
  if (source === "mock" && !unavailable) return false;
  if (source === "mock" || unavailable) {
    return currentModelRevision === null
      && currentObservationRevision === null
      && events.length === 0;
  }
  if (collectionState !== "connecting" && collectionState !== "collecting" && collectionState !== "reconnecting") return false;
  if (!isBoundedObservedEventRevision(currentModelRevision)
    || !isBoundedObservedEventRevision(currentObservationRevision)) return false;

  return events.every((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const event = candidate as Record<string, unknown>;
    return typeof event.id === "string"
      && /^docker_event_[0-9a-f]{64}$/.test(event.id)
      && event.evidenceSource === "docker_event_stream"
      && typeof event.containerId === "string"
      && /^docker_container_[0-9a-f]{64}$/.test(event.containerId)
      && typeof event.observedAtMs === "number"
      && Number.isSafeInteger(event.observedAtMs)
      && event.observedAtMs >= 0
      && typeof event.sourceOccurredAtMs === "number"
      && Number.isSafeInteger(event.sourceOccurredAtMs)
      && event.sourceOccurredAtMs >= 0
      && typeof event.anchorModelRevision === "string"
      && isBoundedObservedEventRevision(event.anchorModelRevision)
      && typeof event.anchorObservationRevision === "string"
      && isBoundedObservedEventRevision(event.anchorObservationRevision)
      && (event.kind === "container_created"
        || event.kind === "container_started"
        || event.kind === "container_stopped"
        || event.kind === "container_died"
        || event.kind === "container_restarted"
        || event.kind === "container_destroyed"
        || event.kind === "container_health_starting"
        || event.kind === "container_health_healthy"
        || event.kind === "container_health_unhealthy");
  });
}

function isBoundedObservedEventRevision(value: unknown): value is string {
  // Rust's `chars().count()` treats each Unicode scalar as one character;
  // Array.from is the matching JavaScript operation rather than UTF-16 length.
  return typeof value === "string" && value.length > 0 && Array.from(value).length <= 64;
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
  if (!validator || !validator(payload)
    || (schema === "RuntimeMap" && (!hasCompleteProviderStateVector(payload) || !hasCoherentProviderFreshness(payload) || !hasCoherentRuntimeEvidence(payload)))
    || (schema === "FindingsResponse" && !hasCoherentFindings(payload))
    || (schema === "ObservedChangeHistoryResponse" && !hasCoherentObservedHistory(payload))
    || (schema === "ObservedDockerEventHistoryResponse" && !hasCoherentObservedDockerEventHistory(payload))) {
    throw new DaemonResponseValidationError();
  }
  return payload;
}
