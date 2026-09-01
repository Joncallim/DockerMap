import assert from "node:assert/strict";
import test from "node:test";
import SwaggerParser from "@apidevtools/swagger-parser";
import { buildOpenApiDocument, ROUTE_OPERATION_METADATA } from "../src/openapi.js";
import { ROUTE_MANIFEST } from "../src/routes.js";

function toOpenApiPath(path: string) {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

test("generated OpenAPI document passes parser validation", async () => {
  const document = buildOpenApiDocument();
  const validated = await SwaggerParser.validate(structuredClone(document));
  assert.equal(validated.openapi, "3.0.3");
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
  assert.deepEqual(session?.responses, { "204": { description: "Successful response with no response body." } });
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
    type: "string", minLength: 1, maxLength: 256, pattern: "\\S"
  });
});

test("operation metadata is exhaustive for the route manifest", () => {
  assert.deepEqual(
    Object.keys(ROUTE_OPERATION_METADATA).sort(),
    ROUTE_MANIFEST.map((route) => route.id).sort()
  );
});
