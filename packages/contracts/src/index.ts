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
  mounts: ContainerMount[];
  dependsOn: string[];
}

export interface ContainerMount {
  id: string;
  kind: ComposeMountKind;
  source: string | null;
  target: string;
  readOnly: boolean;
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
  environment: Record<string, string>;
  dependsOn: string[];
}

export interface ComposeScan {
  files: string[];
  projectRoot: string;
  services: ComposeService[];
  mounts: ComposeMount[];
  correlations: MountCorrelation[];
  diagnostics: ComposeDiagnostic[];
}

export type MountCorrelationStatus = "matched" | "missing" | "extra";

export interface MountCorrelation {
  id: string;
  service: string;
  container: string | null;
  composeMountId: string | null;
  kind: ComposeMountKind;
  target: string;
  declaredSource: string | null;
  runtimeSource: string | null;
  status: MountCorrelationStatus;
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

export type RuntimeMetadataValue = string | number | boolean | null;
export type RuntimeNodeLayer =
  | "edge"
  | "host"
  | "service"
  | "container"
  | "process"
  | "session"
  | "package"
  | "network"
  | "storage"
  | "advisory";

export type RuntimeServiceStatus =
  | "running"
  | "starting"
  | "stopping"
  | "stopped"
  | "degraded"
  | "failed"
  | "unknown";
export type RuntimeOwnershipKind = "person" | "team" | "system" | "automation" | "vendor";
export type RuntimeLocationKind = "host" | "container" | "path" | "cluster" | "region" | "workspace" | "tailnet";
export type RuntimeHealthState = "healthy" | "degraded" | "unhealthy" | "unknown";
export type RuntimePackageManager = "npm" | "pnpm" | "yarn" | "pip" | "apt" | "apk" | "brew" | "cargo" | "system";
export type RuntimeAdvisorySeverity = "low" | "moderate" | "high" | "critical";

export interface RuntimeOwnership {
  kind: RuntimeOwnershipKind;
  name: string;
  id?: string;
}

export interface RuntimeLocation {
  kind: RuntimeLocationKind;
  value: string;
  detail?: string;
}

export interface RuntimeHealth {
  state: RuntimeHealthState;
  checkedAt?: number;
  source?: string;
  message?: string;
}

export interface RuntimeLogRef {
  id: string;
  source: string;
  level?: "debug" | "info" | "warn" | "error";
}

export interface RuntimeEventRef {
  id: string;
  kind: string;
  timestamp?: number;
  message?: string;
}

export interface RuntimeServiceEntity {
  name: string;
  status: RuntimeServiceStatus;
  dependencies: string[];
  dependents: string[];
  health: RuntimeHealth | null;
  logs: RuntimeLogRef[];
  events: RuntimeEventRef[];
  owner: RuntimeOwnership | null;
  location: RuntimeLocation | null;
}

export interface RuntimePackageAdvisory {
  id: string;
  source: string;
  title: string;
  severity: RuntimeAdvisorySeverity;
  fixedVersion: string | null;
  url?: string;
  publishedAt?: number;
}

export interface RuntimePackageUpdate {
  currentVersion: string;
  latestVersion: string | null;
  available: boolean;
  advisories: RuntimePackageAdvisory[];
}

export interface RuntimePackageEntity {
  name: string;
  manager: RuntimePackageManager;
  version: string;
  dependencies: string[];
  dependents: string[];
  update: RuntimePackageUpdate | null;
  owner: RuntimeOwnership | null;
  location: RuntimeLocation | null;
}

export type RuntimeProviderKind =
  | "docker"
  | "compose"
  | "host"
  | "systemd"
  | "scheduled_job"
  | "npm"
  | "pm2"
  | "tmux"
  | "tailscale"
  | "headscale"
  | "cloudflare"
  | "caddy"
  | "reverse_proxy"
  | "local_dns"
  | "dns_provider"
  | "external_api"
  | "process"
  | "network"
  | "kubernetes"
  | "other";

export type RuntimeNodeKind =
  | "container"
  | "docker_network"
  | "docker_volume"
  | "host"
  | "service"
  | "systemd_service"
  | "scheduled_job"
  | "pm2_app"
  | "tmux_session"
  | "tailnet_node"
  | "reverse_proxy"
  | "local_dns_resolver"
  | "dns_provider"
  | "node_application"
  | "python_application"
  | "ai_agent"
  | "storage"
  | "external_api"
  | "process"
  | "network_listener"
  | "orchestrator_workload"
  | "package"
  | "package_dependency"
  | "database"
  | "worker";

export type RuntimeRelationshipKind =
  | "connected_to"
  | "mounts"
  | "manages"
  | "exposes"
  | "owns"
  | "related_to"
  | "depends_on"
  | "required_by"
  | "wants"
  | "requires"
  | "after"
  | "before"
  | "part_of"
  | "binds_to"
  | "conflicts_with"
  | "runs_on"
  | "uses"
  | "calls"
  | "resolves_via"
  | "proxies_to"
  | "contains";

export interface RuntimeMapNode {
  id: string;
  provider: RuntimeProviderKind;
  type: RuntimeNodeKind;
  label: string;
  status: string | null;
  layer?: RuntimeNodeLayer | null;
  metadata: Record<string, RuntimeMetadataValue>;
  service?: RuntimeServiceEntity | null;
  package?: RuntimePackageEntity | null;
}

export interface RuntimeMapEdge {
  source: string;
  target: string;
  relationship: RuntimeRelationshipKind;
  metadata: Record<string, RuntimeMetadataValue>;
}

export interface RuntimeMapDiagnostic {
  provider: RuntimeProviderKind;
  severity: DiagnosticSeverity;
  message: string;
}

export interface RuntimeMap {
  nodes: RuntimeMapNode[];
  edges: RuntimeMapEdge[];
  diagnostics: RuntimeMapDiagnostic[];
  lastUpdated: number;
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

export interface AuthWhoamiResponse {
  authenticated: boolean;
  required: boolean;
  user: string | null;
  name: string | null;
  email: string | null;
  groups: string[];
}
