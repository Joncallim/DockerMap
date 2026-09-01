import { ROUTE_MANIFEST, type RouteId, type RouteManifestEntry } from "./routes.js";
import { PRODUCT_VERSION } from "./generated/productVersion.js";

type OpenApiParameter = Readonly<{
  name: string;
  in: "path" | "query";
  required?: boolean;
  style?: "form";
  explode?: boolean;
  schema: Readonly<Record<string, unknown>>;
}>;

type OpenApiResponse = Readonly<{ description: string }>;
type OpenApiResponses =
  | Readonly<{ "200": OpenApiResponse; "204"?: never }>
  | Readonly<{ "204": OpenApiResponse; "200"?: never }>;

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

const composeFileParameter = {
  name: "file",
  in: "query",
  style: "form",
  explode: true,
  schema: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 512, pattern: "\\S" } }
} as const satisfies OpenApiParameter;

// This metadata deliberately owns only human-readable operation details. The
// route manifest remains authoritative for paths, methods, aliases, auth, and
// rate limiting. Do not add response schemas or OpenAPI security schemes here:
// deployment authentication is configured outside this process and response
// schema authority is being introduced separately.
export const ROUTE_OPERATION_METADATA = {
  "health": { summary: "API and daemon health", tags: ["system"], responses: successfulResponse },
  "api-health": { summary: "API and daemon health", tags: ["system"], responses: successfulResponse },
  "status": { summary: "Compact dashboard status for external widgets (Homepage-style)", tags: ["system"], responses: successfulResponse },
  "openapi": { summary: "OpenAPI document for explicit browser API routes", tags: ["system"], responses: successfulResponse },
  "auth-whoami": { summary: "Current authenticated identity", tags: ["system"], responses: successfulResponse },
  "snapshot": { summary: "Full Docker inventory snapshot", tags: ["docker"], responses: successfulResponse },
  "graph": { summary: "Topology graph", tags: ["topology"], responses: successfulResponse },
  "runtime-map": { summary: "Runtime map across all providers", tags: ["runtime"], responses: successfulResponse },
  "diagnostics": { summary: "Aggregated compose and runtime diagnostics", tags: ["system"], responses: successfulResponse },
  "containers": { summary: "List containers", tags: ["docker"], responses: successfulResponse },
  "container": { summary: "Container detail", tags: ["docker"], responses: successfulResponse },
  "images": { summary: "List images", tags: ["docker"], responses: successfulResponse },
  "networks": { summary: "List networks", tags: ["docker"], responses: successfulResponse },
  "volumes": { summary: "List volumes", tags: ["docker"], responses: successfulResponse },
  "logs": {
    summary: "Container logs with cursor pagination",
    tags: ["logs"],
    parameters: [
      { name: "service", in: "query", schema: { type: "string", maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*$" } },
      { name: "q", in: "query", schema: { type: "string", maxLength: 256 } },
      { name: "cursor", in: "query", schema: { type: "string", maxLength: 32, pattern: "^\\d+(:\\d+)?$" } },
      { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500 } }
    ],
    responses: successfulResponse
  },
  "compose-scan": { summary: "Scan Compose files and correlate mounts", tags: ["compose"], parameters: [composeFileParameter], responses: successfulResponse },
  "compose-graph": { summary: "Derive Compose dependency graph", tags: ["compose"], parameters: [composeFileParameter], responses: successfulResponse },
  "compose-edit-plan": {
    summary: "Dry-run edit plan (never writes)",
    tags: ["compose"],
    parameters: [
      { name: "file", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 512, pattern: "\\S" } },
      { name: "service", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 256, pattern: "\\S" } },
      { name: "mount", in: "query", required: true, schema: { type: "string", maxLength: 16, pattern: "^\\d+$" } },
      { name: "source", in: "query", schema: { type: "string", maxLength: 512 } },
      { name: "target", in: "query", schema: { type: "string", maxLength: 512 } }
    ],
    responses: successfulResponse
  },
  "events-stream": { summary: "Server-sent event stream of health snapshots", tags: ["system"], responses: successfulResponse },
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
    responses: noContentResponse
  },
  "auth-session-logout": { summary: "End the current browser session", tags: ["auth"], responses: noContentResponse },
  "api-version": { summary: "Version descriptor for the /api/v1 alias", tags: ["system"], responses: successfulResponse }
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
    openapi: "3.0.3",
    info: {
      title: "DockerMap Read-Only API",
      version: PRODUCT_VERSION,
      description:
        "Read-only inventory, topology, runtime, compose, logs, and diagnostics endpoints. All /api/v1/* routes alias these paths. Protected routes require the deployment's configured authentication boundary."
    },
    paths
  };
}

export const OPENAPI_DOCUMENT = buildOpenApiDocument();
