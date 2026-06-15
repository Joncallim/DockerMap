export type NodeKind = "container" | "network" | "volume";
export type RelationshipKind = "connected_to" | "mounts";
export type RuntimeMode = "docker" | "mock";
export type HealthState = "ok" | "degraded";

export interface GraphNode {
  id: string;
  type: NodeKind;
  label: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  relationship: RelationshipKind;
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ContainerRecord {
  id: string;
  name: string;
  image: string;
  status: string;
  role: string;
  networks: string[];
  ports: string[];
  dependsOn: string[];
}

export interface ImageRecord {
  image: string;
  containers: string[];
  status: string;
}

export interface NetworkRecord {
  id: string;
  name: string;
  driver: string;
  internal: boolean;
  members: string[];
}

export interface VolumeRecord {
  id: string;
  name: string;
  attachedTo: string[];
}

export interface DockerSnapshot {
  containers: ContainerRecord[];
  images: ImageRecord[];
  networks: NetworkRecord[];
  volumes: VolumeRecord[];
  lastUpdated: number;
}

export interface LogEntry {
  id: string;
  timestamp: number;
  container: string;
  level: "info" | "warn" | "error";
  message: string;
}

export interface LogsResponse {
  service: string | null;
  entries: LogEntry[];
  nextCursor: string | null;
}

export interface HealthResponse {
  status: HealthState;
  mode: RuntimeMode;
  dockerReachable: boolean;
  lastUpdated: number;
  snapshotVersion: string;
  message?: string;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}
