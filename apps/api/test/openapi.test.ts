import assert from "node:assert/strict";
import test from "node:test";
import { Validator } from "@seriousme/openapi-schema-validator";
import {
  NODE_ENVELOPE_SCHEMAS,
  OPENAPI_RUST_RESPONSE_SCHEMAS,
  type RustResponseSchemaId
} from "@dockermap/contracts";
import {
  assertRustRouteSchemaCoverage,
  buildOpenApiDocument,
  ROUTE_OPERATION_METADATA,
  RUST_ROUTE_RESPONSE_SCHEMAS
} from "../src/openapi.js";
import { ROUTE_MANIFEST } from "../src/routes.js";
import {
  BROWSER_ROUTE_QUERY_CONTRACTS,
  COMPOSE_EDIT_PLAN_QUERY_CONTRACT,
  LOGS_QUERY_CONTRACT,
  assertBrowserQueryContractCoverage,
  openApiQueryParameters
} from "../src/requestContracts.js";
import {
  SSE_CONTENT_TYPE,
  SSE_EVENT,
  SSE_EVENT_PAYLOAD_SCHEMAS,
  SSE_HEARTBEAT_COMMENT,
  assertSseEventSchemaCoverage,
  formatSseEvent,
  formatSseHeartbeat
} from "../src/sseProtocol.js";

function toOpenApiPath(path: string) {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

test("generated OpenAPI 3.1 document passes the official structural schema validator", async () => {
  const document = buildOpenApiDocument();
  const validator = new Validator();
  const validated = await validator.validate(structuredClone(document));
  assert.equal(validated.valid, true, JSON.stringify(validated.errors));
  assert.equal(validator.version, "3.1");
});

test("generated OpenAPI operations are exactly the explicit route manifest", () => {
  const document = buildOpenApiDocument();
  const expected = ROUTE_MANIFEST.flatMap((route) => route.paths.map((routePath) => ({
    path: toOpenApiPath(routePath.path),
    method: route.method.toLowerCase(),
    auth: route.auth,
    rateLimit: route.rateLimit
  }))).sort((left, right) => `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`));
  const actual = Object.entries(document.paths).flatMap(([path, pathItem]) => Object.entries(pathItem).map(([method, operation]) => ({
    path,
    method,
    auth: operation["x-dockermap-auth-policy"],
    rateLimit: operation["x-dockermap-rate-limit"]
  }))).sort((left, right) => `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`));

  assert.deepEqual(actual, expected);
  assert.ok(document.paths["/api/v1"], "bare version alias must be explicit");
  assert.ok(document.paths["/api/v1/"], "trailing-slash version alias must be explicit");
  assert.equal(document.paths["/api/containers/{name}"]?.get?.parameters?.[0]?.name, "name");
  assert.equal(document.paths["/api/containers/{name}"]?.get?.parameters?.[0]?.in, "path");

  for (const pathItem of Object.values(document.paths)) {
    for (const operation of Object.values(pathItem)) {
      assert.ok(Object.values(operation.responses).every((response) => Boolean(response.description)));
      assert.equal("security" in operation, false, "deployment authentication is not an OpenAPI security scheme");
    }
  }
});

test("generated OpenAPI records the actual session and Compose request contracts", () => {
  const document = buildOpenApiDocument();
  const session = document.paths["/api/auth/session"]?.post;
  assert.equal(session?.responses["204"]?.description, "Successful response with no response body.");
  assert.deepEqual(session?.responses["401"]?.content, {
    "application/json": { schema: { $ref: "#/components/schemas/ApiError" } }
  });
  assert.deepEqual(session?.requestBody, {
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
  });

  for (const path of ["/api/compose/scan", "/api/compose/graph"]) {
    const file = document.paths[path]?.get?.parameters?.find((parameter) => parameter.name === "file");
    assert.deepEqual(file, {
      name: "file",
      in: "query",
      style: "form",
      explode: true,
      schema: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 512, pattern: "\\S" } }
    });
  }

  const editParameters = document.paths["/api/compose/edit-plan"]?.get?.parameters ?? [];
  assert.deepEqual(
    editParameters.filter((parameter) => parameter.required).map((parameter) => parameter.name),
    ["file", "service", "mount"]
  );
  assert.deepEqual(
    editParameters.filter((parameter) => !parameter.required).map((parameter) => parameter.name),
    ["source", "target"]
  );
  assert.deepEqual(editParameters.find((parameter) => parameter.name === "file")?.schema, {
    type: "string", minLength: 1, maxLength: 512, pattern: "\\S"
  });
  assert.deepEqual(editParameters.find((parameter) => parameter.name === "service")?.schema, {
    type: "string", minLength: 1, maxLength: 128, pattern: "\\S"
  });
});

test("OpenAPI query metadata is derived from the finite browser request declaration", () => {
  const document = buildOpenApiDocument();
  for (const [routeId, contract] of Object.entries(BROWSER_ROUTE_QUERY_CONTRACTS)) {
    const path = ROUTE_MANIFEST.find((route) => route.id === routeId)?.paths[0]?.path;
    assert.ok(path, `${routeId} must be a manifest route`);
    assert.deepEqual(document.paths[path]?.get?.parameters, openApiQueryParameters(contract));
  }
  assert.deepEqual(openApiQueryParameters(LOGS_QUERY_CONTRACT)[3]?.schema, { type: "integer", minimum: 1, maximum: 500 });
  assert.deepEqual(openApiQueryParameters(COMPOSE_EDIT_PLAN_QUERY_CONTRACT).filter((parameter) => parameter.required).map((parameter) => parameter.name), ["file", "service", "mount"]);
});

test("browser request contract coverage fails closed on planted mapping drift", () => {
  assert.throws(
    () => assertBrowserQueryContractCoverage({ ...BROWSER_ROUTE_QUERY_CONTRACTS, logs: { ...LOGS_QUERY_CONTRACT } }),
    { message: "Browser query route must use its canonical contract: logs" }
  );
  assert.throws(
    () => assertBrowserQueryContractCoverage({ ...BROWSER_ROUTE_QUERY_CONTRACTS, "compose-scan": undefined }),
    { message: "Browser query route is missing a contract mapping: compose-scan" }
  );
  assert.throws(
    () => assertBrowserQueryContractCoverage({ ...BROWSER_ROUTE_QUERY_CONTRACTS, unexpected: LOGS_QUERY_CONTRACT }),
    { message: "Browser query route has no declared contract: unexpected" }
  );
});

test("OpenAPI references generated Rust and Node response components exactly", () => {
  const document = buildOpenApiDocument();
  assert.deepEqual(document.components.schemas, { ...NODE_ENVELOPE_SCHEMAS, ...OPENAPI_RUST_RESPONSE_SCHEMAS });

  const nodeSuccesses: readonly [string, string][] = [
    ["/health", "RootHealth"],
    ["/api/health", "ApiHealth"],
    ["/api/status", "Status"],
    ["/api/auth/whoami", "AuthWhoami"],
    ["/api/diagnostics", "Diagnostics"],
    ["/api/v1", "Version"]
  ];
  for (const [path, schema] of nodeSuccesses) {
    assert.deepEqual(document.paths[path]?.get?.responses["200"]?.content, {
      "application/json": { schema: { $ref: `#/components/schemas/${schema}` } }
    }, path);
  }

  const rustSuccesses: readonly [string, RustResponseSchemaId][] = [
    ["/api/snapshot", "DockerSnapshot"],
    ["/api/graph", "GraphResponse"],
    ["/api/runtime/map", "RuntimeMap"],
    ["/api/containers", "ContainersResponse"],
    ["/api/containers/{name}", "ContainerDetailResponse"],
    ["/api/images", "ImagesResponse"],
    ["/api/networks", "NetworksResponse"],
    ["/api/volumes", "VolumesResponse"],
    ["/api/logs", "LogsResponse"],
    ["/api/compose/scan", "ComposeScan"],
    ["/api/compose/graph", "ComposeGraph"],
    ["/api/compose/edit-plan", "ComposeEditPlan"]
  ];
  for (const [path, schema] of rustSuccesses) {
    assert.deepEqual(document.paths[path]?.get?.responses["200"]?.content, {
      "application/json": { schema: { $ref: `#/components/schemas/${schema}` } }
    }, path);
    assert.deepEqual(document.paths[path]?.get?.responses["401"]?.content, {
      "application/json": { schema: { $ref: "#/components/schemas/ApiError" } }
    });
    assert.deepEqual(document.paths[path]?.get?.responses.default?.content, {
      "application/json": { schema: { $ref: "#/components/schemas/ApiError" } }
    }, `${path} must document route-dependent daemon errors`);
  }
});

test("OpenAPI derives the SSE named-event payload contract without duplicate schemas", () => {
  const document = buildOpenApiDocument();
  for (const path of ["/api/events/stream", "/api/v1/events/stream"]) {
    const stream = document.paths[path]?.get?.responses["200"];
    assert.equal(stream?.description.includes("Server-Sent Events"), true, path);
    const content = stream?.content?.[SSE_CONTENT_TYPE];
    assert.deepEqual(content?.schema, { type: "string", description: "UTF-8 Server-Sent Events framing; see x-dockermap-sse-events." });
    assert.deepEqual(content?.["x-dockermap-sse-events"], [
      { event: "snapshot", data: { $ref: "#/components/schemas/HealthResponse" }, "x-dockermap-schema-authority": "rust" },
      { event: "error", data: { $ref: "#/components/schemas/ApiError" }, "x-dockermap-schema-authority": "node" }
    ], path);
    assert.deepEqual(content?.["x-dockermap-sse-comment-frames"], [SSE_HEARTBEAT_COMMENT], path);
  }
  assert.deepEqual(SSE_EVENT_PAYLOAD_SCHEMAS.snapshot, { authority: "rust", schema: "HealthResponse" });
});

test("rejects SSE event-to-schema mapping drift", () => {
  const drift = {
    ...SSE_EVENT_PAYLOAD_SCHEMAS,
    snapshot: { authority: "node", schema: "ApiError" }
  } as unknown as typeof SSE_EVENT_PAYLOAD_SCHEMAS;
  assert.throws(() => assertSseEventSchemaCoverage(drift), /SSE event schema mapping drift: snapshot must be rust:HealthResponse/);
  assert.throws(
    () => assertSseEventSchemaCoverage({ ...SSE_EVENT_PAYLOAD_SCHEMAS, unexpected: SSE_EVENT_PAYLOAD_SCHEMAS.error }),
    /SSE event schema mapping has unexpected event names: error, snapshot, unexpected/
  );
});

test("SSE wire formatting derives named events and control frames from the protocol declaration", () => {
  assert.equal(SSE_CONTENT_TYPE, "text/event-stream");
  assert.deepEqual(SSE_EVENT, { snapshot: "snapshot", error: "error" });
  assert.equal(formatSseEvent(SSE_EVENT.snapshot, { status: "ok" }), "event: snapshot\ndata: {\"status\":\"ok\"}\n\n");
  assert.equal(formatSseEvent(SSE_EVENT.error, { code: "stream_error" }), "event: error\ndata: {\"code\":\"stream_error\"}\n\n");
  assert.equal(formatSseHeartbeat(), `: ${SSE_HEARTBEAT_COMMENT}\n\n`);
});

test("every Rust-owned route and alias has a declared generated schema reference", () => {
  const document = buildOpenApiDocument();
  const schemaByRoute = {
    snapshot: "DockerSnapshot",
    graph: "GraphResponse",
    "runtime-map": "RuntimeMap",
    findings: "FindingsResponse",
    history: "ObservedChangeHistoryResponse",
    containers: "ContainersResponse",
    container: "ContainerDetailResponse",
    images: "ImagesResponse",
    networks: "NetworksResponse",
    volumes: "VolumesResponse",
    logs: "LogsResponse",
    "compose-scan": "ComposeScan",
    "compose-graph": "ComposeGraph",
    "compose-edit-plan": "ComposeEditPlan"
  } as const satisfies Partial<Record<(typeof ROUTE_MANIFEST)[number]["id"], RustResponseSchemaId>>;

  for (const route of ROUTE_MANIFEST) {
    const expected = schemaByRoute[route.id as keyof typeof schemaByRoute];
    if (!expected) continue;
    for (const routePath of route.paths) {
      const operation = document.paths[toOpenApiPath(routePath.path)]?.[route.method.toLowerCase() as "get" | "post"];
      assert.deepEqual(operation?.responses["200"]?.content, {
        "application/json": { schema: { $ref: `#/components/schemas/${expected}` } }
      }, `${route.method} ${routePath.path}`);
    }
  }
});

test("rejects a missing Rust route schema mapping instead of silently documenting an untyped pass-through", () => {
  const missingSnapshot = { ...RUST_ROUTE_RESPONSE_SCHEMAS } as Partial<typeof RUST_ROUTE_RESPONSE_SCHEMAS>;
  delete missingSnapshot.snapshot;
  assert.throws(
    () => assertRustRouteSchemaCoverage(missingSnapshot),
    /Rust-owned route is missing a response schema mapping: snapshot/
  );
});

test("operation metadata is exhaustive for the route manifest", () => {
  assert.deepEqual(
    Object.keys(ROUTE_OPERATION_METADATA).sort(),
    ROUTE_MANIFEST.map((route) => route.id).sort()
  );
});
