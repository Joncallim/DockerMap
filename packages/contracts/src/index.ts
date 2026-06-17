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

export type ComposeMountKind = "bind" | "named_volume" | "anonymous_volume" | "unsupported";
export type DiagnosticSeverity = "info" | "warning" | "error" | "blocked";

export interface ComposeFileOrigin {
  file: string;
  service: string | null;
  field: string;
}

export interface ComposeDiagnostic {
  id: string;
  severity: DiagnosticSeverity;
  message: string;
  origin: ComposeFileOrigin;
}

export interface ComposeMount {
  id: string;
  service: string;
  kind: ComposeMountKind;
  source: string | null;
  resolvedSource: string | null;
  target: string;
  readOnly: boolean;
  origin: ComposeFileOrigin;
}

export interface ComposeService {
  name: string;
  image: string | null;
  dependsOn: string[];
}

export interface ComposeScan {
  files: string[];
  projectRoot: string;
  services: ComposeService[];
  mounts: ComposeMount[];
  diagnostics: ComposeDiagnostic[];
}

export type ComposeNodeKind =
  | "service"
  | "host_path"
  | "container_path"
  | "named_volume"
  | "anonymous_volume";
export type ComposeRelationshipKind = "declares_mount" | "mounted_at";

export interface ComposeGraphNode {
  id: string;
  type: ComposeNodeKind;
  label: string;
}

export interface ComposeGraphEdge {
  source: string;
  target: string;
  relationship: ComposeRelationshipKind;
}

export interface ComposeGraph {
  nodes: ComposeGraphNode[];
  edges: ComposeGraphEdge[];
}

export interface ComposeEditPlan {
  file: string;
  service: string;
  mountId: string;
  originalSource: string | null;
  originalTarget: string;
  newSource: string | null;
  newTarget: string | null;
  unifiedDiff: string;
  diagnostics: ComposeDiagnostic[];
  willWrite: boolean;
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
