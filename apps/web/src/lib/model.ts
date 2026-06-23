import type {
  ContainerRecord,
  DockerSnapshot,
  GraphResponse,
  NetworkRecord,
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
  /** Services this one depends on (upstream). */
  dependsOn: string[];
  /** Services that depend on this one (downstream). */
  dependents: string[];
  /** True when an update is available (stub-derived; see lib/stubs). */
  updateAvailable: boolean;
}

export interface SystemModel {
  services: Service[];
  relationships: Relationship[];
  networks: NetworkRecord[];
  volumes: VolumeRecord[];
  byId: Map<string, Service>;
  byName: Map<string, Service>;
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
  updatesAvailable: number;
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

export function buildModel(snapshot: DockerSnapshot, graph: GraphResponse): SystemModel {
  const networkNameById = new Map(snapshot.networks.map((n) => [n.id, n.name]));

  // dependsOn references can be either container ids or names; normalise to ids.
  const idByAlias = new Map<string, string>();
  for (const c of snapshot.containers) {
    idByAlias.set(c.id, c.id);
    idByAlias.set(c.name, c.id);
    idByAlias.set(c.id.replace(/^container_/, ""), c.id);
  }
  const resolveId = (ref: string) => idByAlias.get(ref) ?? idByAlias.get(ref.replace(/^container_/, "")) ?? ref;

  const dependents = new Map<string, Set<string>>();
  for (const c of snapshot.containers) {
    for (const dep of c.dependsOn) {
      const target = resolveId(dep);
      if (!dependents.has(target)) dependents.set(target, new Set());
      dependents.get(target)!.add(c.id);
    }
  }

  const services: Service[] = snapshot.containers.map((c) => {
    const { repo, tag } = splitImage(c.image);
    const updateAvailable = hashString(c.id + "update") > 0.74;
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
      dependsOn: c.dependsOn.map(resolveId).filter((id) => idByAlias.has(id) || id.startsWith("container_")),
      dependents: [...(dependents.get(c.id) ?? [])],
      updateAvailable
    };
  });

  const byId = new Map(services.map((s) => [s.id, s]));
  const byName = new Map(services.map((s) => [s.name, s]));

  const relationships = buildRelationships(services, snapshot, byId);

  return {
    services,
    relationships,
    networks: snapshot.networks,
    volumes: snapshot.volumes,
    byId,
    byName,
    lastUpdated: snapshot.lastUpdated
  };
}

function buildRelationships(
  services: Service[],
  snapshot: DockerSnapshot,
  byId: Map<string, Service>
): Relationship[] {
  const relationships: Relationship[] = [];
  const seen = new Set<string>();

  const edgeHealth = (targetId: string): RelationshipHealth => {
    const target = byId.get(targetId);
    if (!target) return "unknown";
    if (target.state === "offline") return "failing";
    if (target.state === "warning" || target.state === "degraded") return "slow";
    if (target.state === "unknown") return "unknown";
    return "healthy";
  };

  // Primary: explicit service-to-service dependencies.
  for (const service of services) {
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
        health: edgeHealth(dep)
      });
    }
  }

  // Secondary: shared-volume data relationships (who reads/writes the same state).
  for (const volume of snapshot.volumes) {
    const attached = volume.attachedTo
      .map((ref) => services.find((s) => s.name === ref || s.id === ref))
      .filter((s): s is Service => Boolean(s));
    for (let i = 0; i < attached.length; i += 1) {
      for (let j = i + 1; j < attached.length; j += 1) {
        const a = attached[i];
        const b = attached[j];
        const id = `data:${[a.id, b.id].sort().join("~")}:${volume.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        relationships.push({ id, from: a.id, to: b.id, kind: "data", health: "healthy" });
      }
    }
  }

  return relationships;
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
    attention: 0,
    updatesAvailable: 0
  };
  for (const service of model.services) {
    summary[service.state] += 1;
    if (needsAttention(service.state)) summary.attention += 1;
    if (service.updateAvailable) summary.updatesAvailable += 1;
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
