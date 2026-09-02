import type { RustResponseSchemaId } from "@dockermap/contracts";
import type { RouteId } from "./routes.js";

// This finite declaration names the generated Rust response root for every
// browser route which publishes daemon bytes unchanged.  OpenAPI documentation
// and runtime validation both consume it; adding a pass-through route therefore
// cannot update one authority while silently leaving the other untyped.
export const RUST_ROUTE_RESPONSE_SCHEMAS = {
  snapshot: "DockerSnapshot",
  graph: "GraphResponse",
  "runtime-map": "RuntimeMap",
  findings: "FindingsResponse",
  containers: "ContainersResponse",
  container: "ContainerDetailResponse",
  images: "ImagesResponse",
  networks: "NetworksResponse",
  volumes: "VolumesResponse",
  logs: "LogsResponse",
  "compose-scan": "ComposeScan",
  "compose-graph": "ComposeGraph",
  "compose-edit-plan": "ComposeEditPlan"
} as const satisfies Partial<Record<RouteId, RustResponseSchemaId>>;
