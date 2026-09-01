// Rust-owned daemon response models are generated from Schemars artifacts.
// Node-owned browser envelopes and request-only values remain declared here.
export type {
  ComposeDiagnostic,
  ComposeEditPlan,
  ComposeFileOrigin,
  ComposeGraph,
  ComposeGraphEdge,
  ComposeGraphNode,
  ComposeMount,
  ComposeMountKind,
  ComposeNodeKind,
  ComposeRelationshipKind,
  ComposeScan,
  ComposeService,
  ContainerDetailResponse,
  ContainerMount,
  ContainerRecord,
  ContainersResponse,
  DockerSnapshot,
  GraphEdge,
  GraphNode,
  GraphResponse,
  HealthResponse,
  HealthState,
  ImageRecord,
  ImagesResponse,
  LogEntry,
  LogLevel,
  LogsResponse,
  MountCorrelation,
  MountCorrelationStatus,
  NetworkRecord,
  NetworksResponse,
  NodeKind,
  RelationshipKind,
  RuntimeAdvisorySeverity,
  RuntimeEvidenceAssertionKind,
  RuntimeEvidenceKind,
  RuntimeEvidenceProvider,
  RuntimeEvidenceRef,
  RuntimeEventRef,
  RuntimeHealth,
  RuntimeHealthState,
  RuntimeLocation,
  RuntimeLocationKind,
  RuntimeLogLevel,
  RuntimeLogRef,
  RuntimeMapDiagnostic,
  RuntimeMode,
  RuntimeNodeKind,
  RuntimeNodeLayer,
  RuntimeOwnership,
  RuntimeOwnershipKind,
  RuntimePackageAdvisory,
  RuntimePackageEntity,
  RuntimePackageManager,
  RuntimePackageUpdate,
  ProviderState,
  ProviderSlot,
  ProviderStatusReason,
  RuntimeProviderKind,
  RuntimeRelationshipKind,
  RuntimeServiceEntity,
  RuntimeServiceStatus,
  VolumeRecord,
  VolumesResponse
} from "./rustModels.js";

import type {
  DaemonRuntimeMap,
  DaemonRuntimeMapEdge,
  DaemonRuntimeMapNode
} from "./rustModels.js";

/** JSON scalar values emitted by the Node-owned Demo Mode runtime model. */
export type RuntimeMetadataValue = string | number | boolean | null;
export type RuntimeMapNode = Omit<DaemonRuntimeMapNode, "metadata"> & {
  metadata: Record<string, RuntimeMetadataValue>;
};
export type RuntimeMapEdge = Omit<DaemonRuntimeMapEdge, "metadata"> & {
  metadata: Record<string, RuntimeMetadataValue>;
};
/**
 * Browser API runtime-map bytes are either the exact Rust daemon response or
 * the Node-owned Demo Mode response. Only metadata is deliberately wider in
 * Demo Mode; all daemon model fields remain generated from Rust.
 */
export type RuntimeMap = Omit<DaemonRuntimeMap, "nodes" | "edges"> & {
  nodes: RuntimeMapNode[];
  edges: RuntimeMapEdge[];
};

export interface LogsQueryParams {
  service?: string;
  q?: string;
  /** Opaque cursor returned as `nextCursor`; request entries strictly older than this position. */
  cursor?: string;
  /** Page size between 1 and 500; defaults to 100. */
  limit?: number;
}

export interface DiagnosticsEntry {
  id: string | null;
  source: "compose" | "runtime" | "api";
  severity: "info" | "warning" | "error" | "blocked";
  message: string;
  file: string | null;
  service: string | null;
}

export interface DiagnosticsReport {
  generatedAt: number;
  entries: DiagnosticsEntry[];
}

export interface StatusResponse {
  service: "dockermap";
  status: "ok" | "degraded" | "offline";
  mode: import("./rustModels.js").RuntimeMode | "mixed";
  sourceCoherent: boolean;
  snapshotSource: import("./rustModels.js").RuntimeMode;
  dockerReachable: boolean;
  containers: number;
  containersRunning: number;
  networks: number;
  volumes: number;
  images: number;
  healthy: number;
  attention: number;
  offline: number;
  version: string;
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

export { NODE_ENVELOPE_SCHEMAS, type NodeEnvelopeSchemaId } from "./nodeSchemas.js";
export {
  OPENAPI_RUST_RESPONSE_SCHEMAS,
  RUST_RESPONSE_SCHEMAS,
  type RustResponseSchemaId
} from "./rustSchemas.js";
