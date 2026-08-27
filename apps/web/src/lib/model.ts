import type {
  ContainerRecord,
  DockerSnapshot,
  ImageRecord,
  NetworkRecord,
  RuntimeMap,
  RuntimeMapDiagnostic,
  RuntimeMapEdge,
  RuntimeMapNode,
  RuntimeProviderKind,
  VolumeRecord
} from "@dockermap/contracts";

/**
 * The domain model is the heart of DockerMap. It translates Docker primitives
 * (containers, networks, volumes, edges) into the mental model the product is
 * built around: Services, Relationships, State, and Impact.
 *
 * Nothing above this layer should reason about "containers" — it thinks in
 * services and how they connect.
 */

export type ServiceState =
  | "healthy"
  | "warning"
  | "degraded"
  | "offline"
  | "updating"
  | "unknown";

export const SERVICE_STATES: ServiceState[] = [
  "healthy",
  "warning",
  "degraded",
  "offline",
  "updating",
  "unknown"
];

/** A service kind drives the icon and visual treatment on the map. */
export type ServiceKind = "proxy" | "api" | "worker" | "database" | "cache" | "service";

export type RelationshipKind = "depends_on" | "connected" | "data";
export type RelationshipHealth = "healthy" | "slow" | "failing" | "unknown";

export interface Relationship {
  id: string;
  /** The dependent service (it needs `to`). */
  from: string;
  /** The provider service (depended upon). */
  to: string;
  kind: RelationshipKind;
  health: RelationshipHealth;
}

/**
 * One RAW depends_on occurrence exactly as recorded in the snapshot. The
 * reference may be a container id, container name, or compose service name
 * (role), and may be empty, redaction-collided, or unknown. Every occurrence
 * stays visible in relationship lists as non-routable evidence; only
 * `resolvedId` values (unique, non-empty resolutions) enter the semantic
 * graph (dependsOn edges, dependents, impact traversal).
 */
export interface DependencyOccurrence {
  /** The raw reference verbatim from the snapshot (may be "" or ambiguous). */
  ref: string;
  /** Collision-safe resolved service id, or null when unresolvable. */
  resolvedId: string | null;
}

export interface Service {
  id: string;
  name: string;
  kind: ServiceKind;
  role: string;
  image: string;
  imageRepo: string;
  imageTag: string;
  status: string;
  state: ServiceState;
  ports: string[];
  networks: string[];
  mounts: ContainerRecord["mounts"];
  /**
   * Raw dependency occurrences (unfiltered). Ambiguous/empty/unresolved
   * occurrences are preserved here so renderers can show them as visible
   * non-routable evidence instead of silently discarding the relationship.
   */
  dependencyOccurrences: DependencyOccurrence[];
  /** Services this one depends on (upstream), resolved collision-safe only. */
  dependsOn: string[];
  /** Services that depend on this one (downstream). */
  dependents: string[];
}

export interface SystemModel {
  services: Service[];
  relationships: Relationship[];
  networks: NetworkRecord[];
  volumes: VolumeRecord[];
  images: ImageRecord[];
  runtime: RuntimeModel;
  byId: Map<string, Service>;
  byName: Map<string, Service>;
  serviceIdCollisions: Set<string>;
  serviceNameCollisions: Set<string>;
  serviceAliasCollisions: Set<string>;
  networkByName: Map<string, NetworkRecord>;
  volumeByName: Map<string, VolumeRecord>;
  imageByRef: Map<string, ImageRecord>;
  /**
   * Identity keys that MORE THAN ONE record sanitized to after publication
   * redaction (e.g. two distinct networks both published as "[redacted]").
   * Collided keys are absent from the maps above so a lookup can never route
   * to the wrong record; lists render them as plain non-routable text and
   * detail routes show a collision state instead.
   */
  networkNameCollisions: Set<string>;
  volumeNameCollisions: Set<string>;
  imageRefCollisions: Set<string>;
  lastUpdated: number;
}

export type RuntimeLayerId = NonNullable<RuntimeMapNode["layer"]> | "unassigned";

export interface RuntimeNodeRecord {
  id: string;
  provider: RuntimeProviderKind;
  type: RuntimeMapNode["type"];
  label: string;
  status: RuntimeMapNode["status"];
  layer: RuntimeLayerId;
  metadata: RuntimeMapNode["metadata"];
  service?: RuntimeMapNode["service"];
  package?: RuntimeMapNode["package"];
  state: ServiceState;
  incoming: RuntimeMapEdge[];
  outgoing: RuntimeMapEdge[];
}

export interface RuntimeBucketSummary<T extends string> {
  id: T;
  count: number;
  attention: number;
}

export interface RuntimeSummary {
  totalNodes: number;
  serviceNodes: number;
  providers: number;
  layers: number;
  diagnostics: number;
  attention: number;
}

export interface RuntimeModel {
  nodes: RuntimeNodeRecord[];
  edges: RuntimeMapEdge[];
  diagnostics: RuntimeMapDiagnostic[];
  byId: Map<string, RuntimeNodeRecord>;
  idCollisions: Set<string>;
  providerSummary: RuntimeBucketSummary<RuntimeProviderKind>[];
  layerSummary: RuntimeBucketSummary<RuntimeLayerId>[];
  summary: RuntimeSummary;
  lastUpdated: number;
}

export interface SystemSummary {
  total: number;
  healthy: number;
  warning: number;
  degraded: number;
  offline: number;
  updating: number;
  unknown: number;
  attention: number;
}

export interface ImpactResult {
  /** Everything the selected service relies on (transitive). */
  upstream: string[];
  /** Everything that would be affected if the selected service failed. */
  downstream: string[];
  /** Direct relationships only, for fast hover highlighting. */
  neighbors: Set<string>;
}

const STATE_BY_STATUS: Record<string, ServiceState> = {
  running: "healthy",
  up: "healthy",
  healthy: "healthy",
  paused: "warning",
  restarting: "updating",
  created: "updating",
  starting: "updating",
  removing: "updating",
  exited: "offline",
  dead: "offline",
  stopped: "offline",
  down: "offline",
  unhealthy: "degraded",
  degraded: "degraded"
};

export function stateForStatus(status: string | null | undefined): ServiceState {
  if (!status) return "unknown";
  const key = status.toLowerCase().split(/\s|\(/)[0];
  return STATE_BY_STATUS[key] ?? "unknown";
}

/** True when the state warrants the operator's attention. */
export function needsAttention(state: ServiceState): boolean {
  return state === "warning" || state === "degraded" || state === "offline";
}

function classifyKind(container: ContainerRecord): ServiceKind {
  const role = container.role.toLowerCase();
  const image = container.image.toLowerCase();
  if (/postgres|mysql|mariadb|mongo|database|^db/.test(role + " " + image)) return "database";
  if (/redis|memcached|cache|broker|queue/.test(role + " " + image)) return "cache";
  if (/nginx|caddy|traefik|proxy|gateway|edge/.test(role + " " + image)) return "proxy";
  if (/worker|job|cron|scheduler/.test(role + " " + image)) return "worker";
  if (/api|server|backend|http/.test(role + " " + image)) return "api";
  return "service";
}

function splitImage(image: string): { repo: string; tag: string } {
  const at = image.indexOf("@");
  const base = at >= 0 ? image.slice(0, at) : image;
  const lastColon = base.lastIndexOf(":");
  const lastSlash = base.lastIndexOf("/");
  if (lastColon > lastSlash) {
    return { repo: base.slice(0, lastColon), tag: base.slice(lastColon + 1) };
  }
  return { repo: base, tag: at >= 0 ? image.slice(at + 1, at + 13) : "latest" };
}

/** Stable hash → used by stub generators so derived data never flickers. */
export function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

function compareNetworks(left: NetworkRecord, right: NetworkRecord): number {
  return left.id.localeCompare(right.id)
    || left.name.localeCompare(right.name)
    || left.driver.localeCompare(right.driver)
    || Number(left.internal) - Number(right.internal)
    || left.members.join("\u0000").localeCompare(right.members.join("\u0000"));
}

function compareVolumes(left: VolumeRecord, right: VolumeRecord): number {
  return left.id.localeCompare(right.id)
    || left.name.localeCompare(right.name)
    || left.attachedTo.join("\u0000").localeCompare(right.attachedTo.join("\u0000"));
}

function compareMounts(left: ContainerRecord["mounts"][number], right: ContainerRecord["mounts"][number]): number {
  return left.id.localeCompare(right.id)
    || left.kind.localeCompare(right.kind)
    || (left.source ?? "").localeCompare(right.source ?? "")
    || left.target.localeCompare(right.target)
    || Number(left.readOnly) - Number(right.readOnly);
}

function compareMountLists(left: ContainerRecord["mounts"], right: ContainerRecord["mounts"]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const comparison = compareMounts(left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function canonicalContainer(container: ContainerRecord): ContainerRecord {
  return {
    ...container,
    networks: [...container.networks].sort(),
    ports: [...container.ports].sort(),
    mounts: [...container.mounts].sort(compareMounts),
    dependsOn: [...container.dependsOn].sort()
  };
}

function compareContainers(left: ContainerRecord, right: ContainerRecord): number {
  return left.id.localeCompare(right.id)
    || left.name.localeCompare(right.name)
    || left.role.localeCompare(right.role)
    || left.image.localeCompare(right.image)
    || left.status.localeCompare(right.status)
    || left.networks.join("\u0000").localeCompare(right.networks.join("\u0000"))
    || left.ports.join("\u0000").localeCompare(right.ports.join("\u0000"))
    || compareMountLists(left.mounts, right.mounts)
    || left.dependsOn.join("\u0000").localeCompare(right.dependsOn.join("\u0000"));
}

export function buildModel(snapshot: DockerSnapshot, runtimeMap: RuntimeMap): SystemModel {
  // Docker list endpoints do not promise presentation order. Canonicalize every
  // Docker collection used by routing or layout so equivalent refreshes cannot
  // move cards, selection targets, or force-layout seeds.
  const containers = snapshot.containers.map(canonicalContainer).sort(compareContainers);
  const networks = [...snapshot.networks].sort(compareNetworks);
  const volumes = [...snapshot.volumes].sort(compareVolumes);
  const canonicalSnapshot = { ...snapshot, containers, networks, volumes };

  // Network ids are engine-unique, so this plain id→name map is unambiguous:
  // a duplicate id resolves to the FIRST record's name so Service.networks
  // stays consistent with the name indexes (a last-wins `new Map(...)` would
  // leave containers pointing at a name that misses networkByName). Unlike
  // this id map, the NAME routing indexes below (networkByName,
  // volumeByName, imageByRef) are collision-safe — see buildIdentityIndex.
  const networkNameById = new Map<string, string>();
  for (const n of networks) {
    if (n.id !== "" && !networkNameById.has(n.id)) networkNameById.set(n.id, n.name);
  }

  // dependsOn references can be container ids, container names, or compose
  // service names (the container's role — com.docker.compose.service label);
  // normalise all of them to ids so live depends_on edges resolve even when
  // names are project-prefixed (`immich_redis` vs role `redis`). Ownership is
  // tracked PER RECORD OCCURRENCE: two records sharing a canonical id are two
  // owners, so no alias of either may ever resolve. Aliases of a record whose
  // canonical id collides are invalidated too — resolving to either occurrence
  // would be ambiguous even when the alias string itself is unique.
  const { index: idByAlias, collisions: serviceAliasCollisions } = buildAliasIndex(
    canonicalSnapshot.containers,
    (container) => [container.id, container.name, container.id.replace(/^container_/, ""), container.role],
    (container) => container.id
  );

  const resolveDependency = (ref: string): string | null => {
    // Fail closed: only aliases that resolve UNIQUELY through the index become
    // semantic edges. Unknown refs (including any `container_*` id no record
    // owns) and collided aliases stay null — they never enter dependsOn,
    // dependents, or the relationship graph.
    if (ref === "") return null;
    return idByAlias.get(ref) ?? null;
  };

  // A semantic dependency edge requires BOTH endpoints to be unique AND
  // non-empty. resolveDependency already fails closed on the TARGET (collided
  // aliases and empty refs stay null); the SOURCE (this record's canonical
  // id) needs the same guarantee: two records sharing a collided id are two
  // DISTINCT occurrences, so an edge attributed to that id would attach to an
  // arbitrary one (the layout springs to the FIRST occurrence) and inflate
  // dependents/impact with the wrong identity.
  const sourceIdCounts = new Map<string, number>();
  for (const c of canonicalSnapshot.containers) {
    if (c.id === "") continue;
    sourceIdCounts.set(c.id, (sourceIdCounts.get(c.id) ?? 0) + 1);
  }
  const collidedSourceIds = new Set<string>();
  for (const [id, count] of sourceIdCounts) {
    if (count > 1) collidedSourceIds.add(id);
  }
  const isSemanticSource = (id: string) => id !== "" && !collidedSourceIds.has(id);

  const dependents = new Map<string, Set<string>>();
  for (const c of canonicalSnapshot.containers) {
    // Only resolved ids feed the semantic dependents sets; raw occurrences
    // (empty, collided, or unknown refs) are preserved per service below.
    // A collided/empty SOURCE cannot be attributed to one occurrence, so it
    // never enters the dependents sets either.
    if (!isSemanticSource(c.id)) continue;
    for (const dep of c.dependsOn) {
      const target = resolveDependency(dep);
      if (target === null) continue;
      if (!dependents.has(target)) dependents.set(target, new Set());
      dependents.get(target)!.add(c.id);
    }
  }

  const services: Service[] = canonicalSnapshot.containers.map((c) => {
    const { repo, tag } = splitImage(c.image);
    const semantic = isSemanticSource(c.id);
    // Raw occurrences stay visible as non-routable evidence; resolvedId is
    // collision-safe on BOTH ends — a collided/empty source leaves the target
    // resolution null too (occurrence-qualified), so no semantic join can
    // silently attach the wrong occurrence.
    const occurrences: DependencyOccurrence[] = c.dependsOn.map((dep) => ({
      ref: dep,
      resolvedId: semantic ? resolveDependency(dep) : null
    }));
    return {
      id: c.id,
      name: c.name,
      kind: classifyKind(c),
      role: c.role,
      image: c.image,
      imageRepo: repo,
      imageTag: tag,
      status: c.status,
      state: stateForStatus(c.status),
      ports: c.ports,
      networks: c.networks.map((n) => networkNameById.get(n) ?? n.replace(/^network_/, "")),
      mounts: c.mounts,
      dependencyOccurrences: occurrences,
      dependsOn: semantic ? occurrences.filter((o): o is DependencyOccurrence & { resolvedId: string } => o.resolvedId !== null).map((o) => o.resolvedId) : [],
      dependents: [...(dependents.get(c.id) ?? [])]
    };
  });

  const { index: byId, collisions: serviceIdCollisions } = buildIdentityIndex(services, (service) => service.id);
  const { index: byName, collisions: serviceNameCollisions } = buildIdentityIndex(services, (service) => service.name);
  const { index: networkByName, collisions: networkNameCollisions } = buildIdentityIndex(networks, (network) => network.name);
  const { index: volumeByName, collisions: volumeNameCollisions } = buildIdentityIndex(volumes, (volume) => volume.name);
  const { index: imageByRef, collisions: imageRefCollisions } = buildIdentityIndex(snapshot.images, (image) => image.image);

  const relationships = buildRelationships(services, byId);
  const runtime = buildRuntimeModel(runtimeMap);

  return {
    services,
    relationships,
    networks,
    volumes,
    images: snapshot.images,
    runtime,
    byId,
    byName,
    serviceIdCollisions,
    serviceNameCollisions,
    serviceAliasCollisions,
    networkByName,
    volumeByName,
    imageByRef,
    networkNameCollisions,
    volumeNameCollisions,
    imageRefCollisions,
    lastUpdated: Math.max(snapshot.lastUpdated, runtime.lastUpdated)
  };
}

/**
 * Identity index for detail routing. The daemon redacts identity strings
 * before publication (`redact_docker_snapshot`), so DISTINCT records can
 * sanitize to the SAME display value (e.g. two networks both named
 * "[redacted]"). A first-wins map would keep only one record: the other
 * record's detail route would be unreachable and every link for the collided
 * value would open the WRONG record. Collided keys are therefore excluded
 * from the index entirely (lookup fails closed) and reported in `collisions`
 * so lists can render them as non-routable text and detail routes can show a
 * collision state instead of silently resolving to the first record. Empty
 * keys cannot route and are neither indexed nor collided (the screens already
 * render "Unavailable …" placeholders for them).
 */
function buildIdentityIndex<T>(records: T[], keyFor: (record: T) => string): { index: Map<string, T>; collisions: Set<string> } {
  const counts = new Map<string, number>();
  for (const record of records) {
    const key = keyFor(record);
    if (key === "") continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const index = new Map<string, T>();
  const collisions = new Set<string>();
  for (const record of records) {
    const key = keyFor(record);
    if (key === "") continue;
    if ((counts.get(key) ?? 0) > 1) {
      collisions.add(key);
      continue;
    }
    if (!index.has(key)) index.set(key, record);
  }
  return { index, collisions };
}

/**
 * Aliases resolve dependencies but are not always canonical identities.
 * Ownership is tracked by RECORD OCCURRENCE (the record's index), never by
 * the canonical id VALUE: two records sharing a canonical id occupy two
 * distinct occurrences, so they can never collapse into a single owner and
 * let an ambiguous alias resolve. An alias resolves only when exactly one
 * occurrence owns it AND that occurrence's canonical id is itself unique —
 * an alias of a duplicate-id record is invalidated even when the alias
 * string is unique, because the resolution target would be ambiguous.
 */
function buildAliasIndex<T>(
  records: T[],
  aliasesFor: (record: T) => string[],
  valueFor: (record: T) => string
): { index: Map<string, string>; collisions: Set<string> } {
  const owners = new Map<string, Set<number>>();
  records.forEach((record, occurrence) => {
    const value = valueFor(record);
    if (value === "") return;
    for (const alias of new Set(aliasesFor(record))) {
      if (alias === "") continue;
      const found = owners.get(alias) ?? new Set<number>();
      found.add(occurrence);
      owners.set(alias, found);
    }
  });

  // Canonical ids shared by more than one record: EVERY alias of those
  // records is ambiguous (either occurrence would be an arbitrary target).
  const collidedValues = new Set<string>();
  const valueCounts = new Map<string, number>();
  for (const record of records) {
    const value = valueFor(record);
    if (value === "") continue;
    valueCounts.set(value, (valueCounts.get(value) ?? 0) + 1);
  }
  for (const [value, count] of valueCounts) {
    if (count > 1) collidedValues.add(value);
  }

  const index = new Map<string, string>();
  const collisions = new Set<string>();
  for (const [alias, occurrences] of owners) {
    if (occurrences.size === 1) {
      const record = records[[...occurrences][0]];
      if (!collidedValues.has(valueFor(record))) {
        index.set(alias, valueFor(record));
        continue;
      }
    }
    collisions.add(alias);
  }
  return { index, collisions };
}

function buildRelationships(
  services: Service[],
  byId: Map<string, Service>
): Relationship[] {
  const relationships: Relationship[] = [];
  const seen = new Set<string>();

  // DockerMap has Compose start-order evidence for these edges, NOT measured
  // relationship health or latency. Relationship-level health is therefore
  // always "unknown" — the target service's own state is shown on its node,
  // and the edge must never imply the RELATIONSHIP is failing/slow based on
  // the target's state (#76).

  // Primary: explicit service-to-service dependencies. BOTH endpoints must
  // resolve uniquely through the collision-safe byId index (which excludes
  // empty and collided ids): a collided SOURCE would make the edge's
  // attribution ambiguous (the layout would spring to the first occurrence).
  for (const service of services) {
    if (!byId.has(service.id)) continue;
    for (const dep of service.dependsOn) {
      if (!byId.has(dep)) continue;
      const id = `dep:${service.id}->${dep}`;
      if (seen.has(id)) continue;
      seen.add(id);
      relationships.push({
        id,
        from: service.id,
        to: dep,
        kind: "depends_on",
        health: "unknown"
      });
    }
  }

  return relationships.sort((left, right) => left.id.localeCompare(right.id));
}

export function summarize(model: SystemModel): SystemSummary {
  const summary: SystemSummary = {
    total: model.services.length,
    healthy: 0,
    warning: 0,
    degraded: 0,
    offline: 0,
    updating: 0,
    unknown: 0,
    attention: 0
  };
  for (const service of model.services) {
    summary[service.state] += 1;
    if (needsAttention(service.state)) summary.attention += 1;
  }
  return summary;
}

/**
 * Impact analysis. Downstream answers the product's signature question:
 * "what breaks if this dies?" — every service that transitively depends on it.
 */
export function computeImpact(model: SystemModel, serviceId: string): ImpactResult {
  const upstream = traverse(model, serviceId, "dependsOn");
  const downstream = traverse(model, serviceId, "dependents");
  const neighbors = new Set<string>();
  const self = model.byId.get(serviceId);
  if (self) {
    for (const id of self.dependsOn) neighbors.add(id);
    for (const id of self.dependents) neighbors.add(id);
  }
  return { upstream: [...upstream], downstream: [...downstream], neighbors };
}

function traverse(model: SystemModel, startId: string, edge: "dependsOn" | "dependents"): Set<string> {
  const visited = new Set<string>();
  const stack = [startId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const service = model.byId.get(current);
    if (!service) continue;
    for (const next of service[edge]) {
      if (next === startId || visited.has(next)) continue;
      visited.add(next);
      stack.push(next);
    }
  }
  visited.delete(startId);
  return visited;
}

function buildRuntimeModel(runtimeMap: RuntimeMap): RuntimeModel {
  const incomingById = new Map<string, RuntimeMapEdge[]>();
  const outgoingById = new Map<string, RuntimeMapEdge[]>();

  for (const edge of runtimeMap.edges) {
    const outgoing = outgoingById.get(edge.source) ?? [];
    outgoing.push(edge);
    outgoingById.set(edge.source, outgoing);

    const incoming = incomingById.get(edge.target) ?? [];
    incoming.push(edge);
    incomingById.set(edge.target, incoming);
  }

  const nodes: RuntimeNodeRecord[] = runtimeMap.nodes
    .map((node): RuntimeNodeRecord => ({
      id: node.id,
      provider: node.provider,
      type: node.type,
      label: node.label,
      status: node.status,
      layer: runtimeLayerForNode(node),
      metadata: node.metadata,
      service: node.service,
      package: node.package,
      state: runtimeStateForNode(node),
      incoming: incomingById.get(node.id) ?? [],
      outgoing: outgoingById.get(node.id) ?? []
    }))
    .sort((left, right) => {
      if (left.state !== right.state) return runtimeStateRank(left.state) - runtimeStateRank(right.state);
      if (left.layer !== right.layer) return left.layer.localeCompare(right.layer);
      return left.label.localeCompare(right.label);
    });

  const { index: byId, collisions: idCollisions } = buildIdentityIndex(nodes, (node) => node.id);
  const providerSummary = summarizeRuntimeBuckets<RuntimeProviderKind>(nodes, (node) => node.provider);
  const layerSummary = summarizeRuntimeBuckets<RuntimeLayerId>(nodes, (node) => node.layer);
  const attention = nodes.filter((node) => needsAttention(node.state)).length;

  return {
    nodes,
    edges: runtimeMap.edges,
    diagnostics: runtimeMap.diagnostics,
    byId,
    idCollisions,
    providerSummary,
    layerSummary,
    summary: {
      totalNodes: nodes.length,
      serviceNodes: nodes.filter((node) => node.service || node.package).length,
      providers: providerSummary.length,
      layers: layerSummary.length,
      diagnostics: runtimeMap.diagnostics.length,
      attention
    },
    lastUpdated: runtimeMap.lastUpdated
  };
}

function summarizeRuntimeBuckets<T extends string>(nodes: RuntimeNodeRecord[], pick: (node: RuntimeNodeRecord) => T): RuntimeBucketSummary<T>[] {
  const counts = new Map<T, RuntimeBucketSummary<T>>();

  for (const node of nodes) {
    const id = pick(node);
    const bucket = counts.get(id) ?? { id, count: 0, attention: 0 };
    bucket.count += 1;
    if (needsAttention(node.state)) bucket.attention += 1;
    counts.set(id, bucket);
  }

  return [...counts.values()].sort((left, right) => {
    if (left.attention !== right.attention) return right.attention - left.attention;
    if (left.count !== right.count) return right.count - left.count;
    return left.id.localeCompare(right.id);
  });
}

function runtimeLayerForNode(node: RuntimeMapNode): RuntimeLayerId {
  return (node.layer ?? "unassigned") as RuntimeLayerId;
}

function runtimeStateForNode(node: RuntimeMapNode): ServiceState {
  const healthState = node.service?.health?.state?.toLowerCase();
  if (healthState === "healthy") return "healthy";
  if (healthState === "degraded") return "degraded";
  if (healthState === "unhealthy") return "offline";

  const candidates = [node.service?.status, node.status]
    .map((value) => value?.toLowerCase())
    .filter((value): value is string => Boolean(value));

  // Word-boundary matching only: a negative status ("unhealthy",
  // "unavailable", "inactive", "disconnected", "not ready") must never
  // become healthy because it CONTAINS a positive substring ("healthy",
  // "available", "active", "connected", "ready"). Negative groups are
  // checked before positive ones so a negated word can never fall through
  // to the healthy bucket (#76).
  const negativeGroups: Array<[RegExp, ServiceState]> = [
    [/\b(degraded|failed|error)\b/, "degraded"],
    [/\b(offline|stopped|dead|down|exited|missing|unhealthy|unavailable|inactive|disconnected|not)\b/, "offline"],
    [/\b(warning|paused)\b/, "warning"],
    [/\b(starting|restarting|reloading|pending|loading)\b/, "updating"]
  ];
  const positive = /\b(healthy|running|active|online|available|attached|ready|connected)\b/;

  for (const value of candidates) {
    for (const [pattern, state] of negativeGroups) {
      if (pattern.test(value)) return state;
    }
    if (positive.test(value)) return "healthy";
  }

  return "unknown";
}

function runtimeStateRank(state: ServiceState): number {
  const order = { offline: 0, degraded: 1, warning: 2, updating: 3, unknown: 4, healthy: 5 };
  return order[state];
}
