import { ROUTE_MANIFEST, type RouteId, type RouteManifestEntry } from "./routes.js";
import { PRODUCT_VERSION } from "./generated/productVersion.js";
import {
  NODE_ENVELOPE_SCHEMAS,
  OPENAPI_RUST_RESPONSE_SCHEMAS,
  RUST_RESPONSE_SCHEMAS,
  type NodeEnvelopeSchemaId,
  type RustResponseSchemaId
} from "@dockermap/contracts";
import {
  SSE_CONTENT_TYPE,
  SSE_EVENT_PAYLOAD_SCHEMAS,
  SSE_HEARTBEAT_COMMENT,
  assertSseEventSchemaCoverage,
  ssePayloadSchemaRef
} from "./sseProtocol.js";
import {
  BROWSER_ROUTE_QUERY_CONTRACTS,
  assertBrowserQueryContractCoverage,
  openApiQueryParameters
} from "./requestContracts.js";
import { RUST_ROUTE_RESPONSE_SCHEMAS } from "./rustResponseContracts.js";

export { RUST_ROUTE_RESPONSE_SCHEMAS } from "./rustResponseContracts.js";

type OpenApiParameter = Readonly<{
  name: string;
  in: "path" | "query";
  required?: boolean;
  style?: "form";
  explode?: boolean;
  schema: Readonly<Record<string, unknown>>;
}>;

type OpenApiResponse = Readonly<{
  description: string;
  content?: Readonly<Record<string, Readonly<{
    schema: Readonly<Record<string, unknown>>;
    "x-dockermap-sse-events"?: readonly Readonly<Record<string, unknown>>[];
    "x-dockermap-sse-comment-frames"?: readonly string[];
  }>>>;
}>;
type OpenApiResponses = Readonly<Record<string, OpenApiResponse>>;

type OpenApiRequestBody = Readonly<{
  required: true;
  content: Readonly<Record<"application/json", Readonly<{
    schema: Readonly<Record<string, unknown>>;
  }>>>;
}>;

type RouteOperationMetadata = Readonly<Record<RouteId, Readonly<{
  summary: string;
  tags: readonly string[];
  parameters?: readonly OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses: OpenApiResponses;
}>>>;

const successfulResponse = { "200": { description: "Successful response." } } as const;
const noContentResponse = { "204": { description: "Successful response with no response body." } } as const;

function nodeJsonResponse(schema: NodeEnvelopeSchemaId, description = "Successful response.") {
  return {
    "200": {
      description,
      content: {
        "application/json": { schema: { $ref: `#/components/schemas/${schema}` } }
      }
    }
  } as const;
}

function rustJsonResponse(schema: RustResponseSchemaId, description = "Successful daemon response.") {
  return {
    "200": {
      description,
      content: {
        "application/json": { schema: { $ref: `#/components/schemas/${schema}` } }
      }
    }
  } as const;
}

function sseResponse() {
  assertSseEventSchemaCoverage();
  return {
    "200": {
      description: "A long-lived Server-Sent Events stream. Named event data is JSON; comment frames are keepalives and have no JSON payload.",
      content: {
        [SSE_CONTENT_TYPE]: {
          schema: { type: "string", description: "UTF-8 Server-Sent Events framing; see x-dockermap-sse-events." },
          "x-dockermap-sse-events": Object.entries(SSE_EVENT_PAYLOAD_SCHEMAS).map(([event, contract]) => ({
            event,
            data: { $ref: ssePayloadSchemaRef(contract) },
            "x-dockermap-schema-authority": contract.authority
          })),
          "x-dockermap-sse-comment-frames": [SSE_HEARTBEAT_COMMENT]
        }
      }
    }
  } as const;
}

export function assertRustRouteSchemaCoverage(
  mappings: Partial<Record<RouteId, RustResponseSchemaId>> = RUST_ROUTE_RESPONSE_SCHEMAS
) {
  for (const routeId of Object.keys(RUST_ROUTE_RESPONSE_SCHEMAS) as RouteId[]) {
    const schema = mappings[routeId];
    if (!schema) throw new Error(`Rust-owned route is missing a response schema mapping: ${routeId}`);
    if (!(schema in RUST_RESPONSE_SCHEMAS)) {
      throw new Error(`Rust-owned route references an unknown generated schema: ${routeId} -> ${schema}`);
    }
  }
}

function rustJsonResponseFor(routeId: keyof typeof RUST_ROUTE_RESPONSE_SCHEMAS) {
  return rustJsonResponse(RUST_ROUTE_RESPONSE_SCHEMAS[routeId]);
}

function apiErrorResponse(description: string): OpenApiResponse {
  return {
    description,
    content: {
      "application/json": { schema: { $ref: "#/components/schemas/ApiError" } }
    }
  };
}

function withApiErrors(success: OpenApiResponses, statuses: readonly string[] = ["401", "500"]): OpenApiResponses {
  return {
    ...success,
    ...Object.fromEntries(statuses.map((status) => [status, apiErrorResponse(`API error response (${status}).`)])),
    // Daemon failures retain their meaningful HTTP status (for example 404,
    // 502, or 503) while keeping the same redacted Node error envelope.
    // `default` documents those route-dependent statuses without claiming
    // every daemon pass-through route has identical failure semantics.
    default: apiErrorResponse("Route-dependent API error response.")
  };
}

// This metadata owns operation documentation and Node-created response
// envelopes. The route manifest remains authoritative for paths, methods,
// aliases, auth, and rate limiting. Rust daemon pass-through schemas are
// generated directly from Rust serialization models; this table only names
// which generated schema a browser route returns.
export const ROUTE_OPERATION_METADATA = {
  "health": { summary: "API and daemon health", tags: ["system"], responses: withApiErrors(nodeJsonResponse("RootHealth")) },
  "api-health": { summary: "API and daemon health", tags: ["system"], responses: withApiErrors(nodeJsonResponse("ApiHealth")) },
  "status": { summary: "Compact dashboard status for external widgets (Homepage-style)", tags: ["system"], responses: withApiErrors(nodeJsonResponse("Status")) },
  "openapi": { summary: "OpenAPI document for explicit browser API routes", tags: ["system"], responses: withApiErrors(successfulResponse) },
  "auth-whoami": { summary: "Current authenticated identity", tags: ["system"], responses: withApiErrors(nodeJsonResponse("AuthWhoami")) },
  "snapshot": { summary: "Full Docker inventory snapshot", tags: ["docker"], responses: withApiErrors(rustJsonResponseFor("snapshot")) },
  "graph": { summary: "Topology graph", tags: ["topology"], responses: withApiErrors(rustJsonResponseFor("graph")) },
  "runtime-map": { summary: "Runtime map across all providers", tags: ["runtime"], responses: withApiErrors(rustJsonResponseFor("runtime-map")) },
  "findings": { summary: "Evidence-backed advisory findings", tags: ["runtime"], responses: withApiErrors(rustJsonResponseFor("findings")) },
  "history": { summary: "Bounded observed Docker inventory history", tags: ["docker"], responses: withApiErrors(rustJsonResponseFor("history")) },
  "observed-events": { summary: "Bounded observed Docker event-stream history", tags: ["docker"], responses: withApiErrors(rustJsonResponseFor("observed-events")) },
  "resource-telemetry": { summary: "Bounded current Docker resource telemetry", tags: ["docker"], responses: withApiErrors(rustJsonResponseFor("resource-telemetry")) },
  "diagnostics": { summary: "Aggregated compose and runtime diagnostics", tags: ["system"], responses: withApiErrors(nodeJsonResponse("Diagnostics")) },
  "containers": { summary: "List containers", tags: ["docker"], responses: withApiErrors(rustJsonResponseFor("containers")) },
  "container": { summary: "Container detail", tags: ["docker"], responses: withApiErrors(rustJsonResponseFor("container")) },
  "images": { summary: "List images", tags: ["docker"], responses: withApiErrors(rustJsonResponseFor("images")) },
  "networks": { summary: "List networks", tags: ["docker"], responses: withApiErrors(rustJsonResponseFor("networks")) },
  "volumes": { summary: "List volumes", tags: ["docker"], responses: withApiErrors(rustJsonResponseFor("volumes")) },
  "logs": {
    summary: "Container logs with cursor pagination",
    tags: ["logs"],
    parameters: openApiQueryParameters(BROWSER_ROUTE_QUERY_CONTRACTS.logs),
    responses: withApiErrors(rustJsonResponseFor("logs"), ["400", "401", "500"])
  },
  "compose-scan": { summary: "Scan Compose files and correlate mounts", tags: ["compose"], parameters: openApiQueryParameters(BROWSER_ROUTE_QUERY_CONTRACTS["compose-scan"]), responses: withApiErrors(rustJsonResponseFor("compose-scan"), ["400", "401", "500"]) },
  "compose-graph": { summary: "Derive Compose dependency graph", tags: ["compose"], parameters: openApiQueryParameters(BROWSER_ROUTE_QUERY_CONTRACTS["compose-graph"]), responses: withApiErrors(rustJsonResponseFor("compose-graph"), ["400", "401", "500"]) },
  "compose-edit-plan": {
    summary: "Dry-run edit plan (never writes)",
    tags: ["compose"],
    parameters: openApiQueryParameters(BROWSER_ROUTE_QUERY_CONTRACTS["compose-edit-plan"]),
    responses: withApiErrors(rustJsonResponseFor("compose-edit-plan"), ["400", "401", "500"])
  },
  "events-stream": { summary: "Server-sent event stream of health snapshots", tags: ["system"], responses: withApiErrors(sseResponse(), ["401", "429", "500", "503"]) },
  "auth-session": {
    summary: "Create a browser session from a bearer token",
    tags: ["auth"],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["token"],
            properties: { token: { type: "string" } }
          }
        }
      }
    },
    responses: withApiErrors(noContentResponse, ["400", "401", "413", "429", "500"])
  },
  "auth-session-logout": { summary: "End the current browser session", tags: ["auth"], responses: withApiErrors(noContentResponse) },
  "api-version": { summary: "Version descriptor for the /api/v1 alias", tags: ["system"], responses: withApiErrors(nodeJsonResponse("Version")) }
} as const satisfies RouteOperationMetadata;

type OpenApiOperation = Readonly<{
  summary: string;
  tags: readonly string[];
  parameters?: readonly OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses: OpenApiResponses;
  "x-dockermap-auth-policy": RouteManifestEntry["auth"];
  "x-dockermap-rate-limit": RouteManifestEntry["rateLimit"];
}>;

type OpenApiPathItem = Partial<Record<Lowercase<RouteManifestEntry["method"]>, OpenApiOperation>>;

function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function pathParameters(path: string): readonly OpenApiParameter[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => ({
    name: match[1],
    in: "path",
    required: true,
    schema: { type: "string" }
  }));
}

function operationFor(route: (typeof ROUTE_MANIFEST)[number], path: string): OpenApiOperation {
  const metadata: RouteOperationMetadata[RouteId] = ROUTE_OPERATION_METADATA[route.id];
  const parameters = [...pathParameters(path), ...(metadata.parameters ?? [])];
  return {
    summary: metadata.summary,
    tags: metadata.tags,
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(metadata.requestBody ? { requestBody: metadata.requestBody } : {}),
    responses: metadata.responses,
    "x-dockermap-auth-policy": route.auth,
    "x-dockermap-rate-limit": route.rateLimit
  };
}

export function buildOpenApiDocument() {
  assertRustRouteSchemaCoverage();
  assertSseEventSchemaCoverage();
  assertBrowserQueryContractCoverage();
  const paths: Record<string, OpenApiPathItem> = {};
  for (const route of ROUTE_MANIFEST) {
    for (const routePath of route.paths) {
      const path = toOpenApiPath(routePath.path);
      const method = route.method.toLowerCase() as Lowercase<typeof route.method>;
      const pathItem = paths[path] ?? {};
      if (pathItem[method]) throw new Error(`Duplicate OpenAPI operation: ${route.method} ${path}`);
      pathItem[method] = operationFor(route, routePath.path);
      paths[path] = pathItem;
    }
  }
  return {
    openapi: "3.1.1",
    info: {
      title: "DockerMap Read-Only API",
      version: PRODUCT_VERSION,
      description:
        "Read-only inventory, topology, runtime, compose, logs, and diagnostics endpoints. All /api/v1/* routes alias these paths. Protected routes require the deployment's configured authentication boundary."
    },
    jsonSchemaDialect: "https://spec.openapis.org/oas/3.1/dialect/base",
    paths,
    components: { schemas: { ...NODE_ENVELOPE_SCHEMAS, ...OPENAPI_RUST_RESPONSE_SCHEMAS } }
  };
}

export const OPENAPI_DOCUMENT = buildOpenApiDocument();
