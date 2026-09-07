import { createHash } from "node:crypto";
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
  { path: "/daemon/findings", routeId: "findings", schema: RUST_ROUTE_RESPONSE_SCHEMAS.findings },
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
  tmux: true,
  cron: true,
} as const satisfies Record<ProviderSlot, true>;
const PROVIDER_STATE_SLOTS = Object.keys(PROVIDER_STATE_SLOT_SET) as ProviderSlot[];
const U32_MAX = 4_294_967_295;
const SYSTEMD_REQUIRES_FINDING_RULE = "systemd.requires_target_not_active";
const SYSTEMD_REQUIRES_FINDING_SUMMARY = "An active systemd service requires a target that is inactive or failed";
const SYSTEMD_REQUIRES_FINDING_RECOMMENDATION = "Inspect the target service state and its declared dependency configuration.";
const INTERNAL_NETWORK_PORT_FINDING_RULE = "docker.internal_network_member_publishes_port";
const INTERNAL_NETWORK_PORT_FINDING_SUMMARY = "A container on an internal Docker network also has a published host port.";
const INTERNAL_NETWORK_PORT_FINDING_RECOMMENDATION = "Review whether the host-port publication is intended for this internal-network service.";
const UNSPECIFIED_ADDRESS_PORT_FINDING_RULE = "docker.port_published_on_unspecified_address";
const UNSPECIFIED_ADDRESS_PORT_FINDING_SUMMARY = "Docker reported a container port published on an unspecified host address.";
const UNSPECIFIED_ADDRESS_PORT_FINDING_RECOMMENDATION = "Review whether publishing this container port beyond loopback is intended.";
const UNSPECIFIED_ADDRESS_PORT_EVIDENCE_SUMMARY = "Docker reported a container port published on an unspecified host address";
const DOCKER_DAEMON_STATE_FINDING_RULE = "docker.daemon_state_bind_mount";
const DOCKER_DAEMON_STATE_FINDING_SUMMARY = "A container has Docker daemon state access that may provide Docker daemon API authority.";
const DOCKER_DAEMON_STATE_FINDING_RECOMMENDATION = "Review whether this container requires Docker daemon API authority.";
const DOCKER_DAEMON_STATE_PUBLISHED_PORT_FINDING_RULE = "docker.daemon_state_bind_mount_publishes_port";
const DOCKER_DAEMON_STATE_PUBLISHED_PORT_FINDING_SUMMARY = "A container with Docker daemon state access also has a published host port.";
const DOCKER_DAEMON_STATE_PUBLISHED_PORT_FINDING_RECOMMENDATION = "Review whether the daemon-state access and host-port publication are both intended.";
const COMPOSE_DECLARED_TARGET_NOT_ACTIVE_FINDING_RULE = "docker.compose_declared_target_not_active";
const COMPOSE_DECLARED_TARGET_NOT_ACTIVE_FINDING_SUMMARY = "A running Docker Compose service declares a dependency whose container is not active.";
const COMPOSE_DECLARED_TARGET_NOT_ACTIVE_FINDING_RECOMMENDATION = "Review the declared dependency and the target container state.";
const COMPOSE_MUTUAL_DEPENDENCY_FINDING_RULE = "docker.compose_mutual_dependency";
const COMPOSE_MUTUAL_DEPENDENCY_FINDING_SUMMARY = "Docker recorded mutually declared Compose dependencies between two containers.";
const COMPOSE_MUTUAL_DEPENDENCY_FINDING_RECOMMENDATION = "Review the declared dependencies and remove any unintended mutual dependency.";
const COMPOSE_DECLARED_MOUNT_MISSING_FINDING_RULE = "compose.declared_mount_missing_at_bound_container";
const COMPOSE_DECLARED_MOUNT_MISSING_FINDING_SUMMARY = "A Compose-declared mount is absent from its exactly bound runtime container";
const COMPOSE_DECLARED_MOUNT_MISSING_FINDING_RECOMMENDATION = "Inspect the Compose mount declaration and the bound container's current mount configuration.";
const COMPOSE_DECLARED_MOUNT_EVIDENCE_SUMMARY = "Compose declared a mount for the bound service";
const DOCKER_COMPOSE_RUNTIME_BINDING_EVIDENCE_SUMMARY = "Docker confirmed an exact Compose project, service, and config binding";
const RUNTIME_IDENTITY_COLLISION_FINDING_RULE = "runtime.identity_collision_detected";
const RUNTIME_IDENTITY_COLLISION_FINDING_SUMMARY = "DockerMap detected duplicate runtime identities after publication normalization.";
const RUNTIME_IDENTITY_COLLISION_FINDING_RECOMMENDATION = "Review the duplicate identity condition before relying on topology relationships.";
const RUNTIME_IDENTITY_COLLISION_EVIDENCE_SUMMARY = "DockerMap detected duplicate runtime identities after publication normalization";

type FindingSummaryWire = {
  warningCount: number;
  advisoryCount: number;
  declaredDependencyCount: number;
  dockerDaemonAuthorityCount: number;
  hostPortPublicationCount: number;
  evidenceIntegrityCount: number;
};

const FINDING_SUMMARY_KEYS = [
  "warningCount",
  "advisoryCount",
  "declaredDependencyCount",
  "dockerDaemonAuthorityCount",
  "hostPortPublicationCount",
  "evidenceIntegrityCount",
] as const;

// This is deliberately a finite duplicate of core's FindingRule::category.
// A new rule has no browser path until both sides explicitly classify it.
const FINDING_RULE_CATEGORY = {
  [SYSTEMD_REQUIRES_FINDING_RULE]: "declaredDependencyCount",
  [INTERNAL_NETWORK_PORT_FINDING_RULE]: "hostPortPublicationCount",
  [UNSPECIFIED_ADDRESS_PORT_FINDING_RULE]: "hostPortPublicationCount",
  [DOCKER_DAEMON_STATE_FINDING_RULE]: "dockerDaemonAuthorityCount",
  [DOCKER_DAEMON_STATE_PUBLISHED_PORT_FINDING_RULE]: "hostPortPublicationCount",
  [COMPOSE_DECLARED_TARGET_NOT_ACTIVE_FINDING_RULE]: "declaredDependencyCount",
  [COMPOSE_MUTUAL_DEPENDENCY_FINDING_RULE]: "declaredDependencyCount",
  [COMPOSE_DECLARED_MOUNT_MISSING_FINDING_RULE]: "declaredDependencyCount",
  [RUNTIME_IDENTITY_COLLISION_FINDING_RULE]: "evidenceIntegrityCount",
} as const;

function coherentFindingSummary(value: unknown, findings: unknown[]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const summary = value as Record<string, unknown>;
  if (Object.keys(summary).length !== FINDING_SUMMARY_KEYS.length
    || !FINDING_SUMMARY_KEYS.every((key) => Object.hasOwn(summary, key))) return false;
  const expected: FindingSummaryWire = {
    warningCount: 0, advisoryCount: 0, declaredDependencyCount: 0,
    dockerDaemonAuthorityCount: 0, hostPortPublicationCount: 0, evidenceIntegrityCount: 0,
  };
  for (const candidate of findings) {
    if (!candidate || typeof candidate !== "object") return false;
    const finding = candidate as Record<string, unknown>;
    if (finding.severity === "warning") expected.warningCount += 1;
    else if (finding.severity === "advisory") expected.advisoryCount += 1;
    else return false;
    const category = typeof finding.ruleId === "string"
      ? FINDING_RULE_CATEGORY[finding.ruleId as keyof typeof FINDING_RULE_CATEGORY]
      : undefined;
    if (!category) return false;
    expected[category] += 1;
  }
  return FINDING_SUMMARY_KEYS.every((key) => (
    typeof summary[key] === "number"
    && Number.isSafeInteger(summary[key])
    && summary[key] >= 0
    && summary[key] === expected[key]
  ));
}

// Version-one evidence is intentionally a discriminated Docker observation,
// not a generic provenance bag. JSON Schema owns each field's closed enum;
// this small cross-field table binds an emitted fact to the relationship it
// can actually support. A later evidence version must add an explicit row.
const V1_EVIDENCE_EDGE = {
  docker_network_membership: { relationship: "connected_to", sourcePrefix: "docker_container_", targetPrefix: "docker_network_" },
  docker_volume_mount: { relationship: "mounts", sourcePrefix: "docker_container_", targetPrefix: "docker_volume_" },
  docker_port_publication: { relationship: "exposes", sourcePrefix: "docker_container_", targetPrefix: "network_listener_" },
  docker_unspecified_address_port_publication: { relationship: "exposes", sourcePrefix: "docker_container_", targetPrefix: "host_risk_docker_unspecified_address_port" },
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

// Version three is equally narrow: a package manifest declaration from the
// separately scheduled ProjectNpm slot.  It says nothing about installation,
// resolution, execution, or package safety.
const V3_EVIDENCE_EDGE = {
  npm_package_manifest_dependency: { relationship: "depends_on", sourcePrefix: "npm_project_", targetPrefix: "npm_package_" },
} as const;

// Version four is a parsed cron declaration from Cron's own scheduler slot.
// It makes no execution, successful-run, or host-health claim.
const V4_EVIDENCE_EDGE = {
  cron_schedule_declaration: { relationship: "runs_on", sourcePrefix: "scheduled_job_", targetPrefix: "host_", target: "host_local" },
} as const;

// Version five is a bounded observation from tmux's separately scheduled
// slot. It conveys only that tmux listed a local session: it is not an
// attachment, activity, reachability, or process-execution claim.
const V5_EVIDENCE_EDGE = {
  tmux_session_listing: { relationship: "runs_on", sourcePrefix: "tmux_session_", targetPrefix: "host_", target: "host_local" },
} as const;

const V7_EVIDENCE_EDGE = {
  runtime_identity_collision: { relationship: "related_to", sourcePrefix: "runtime_integrity_scope", targetPrefix: "runtime_integrity_risk_identity_collision", target: "runtime_integrity_risk_identity_collision" },
} as const;

// Keep the finding identity binding byte-for-byte aligned with core's
// `collision_resistant_id_component`: a readable slug plus SHA-256 of the
// untouched subject/target pair.  Finding IDs are not daemon-assigned labels.
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
  slug = slug.replace(/^-+|-+$/g, "");
  const readable = (slug || "identity").slice(0, 48);
  return `${readable}--${createHash("sha256").update(value).digest("hex")}`;
}

function composeDeclaredTargetFindingId(subjectRef: string, targetRef: string): string {
  return `finding_docker_compose_declared_target_not_active_${collisionResistantIdComponent(`${subjectRef}\u001f${targetRef}`)}`;
}

function daemonStatePublishedPortFindingId(subjectRef: string): string {
  return `finding_docker_daemon_state_bind_mount_publishes_port_${collisionResistantIdComponent(`${subjectRef}\u001fhost_risk_docker_daemon_state`)}`;
}

// Docker's bounded listener projection uses private/protocol for an
// un-published listener and host:private/protocol for a host binding. Keep
// this exact grammar at the browser boundary; a listener label or ID cannot
// substitute for the observed port metadata.
function isHostPublishedDockerPort(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const parts = value.split(":");
  if (parts.length !== 2) return false;
  const [host, privateAndProtocol] = parts;
  const privateParts = privateAndProtocol.split("/");
  if (privateParts.length !== 2) return false;
  const [privatePort, protocol] = privateParts;
  const isNonZeroPort = (port: string) => /^\d+$/.test(port) && Number(port) > 0 && Number(port) <= 65_535;
  return isNonZeroPort(host) && isNonZeroPort(privatePort) && (protocol === "tcp" || protocol === "udp" || protocol === "sctp");
}

// Tmux may never turn a daemon-owned session name or title into browser data.
// The public node shape is deliberately one fixed label, no status claim, and
// the one service taxonomy tag needed by the shared runtime contract.
function isCoherentTmuxSessionNode(value: Record<string, unknown>): boolean {
  const metadata = value.metadata;
  return value.provider === "tmux"
    && value.type === "tmux_session"
    && value.label === "tmux session"
    && (value.status === null || value.status === undefined)
    && value.layer === "session"
    && (value.service === null || value.service === undefined)
    && (value.package === null || value.package === undefined)
    && metadata !== null
    && typeof metadata === "object"
    && !Array.isArray(metadata)
    && Object.keys(metadata).length === 1
    && (metadata as Record<string, unknown>).serviceEntityKind === "session";
}

function composeMutualDependencyFindingId(subjectRef: string, targetRef: string): string {
  return `finding_docker_compose_mutual_dependency_${collisionResistantIdComponent(`${subjectRef}\u001f${targetRef}`)}`;
}

// Core derives this identity from private Compose/Docker material. Keep that
// material opaque, while requiring each public ID to have its fixed digest
// shape and the finding/evidence IDs to carry one shared digest.
function isOpaqueComposeRuntimeBindingId(value: unknown): value is string {
  return typeof value === "string" && /^compose_runtime_binding_[a-f0-9]{64}$/.test(value);
}

function composeMountFindingDigest(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^finding_compose_declared_mount_missing_at_bound_container_([a-f0-9]{64})$/.exec(value);
  return match?.[1] ?? null;
}

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

type RuntimeEvidenceDiagnostic =
  | "runtime_evidence_edge_shape"
  | "runtime_evidence_base_tuple"
  | "runtime_evidence_edge_binding"
  | "runtime_evidence_source_binding"
  | "runtime_evidence_daemon_state_target"
  | "runtime_evidence_port_listener_missing"
  | "runtime_evidence_port_listener_ambiguous"
  | "runtime_evidence_port_listener_shape"
  | "runtime_evidence_port_listener_grammar"
  | "runtime_evidence_tmux_session_shape"
  | "runtime_evidence_revision";

// This returns only a fixed category for container-internal E2E diagnostics.
// It must never contain daemon-supplied text, IDs, paths, or metadata values.
function runtimeEvidenceDiagnostic(payload: unknown): RuntimeEvidenceDiagnostic | null {
  if (!payload || typeof payload !== "object") return "runtime_evidence_edge_shape";
  const nodes = (payload as { nodes?: unknown }).nodes;
  const edges = (payload as { edges?: unknown }).edges;
  if (!Array.isArray(nodes) || !Array.isArray(edges)) return "runtime_evidence_edge_shape";
  // Only a V1 port-publication edge needs a node lookup. Keep ambiguity local
  // to that referenced listener rather than treating unrelated duplicate
  // provider nodes as an API contract violation.
  const nodesById = new Map<string, Record<string, unknown>[]>();
  for (const candidate of nodes) {
    if (!candidate || typeof candidate !== "object") return "runtime_evidence_edge_shape";
    const node = candidate as Record<string, unknown>;
    if (typeof node.id !== "string") return "runtime_evidence_edge_shape";
    const sameId = nodesById.get(node.id);
    if (sameId) sameId.push(node);
    else nodesById.set(node.id, [node]);
  }
  for (const edge of edges) {
    if (!edge || typeof edge !== "object") return "runtime_evidence_edge_shape";
    const candidate = edge as { source?: unknown; target?: unknown; relationship?: unknown; evidenceRefs?: unknown };
    if (!Array.isArray(candidate.evidenceRefs)) return "runtime_evidence_edge_shape";
    for (const evidence of candidate.evidenceRefs) {
      if (!evidence || typeof evidence !== "object") return "runtime_evidence_edge_shape";
      const value = evidence as {
        version?: unknown; provider?: unknown; kind?: unknown; assertionKind?: unknown;
        freshness?: unknown; providerRevision?: unknown; collectedAt?: unknown; subjectRef?: unknown;
        providerSlot?: unknown; summary?: unknown;
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
      const isV3 = value.version === 3
        && value.provider === "npm"
        && value.assertionKind === "declared"
        && value.providerSlot === "project_npm"
        && (value.freshness === "fresh" || value.freshness === "stale" || value.freshness === "timed_out");
      const isV4 = value.version === 4
        && value.provider === "cron"
        && value.assertionKind === "declared"
        && value.providerSlot === "cron"
        && (value.freshness === "fresh" || value.freshness === "stale" || value.freshness === "timed_out");
      const isV5 = value.version === 5
        && value.provider === "tmux"
        && value.assertionKind === "observed"
        && value.providerSlot === "tmux"
        && (value.freshness === "fresh" || value.freshness === "stale" || value.freshness === "timed_out");
      const isV7 = value.version === 7
        && value.provider === "dockermap"
        && value.assertionKind === "observed"
        && value.freshness === "fresh"
        && (value.providerSlot === null || value.providerSlot === undefined);
      if (!isV1 && !isV2 && !isV3 && !isV4 && !isV5 && !isV7) return "runtime_evidence_base_tuple";
      const expected = typeof value.kind === "string"
        ? (isV1
          ? V1_EVIDENCE_EDGE[value.kind as keyof typeof V1_EVIDENCE_EDGE]
          : isV2
            ? V2_EVIDENCE_EDGE[value.kind as keyof typeof V2_EVIDENCE_EDGE]
            : isV3
              ? V3_EVIDENCE_EDGE[value.kind as keyof typeof V3_EVIDENCE_EDGE]
              : isV4
                ? V4_EVIDENCE_EDGE[value.kind as keyof typeof V4_EVIDENCE_EDGE]
                : isV5
                  ? V5_EVIDENCE_EDGE[value.kind as keyof typeof V5_EVIDENCE_EDGE]
                  : V7_EVIDENCE_EDGE[value.kind as keyof typeof V7_EVIDENCE_EDGE])
        : undefined;
      if (!expected || candidate.relationship !== expected.relationship || typeof candidate.source !== "string" || typeof candidate.target !== "string") return "runtime_evidence_edge_binding";
      if (value.subjectRef !== candidate.source || !candidate.source.startsWith(expected.sourcePrefix) || !candidate.target.startsWith(expected.targetPrefix) || candidate.source === candidate.target) return "runtime_evidence_source_binding";
      if ((isV4 || isV5) && candidate.target !== "host_local") return "runtime_evidence_edge_binding";
      if (isV7 && (candidate.target !== "runtime_integrity_risk_identity_collision"
        || value.summary !== RUNTIME_IDENTITY_COLLISION_EVIDENCE_SUMMARY)) return "runtime_evidence_edge_binding";
      if (isV7) {
        const scope = nodesById.get("runtime_integrity_scope");
        const risk = nodesById.get("runtime_integrity_risk_identity_collision");
        const isFixedNode = (node: Record<string, unknown>, type: string, label: string) => (
          node.provider === "other" && node.type === type && node.label === label
          && (node.status === null || node.status === undefined)
          && node.layer === "advisory"
          && node.metadata !== null && typeof node.metadata === "object"
          && !Array.isArray(node.metadata) && Object.keys(node.metadata as Record<string, unknown>).length === 0
          && (node.service === null || node.service === undefined)
          && (node.package === null || node.package === undefined)
        );
        if (!scope || scope.length !== 1 || !risk || risk.length !== 1
          || !isFixedNode(scope[0], "integrity_scope", "Runtime identity integrity")
          || !isFixedNode(risk[0], "host_risk", "Duplicate runtime topology identity")) return "runtime_evidence_edge_binding";
        if (typeof value.providerRevision !== "string" || !/^[a-f0-9]{32}-[1-9][0-9]*$/.test(value.providerRevision)) return "runtime_evidence_revision";
      }
      if (value.kind === "docker_daemon_state_bind_mount" && candidate.target !== "host_risk_docker_daemon_state") return "runtime_evidence_daemon_state_target";
      if (value.kind === "docker_unspecified_address_port_publication" && candidate.target !== "host_risk_docker_unspecified_address_port") return "runtime_evidence_edge_binding";
      if (value.kind === "docker_unspecified_address_port_publication"
        && value.summary !== UNSPECIFIED_ADDRESS_PORT_EVIDENCE_SUMMARY) return "runtime_evidence_edge_binding";
      if (value.kind === "docker_port_publication") {
        const listeners = nodesById.get(candidate.target);
        if (!listeners) return "runtime_evidence_port_listener_missing";
        const listener = listeners[0];
        if (listener.provider !== "network" || listener.type !== "network_listener"
          || !listener.metadata || typeof listener.metadata !== "object") return "runtime_evidence_port_listener_shape";
        const metadata = listener.metadata as Record<string, unknown>;
        const port = metadata.port;
        if (!isHostPublishedDockerPort(port)) return "runtime_evidence_port_listener_grammar";
        // Duplicate provider records are tolerable only when they carry the
        // exact same closed listener fact. Do not silently choose one record
        // when a duplicate differs in listener identity, state, or metadata.
        if (!listeners.every((candidateListener) => {
          const candidateMetadata = candidateListener.metadata;
          return candidateListener.provider === "network"
            && candidateListener.type === "network_listener"
            && candidateListener.label === listener.label
            && candidateListener.status === listener.status
            && candidateListener.layer === listener.layer
            && (candidateListener.service === null || candidateListener.service === undefined)
            && (candidateListener.package === null || candidateListener.package === undefined)
            && candidateMetadata && typeof candidateMetadata === "object"
            && Object.keys(candidateMetadata).length === 1
            && (candidateMetadata as Record<string, unknown>).port === port
            && isHostPublishedDockerPort((candidateMetadata as Record<string, unknown>).port);
        })) return "runtime_evidence_port_listener_ambiguous";
      }
      if (isV5) {
        const sessions = nodesById.get(candidate.source);
        if (!sessions || sessions.length !== 1 || !isCoherentTmuxSessionNode(sessions[0])) {
          return "runtime_evidence_tmux_session_shape";
        }
      }
      // An opaque observation token must never be the collection timestamp
      // re-labelled as a revision. The daemon produces it independently.
      if (typeof value.providerRevision !== "string" || value.providerRevision === String(value.collectedAt)) return "runtime_evidence_revision";
    }
  }
  return null;
}

// Findings are a deliberately tiny conclusion vocabulary, not a daemon-supplied
// diagnostics channel. The generated schema owns field shape; this exact rule
// table prevents a compromised daemon from inventing mutable claims or copying
// arbitrary strings through the new endpoint.
function hasCoherentFindings(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const findings = (payload as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return false;
  if (!coherentFindingSummary((payload as { summary?: unknown }).summary, findings)) return false;
  return findings.every((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const finding = candidate as Record<string, unknown>;
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
    if (finding.ruleId === DOCKER_DAEMON_STATE_PUBLISHED_PORT_FINDING_RULE) return finding.severity === "warning"
      && finding.summary === DOCKER_DAEMON_STATE_PUBLISHED_PORT_FINDING_SUMMARY
      && finding.recommendation === DOCKER_DAEMON_STATE_PUBLISHED_PORT_FINDING_RECOMMENDATION
      && typeof finding.subjectRef === "string"
      && finding.subjectRef.startsWith("docker_container_")
      && finding.targetRef === "host_risk_docker_daemon_state"
      && finding.id === daemonStatePublishedPortFindingId(finding.subjectRef)
      && Array.isArray(finding.evidenceRefs)
      && finding.evidenceRefs.length === 2
      && (() => {
        const [daemonState, port] = finding.evidenceRefs;
        if (!daemonState || typeof daemonState !== "object" || !port || typeof port !== "object") return false;
        const daemonEvidence = daemonState as Record<string, unknown>;
        const portEvidence = port as Record<string, unknown>;
        const isFreshDockerEvidence = (evidence: Record<string, unknown>, kind: string, summary: string) => evidence.version === 1
          && evidence.provider === "docker"
          && evidence.kind === kind
          && evidence.assertionKind === "observed"
          && evidence.summary === summary
          && evidence.subjectRef === finding.subjectRef
          && (evidence.providerSlot === undefined || evidence.providerSlot === null)
          && evidence.freshness === "fresh"
          && typeof evidence.providerRevision === "string"
          && evidence.providerRevision !== String(evidence.collectedAt);
        return isFreshDockerEvidence(daemonEvidence, "docker_daemon_state_bind_mount", "Docker reported a bind mount exposing Docker daemon state")
          && isFreshDockerEvidence(portEvidence, "docker_port_publication", "Docker reported container port publication")
          && daemonEvidence.collectedAt === portEvidence.collectedAt
          && daemonEvidence.providerRevision === portEvidence.providerRevision;
      })();
    if (finding.ruleId === COMPOSE_DECLARED_TARGET_NOT_ACTIVE_FINDING_RULE) return finding.severity === "advisory"
      && finding.summary === COMPOSE_DECLARED_TARGET_NOT_ACTIVE_FINDING_SUMMARY
      && finding.recommendation === COMPOSE_DECLARED_TARGET_NOT_ACTIVE_FINDING_RECOMMENDATION
      && typeof finding.subjectRef === "string"
      && finding.subjectRef.startsWith("docker_container_")
      && typeof finding.targetRef === "string"
      && finding.targetRef.startsWith("docker_container_")
      && finding.subjectRef !== finding.targetRef
      && finding.id === composeDeclaredTargetFindingId(finding.subjectRef, finding.targetRef)
      && Array.isArray(finding.evidenceRefs)
      && finding.evidenceRefs.length === 1
      && (() => {
        const candidateEvidence = finding.evidenceRefs[0];
        if (!candidateEvidence || typeof candidateEvidence !== "object") return false;
        const evidence = candidateEvidence as Record<string, unknown>;
        return evidence.version === 1
          && evidence.provider === "docker"
          && evidence.kind === "docker_compose_depends_on"
          && evidence.assertionKind === "observed"
          && evidence.summary === "Docker recorded Compose dependency declaration"
          && evidence.subjectRef === finding.subjectRef
          && (evidence.providerSlot === undefined || evidence.providerSlot === null)
          && evidence.freshness === "fresh"
          && typeof evidence.providerRevision === "string"
          && evidence.providerRevision !== String(evidence.collectedAt);
      })();
    if (finding.ruleId === COMPOSE_MUTUAL_DEPENDENCY_FINDING_RULE) return finding.severity === "advisory"
      && finding.summary === COMPOSE_MUTUAL_DEPENDENCY_FINDING_SUMMARY
      && finding.recommendation === COMPOSE_MUTUAL_DEPENDENCY_FINDING_RECOMMENDATION
      && typeof finding.subjectRef === "string"
      && finding.subjectRef.startsWith("docker_container_")
      && typeof finding.targetRef === "string"
      && finding.targetRef.startsWith("docker_container_")
      && finding.subjectRef < finding.targetRef
      && finding.id === composeMutualDependencyFindingId(finding.subjectRef, finding.targetRef)
      && Array.isArray(finding.evidenceRefs)
      && finding.evidenceRefs.length === 2
      && (() => {
        const [forwardCandidate, reverseCandidate] = finding.evidenceRefs;
        if (!forwardCandidate || typeof forwardCandidate !== "object" || !reverseCandidate || typeof reverseCandidate !== "object") return false;
        const forward = forwardCandidate as Record<string, unknown>;
        const reverse = reverseCandidate as Record<string, unknown>;
        const isCanonicalComposeEvidence = (evidence: Record<string, unknown>, sourceRef: string) => (
          evidence.version === 1
          && evidence.provider === "docker"
          && evidence.kind === "docker_compose_depends_on"
          && evidence.assertionKind === "observed"
          && evidence.summary === "Docker recorded Compose dependency declaration"
          && evidence.subjectRef === sourceRef
          && (evidence.providerSlot === undefined || evidence.providerSlot === null)
          && evidence.freshness === "fresh"
          && typeof evidence.collectedAt === "number"
          && typeof evidence.providerRevision === "string"
          && evidence.providerRevision !== String(evidence.collectedAt)
        );
        return isCanonicalComposeEvidence(forward, finding.subjectRef)
          && isCanonicalComposeEvidence(reverse, finding.targetRef)
          && forward.collectedAt === reverse.collectedAt
          && forward.providerRevision === reverse.providerRevision;
      })();
    if (finding.ruleId === COMPOSE_DECLARED_MOUNT_MISSING_FINDING_RULE) {
      const digest = composeMountFindingDigest(finding.id);
      return finding.severity === "warning"
        && finding.summary === COMPOSE_DECLARED_MOUNT_MISSING_FINDING_SUMMARY
        && finding.recommendation === COMPOSE_DECLARED_MOUNT_MISSING_FINDING_RECOMMENDATION
        && digest !== null
        && isOpaqueComposeRuntimeBindingId(finding.subjectRef)
        // This is one opaque structural binding, not a relationship between
        // public services. Equal refs ensure a daemon cannot substitute a
        // separately supplied target identity.
        && finding.targetRef === finding.subjectRef
        && Array.isArray(finding.evidenceRefs)
        && finding.evidenceRefs.length === 2
        && (() => {
          const [declaredCandidate, bindingCandidate] = finding.evidenceRefs;
          if (!declaredCandidate || typeof declaredCandidate !== "object" || !bindingCandidate || typeof bindingCandidate !== "object") return false;
          const declared = declaredCandidate as Record<string, unknown>;
          const binding = bindingCandidate as Record<string, unknown>;
          const isV6Evidence = (
            evidence: Record<string, unknown>, provider: string, kind: string,
            assertionKind: string, summary: string, idPrefix: string,
          ) => evidence.version === 6
            && evidence.provider === provider
            && evidence.kind === kind
            && evidence.assertionKind === assertionKind
            && evidence.summary === summary
            && evidence.id === `${idPrefix}_${digest}`
            && evidence.subjectRef === finding.subjectRef
            && (evidence.providerSlot === undefined || evidence.providerSlot === null)
            && evidence.freshness === "fresh"
            && typeof evidence.collectedAt === "number"
            && Number.isSafeInteger(evidence.collectedAt)
            && evidence.collectedAt >= 0
            && typeof evidence.providerRevision === "string"
            && evidence.providerRevision.length > 0
            && evidence.providerRevision !== String(evidence.collectedAt);
          return isV6Evidence(declared, "compose", "compose_declared_mount", "declared", COMPOSE_DECLARED_MOUNT_EVIDENCE_SUMMARY, "compose_declared_mount")
            && isV6Evidence(binding, "docker", "docker_compose_runtime_binding", "observed", DOCKER_COMPOSE_RUNTIME_BINDING_EVIDENCE_SUMMARY, "docker_compose_runtime_binding")
            && declared.collectedAt === binding.collectedAt
            && declared.providerRevision === binding.providerRevision;
        })();
    }
    if (finding.ruleId === RUNTIME_IDENTITY_COLLISION_FINDING_RULE) return finding.severity === "advisory"
      && finding.id === "finding_runtime_identity_collision_detected"
      && finding.summary === RUNTIME_IDENTITY_COLLISION_FINDING_SUMMARY
      && finding.recommendation === RUNTIME_IDENTITY_COLLISION_FINDING_RECOMMENDATION
      && finding.subjectRef === "runtime_integrity_scope"
      && finding.targetRef === "runtime_integrity_risk_identity_collision"
      && Array.isArray(finding.evidenceRefs)
      && finding.evidenceRefs.length === 1
      && (() => {
        const candidateEvidence = finding.evidenceRefs[0];
        if (!candidateEvidence || typeof candidateEvidence !== "object") return false;
        const evidence = candidateEvidence as Record<string, unknown>;
        return evidence.version === 7
          && evidence.id === "dockermap_evidence_runtime_identity_collision"
          && evidence.provider === "dockermap"
          && evidence.kind === "runtime_identity_collision"
          && evidence.assertionKind === "observed"
          && evidence.summary === RUNTIME_IDENTITY_COLLISION_EVIDENCE_SUMMARY
          && evidence.subjectRef === finding.subjectRef
          && (evidence.providerSlot === null || evidence.providerSlot === undefined)
          && evidence.freshness === "fresh"
          && typeof evidence.collectedAt === "number"
          && Number.isSafeInteger(evidence.collectedAt) && evidence.collectedAt >= 0
          && typeof evidence.providerRevision === "string"
          && /^[a-f0-9]{32}-[1-9][0-9]*$/.test(evidence.providerRevision)
          && evidence.providerRevision !== String(evidence.collectedAt);
      })();
    if (finding.ruleId === UNSPECIFIED_ADDRESS_PORT_FINDING_RULE) return finding.severity === "advisory"
      && finding.summary === UNSPECIFIED_ADDRESS_PORT_FINDING_SUMMARY
      && finding.recommendation === UNSPECIFIED_ADDRESS_PORT_FINDING_RECOMMENDATION
      && typeof finding.id === "string"
      && finding.id.startsWith("finding_docker_port_published_on_unspecified_address_")
      && typeof finding.subjectRef === "string"
      && finding.subjectRef.startsWith("docker_container_")
      && finding.targetRef === "host_risk_docker_unspecified_address_port"
      && Array.isArray(finding.evidenceRefs)
      && finding.evidenceRefs.length === 1
      && (() => {
        const candidateEvidence = finding.evidenceRefs[0];
        if (!candidateEvidence || typeof candidateEvidence !== "object") return false;
        const evidence = candidateEvidence as Record<string, unknown>;
        // V1 Docker facts predate the explicit null slot in some daemon
        // responses. Both spellings represent the Docker-wide collector;
        // no named slot is admissible at this browser boundary.
        return evidence.version === 1
          && evidence.provider === "docker"
          && evidence.kind === "docker_unspecified_address_port_publication"
          && evidence.assertionKind === "observed"
          && evidence.summary === UNSPECIFIED_ADDRESS_PORT_EVIDENCE_SUMMARY
          && evidence.subjectRef === finding.subjectRef
          && (evidence.providerSlot === undefined || evidence.providerSlot === null)
          && evidence.freshness === "fresh"
          && typeof evidence.collectedAt === "number"
          && Number.isSafeInteger(evidence.collectedAt)
          && evidence.collectedAt >= 0
          && typeof evidence.providerRevision === "string"
          && evidence.providerRevision.length > 0
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
  constructor(
    readonly schema: RustResponseSchemaId | "unknown",
    readonly reason: "schema" | "provider_state_vector" | "provider_freshness" | RuntimeEvidenceDiagnostic | "findings",
  ) {
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
  if (!validator || !validator(payload)) throw new DaemonResponseValidationError(schema ?? "unknown", "schema");
  if (schema === "RuntimeMap") {
    if (!hasCompleteProviderStateVector(payload)) throw new DaemonResponseValidationError(schema, "provider_state_vector");
    if (!hasCoherentProviderFreshness(payload)) throw new DaemonResponseValidationError(schema, "provider_freshness");
    const evidenceDiagnostic = runtimeEvidenceDiagnostic(payload);
    if (evidenceDiagnostic) throw new DaemonResponseValidationError(schema, evidenceDiagnostic);
  }
  if (schema === "FindingsResponse" && !hasCoherentFindings(payload)) throw new DaemonResponseValidationError(schema, "findings");
  return payload;
}
