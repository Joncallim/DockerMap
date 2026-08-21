import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import net from "node:net";
import { afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

type ApiProcess = {
  port: number;
  child: ChildProcessWithoutNullStreams;
  logs: string[];
};

type DaemonRequest = {
  method: string;
  url: string;
  authorization: string | undefined;
};

type StubDaemon = {
  port: number;
  server: Server;
  requests: DaemonRequest[];
};

const apiEntry = "apps/api/src/index.ts";
const repoRoot = new URL("../../..", import.meta.url);
const processes: ApiProcess[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(processes.splice(0).map(stopApi));
  await Promise.all(servers.splice(0).map(stopServer));
});

test("every browser API route is bearer-gated except CORS preflight", async () => {
  const closedPort = await freePort();
  const api = await startApi({
    DOCKERMAP_ALLOW_MOCK: "true",
    DOCKERMAP_DAEMON_URL: `http://127.0.0.1:${closedPort}`,
    DOCKERMAP_API_TOKEN: "test-token"
  });

  const browserAliases = ["/health", "/api/health", "/api/v1", "/api/v1/", "/api/v1/health"];
  for (const path of browserAliases) {
    const unauthenticated = await request(api, path);
    assert.equal(unauthenticated.status, 401, path);
    assert.equal((await unauthenticated.json()).code, "unauthorized", path);

    const authenticated = await request(api, path, {
      headers: { Authorization: "Bearer test-token" }
    });
    assert.equal(authenticated.status, 200, path);
  }

  const unauthenticated = await request(api, "/api/snapshot");
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json()).code, "unauthorized");

  const wrongToken = await request(api, "/api/snapshot", {
    headers: { Authorization: "Bearer wrong-token" }
  });
  assert.equal(wrongToken.status, 401);

  const authenticated = await request(api, "/api/snapshot", {
    headers: { Authorization: "Bearer test-token" }
  });
  assert.equal(authenticated.status, 200);
  assert.ok(Array.isArray((await authenticated.json()).containers));

  const runtimeUnauthenticated = await request(api, "/api/runtime/map");
  assert.equal(runtimeUnauthenticated.status, 401);
  assert.equal((await runtimeUnauthenticated.json()).code, "unauthorized");

  const runtimeAuthenticated = await request(api, "/api/runtime/map", {
    headers: { Authorization: "Bearer test-token" }
  });
  assert.equal(runtimeAuthenticated.status, 200);
  assert.ok(Array.isArray((await runtimeAuthenticated.json()).nodes));
});

test("bearer mode exchanges the API token for a strict HttpOnly session cookie and can log out", async () => {
  const api = await startApi({
    DOCKERMAP_ALLOW_MOCK: "true",
    DOCKERMAP_DAEMON_URL: `http://127.0.0.1:${await freePort()}`,
    DOCKERMAP_API_TOKEN: "test-token"
  });

  const session = await request(api, "/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "test-token" })
  });
  assert.equal(session.status, 204);
  const setCookie = session.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /SameSite=Strict/);
  assert.doesNotMatch(setCookie, /Secure/);
  assert.doesNotMatch(setCookie, /test-token/);
  const cookie = setCookie.split(";", 1)[0];

  const authenticated = await request(api, "/api/snapshot", { headers: { Cookie: cookie } });
  assert.equal(authenticated.status, 200);

  const whoami = await request(api, "/api/auth/whoami", {
    headers: { Cookie: cookie }
  });
  assert.equal(whoami.status, 200);
  assert.equal((await whoami.json()).authenticated, true);

  const logout = await request(api, "/api/auth/session/logout", {
    method: "POST",
    headers: { Cookie: cookie }
  });
  assert.equal(logout.status, 204);
  const clearCookie = logout.headers.get("set-cookie") ?? "";
  assert.match(clearCookie, /dockermap_session=;/);
  assert.match(clearCookie, /Max-Age=0/);
  assert.match(clearCookie, /Path=\//);
  assert.match(clearCookie, /HttpOnly/);
  assert.match(clearCookie, /SameSite=Strict/);
  assert.doesNotMatch(clearCookie, /Secure/);
  assert.equal((await request(api, "/api/snapshot", { headers: { Cookie: cookie } })).status, 401);

  const invalidSession = await request(api, "/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "wrong-token" })
  });
  assert.equal(invalidSession.status, 401);

  const wrongCookie = await request(api, "/api/snapshot", {
    headers: { Cookie: "dockermap_session=wrong-token" }
  });
  assert.equal(wrongCookie.status, 401);

  const lookalike = await request(api, "/api/snapshot", {
    headers: { Cookie: "other=dockermap_session=test-token" }
  });
  assert.equal(lookalike.status, 401);
});

test("forward-auth does not bypass the bearer session login endpoint", async () => {
  const api = await startApi({
    DOCKERMAP_ALLOW_MOCK: "true",
    DOCKERMAP_API_TOKEN: "test-token",
    DOCKERMAP_AUTH_REQUIRED: "true"
  });

  const unauthenticated = await request(api, "/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "test-token" })
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json()).code, "auth_required");

  const forwarded = await request(api, "/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Remote-User": "alice" },
    body: JSON.stringify({ token: "test-token" })
  });
  assert.equal(forwarded.status, 401);
});

test("session cookies are Secure for HTTPS forwarded requests", async () => {
  const api = await startApi({
    DOCKERMAP_ALLOW_MOCK: "true",
    DOCKERMAP_API_TOKEN: "test-token"
  });
  const session = await request(api, "/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https" },
    body: JSON.stringify({ token: "test-token" })
  });
  assert.equal(session.status, 204);
  assert.match(session.headers.get("set-cookie") ?? "", /Secure/);

  const cookie = (session.headers.get("set-cookie") ?? "").split(";", 1)[0];
  const logout = await request(api, "/api/auth/session/logout", {
    method: "POST",
    headers: { Cookie: cookie, "X-Forwarded-Proto": "https" }
  });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get("set-cookie") ?? "", /Secure/);
});

test("CORS only reflects explicitly allowed origins", async () => {
  const api = await startApi({
    DOCKERMAP_ALLOW_MOCK: "true",
    DOCKERMAP_ALLOWED_ORIGINS: "http://127.0.0.1:3233"
  });

  const allowed = await request(api, "/api/health", {
    headers: { Origin: "http://127.0.0.1:3233" }
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://127.0.0.1:3233");

  const denied = await request(api, "/api/health", {
    headers: { Origin: "https://example.test" }
  });
  assert.equal(denied.status, 200);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);

  const preflight = await request(api, "/api/snapshot", {
    method: "OPTIONS",
    headers: {
      Origin: "http://127.0.0.1:3233",
      "Access-Control-Request-Method": "GET"
    }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "http://127.0.0.1:3233");
});

test("whoami publishes every forward-auth identity field before responding", async () => {
  const sentinel = "DOCKERMAP_TEST_FAKE_SOL5_WHOAMI_SECRET";
  const hostile = (field: string) => `${field}=token=${sentinel}${String.fromCharCode(0x80)}`;
  const api = await startApi({
    DOCKERMAP_ALLOW_MOCK: "true",
    DOCKERMAP_API_TOKEN: "test-token",
    DOCKERMAP_AUTH_REQUIRED: "true"
  });

  const response = await request(api, "/api/auth/whoami", {
    headers: {
      Authorization: "Bearer test-token",
      "X-Remote-User": hostile("user"),
      "X-Remote-Name": hostile("name"),
      "X-Remote-Email": hostile("email"),
      "X-Remote-Groups": `${hostile("group-one")}, ${hostile("group-two")}`
    }
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.authenticated, true);
  assert.equal(body.required, true);
  assertPublishedPayload(body, sentinel, "whoami identity response");
});

test("forward-auth mode wins over a configured bearer token, including SSE", async () => {
  const api = await startApi({
    DOCKERMAP_ALLOW_MOCK: "true",
    DOCKERMAP_API_TOKEN: "test-token",
    DOCKERMAP_AUTH_REQUIRED: "true"
  });
  const identity = { "X-Remote-User": "alice" };

  const identityOnly = await request(api, "/api/snapshot", { headers: identity });
  assert.equal(identityOnly.status, 200);

  const bearerOnly = await request(api, "/api/snapshot", {
    headers: { Authorization: "Bearer test-token" }
  });
  assert.equal(bearerOnly.status, 401);
  assert.equal((await bearerOnly.json()).code, "auth_required");

  const stream = await request(api, "/api/events/stream", { headers: identity });
  assert.equal(stream.status, 200);
  assert.match(await readFirstChunk(stream), /event: snapshot/);
});

test("auth runs before JSON parsing and authenticated parser failures are neutral", async () => {
  const api = await startApi({
    DOCKERMAP_ALLOW_MOCK: "true",
    DOCKERMAP_API_TOKEN: "test-token"
  });
  const malformed = Buffer.from("{not json");
  const oversized = Buffer.from(JSON.stringify({ value: "x".repeat(20_000) }));
  const compressedMalformed = gzipSync(malformed);

  for (const [body, encoding] of [[malformed, undefined], [oversized, undefined], [compressedMalformed, "gzip"]] as const) {
    const response = await rawRequest(api, "/api/snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(encoding ? { "Content-Encoding": encoding } : {}) },
      body
    });
    assert.equal(response.status, 401, response.body);
  }

  const authenticatedMalformed = await rawRequest(api, "/api/snapshot", {
    method: "POST",
    headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
    body: malformed
  });
  assert.equal(authenticatedMalformed.status, 400);
  assert.deepEqual(JSON.parse(authenticatedMalformed.body), {
    code: "invalid_json",
    message: "Request body is invalid"
  });

  const authenticatedOversized = await rawRequest(api, "/api/snapshot", {
    method: "POST",
    headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
    body: oversized
  });
  assert.equal(authenticatedOversized.status, 413);
  assert.deepEqual(JSON.parse(authenticatedOversized.body), {
    code: "payload_too_large",
    message: "Request body is too large"
  });
});

test("query validation rejects oversized, malformed, and excessive compose requests", async () => {
  const api = await startApi({ DOCKERMAP_ALLOW_MOCK: "true" });

  const tooManyFiles = new URLSearchParams();
  for (let index = 0; index < 9; index += 1) {
    tooManyFiles.append("file", `compose-${index}.yaml`);
  }
  const tooMany = await request(api, `/api/compose/scan?${tooManyFiles}`);
  assert.equal(tooMany.status, 400);
  assert.equal((await tooMany.json()).code, "too_many_compose_files");

  const oversizedFile = "a".repeat(513);
  const oversized = await request(api, `/api/compose/scan?file=${oversizedFile}`);
  assert.equal(oversized.status, 400);
  assert.equal((await oversized.json()).code, "invalid_compose_file");

  const missingEditQuery = await request(api, "/api/compose/edit-plan");
  assert.equal(missingEditQuery.status, 400);
  assert.equal((await missingEditQuery.json()).code, "invalid_query");

  const badMount = await request(api, "/api/compose/edit-plan?file=compose.yaml&service=api&mount=0x10");
  assert.equal(badMount.status, 400);
  assert.equal((await badMount.json()).message, "Query parameter mount must be a zero-based integer");
});

test("read-only routes reject write verbs even when the caller is authenticated", async () => {
  const api = await startApi({
    DOCKERMAP_ALLOW_MOCK: "true",
    DOCKERMAP_API_TOKEN: "test-token"
  });

  const writeAttempt = await request(api, "/api/compose/scan", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-token",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ file: "compose.yaml" })
  });

  assert.equal(writeAttempt.status, 404);
  assert.equal((await writeAttempt.json()).code, "not_found");
});

test("logs and compose query validation rejects arrays, null bytes, and oversized values", async () => {
  const api = await startApi({ DOCKERMAP_ALLOW_MOCK: "true" });

  const duplicateLogFilter = await request(api, "/api/logs?q=error&q=warn");
  assert.equal(duplicateLogFilter.status, 400);
  assert.equal((await duplicateLogFilter.json()).message, "Query parameter q must be a string");

  const oversizedLogFilter = await request(api, `/api/logs?q=${"x".repeat(257)}`);
  assert.equal(oversizedLogFilter.status, 400);
  assert.equal((await oversizedLogFilter.json()).message, "Query parameter q must be 256 characters or fewer");

  const fileWithNullByte = await request(
    api,
    `/api/compose/scan?${new URLSearchParams({ file: "compose\0prod.yaml" }).toString()}`
  );
  assert.equal(fileWithNullByte.status, 400);
  assert.equal((await fileWithNullByte.json()).code, "invalid_compose_file");

  const duplicateMount = await request(
    api,
    "/api/compose/edit-plan?file=compose.yaml&service=api&mount=1&mount=2"
  );
  assert.equal(duplicateMount.status, 400);
  assert.equal((await duplicateMount.json()).message, "Query parameter mount must be a string");
});

test("log pagination rejects invalid cursor and limit values", async () => {
  const api = await startApi({ DOCKERMAP_ALLOW_MOCK: "true" });

  const zeroLimit = await request(api, "/api/logs?limit=0");
  assert.equal(zeroLimit.status, 400);
  assert.equal(
    (await zeroLimit.json()).message,
    "Query parameter limit must be between 1 and 500"
  );

  const oversizedLimit = await request(api, "/api/logs?limit=501");
  assert.equal(oversizedLimit.status, 400);
  assert.equal(
    (await oversizedLimit.json()).message,
    "Query parameter limit must be between 1 and 500"
  );

  const nonNumericLimit = await request(api, "/api/logs?limit=abc");
  assert.equal(nonNumericLimit.status, 400);
  assert.equal((await nonNumericLimit.json()).message, "Query parameter limit must be an integer");

  const duplicateLimit = await request(api, "/api/logs?limit=50&limit=60");
  assert.equal(duplicateLimit.status, 400);
  assert.equal((await duplicateLimit.json()).message, "Query parameter limit must be an integer");

  const nonNumericCursor = await request(api, "/api/logs?cursor=not-a-cursor");
  assert.equal(nonNumericCursor.status, 400);
  assert.equal(
    (await nonNumericCursor.json()).message,
    "Query parameter cursor must be `millis` or `millis:offset`"
  );

  const badOffsetCursor = await request(api, "/api/logs?cursor=123:not-a-number");
  assert.equal(badOffsetCursor.status, 400);

  const oversizedCursor = await request(api, `/api/logs?cursor=${"9".repeat(33)}`);
  assert.equal(oversizedCursor.status, 400);

  // Compound "millis:offset" cursors are the emitted format and must pass.
  const compoundCursor = await request(api, "/api/logs?cursor=1787198706123:2&limit=5");
  assert.equal(compoundCursor.status, 200);
});

test("log service param caps at the daemon's 128-char container-name limit", async () => {
  const api = await startApi({ DOCKERMAP_ALLOW_MOCK: "true" });

  // 128 chars is the daemon's MAX_LOG_SERVICE_CHARS; the API must accept it.
  const atCap = await request(api, `/api/logs?service=${"a".repeat(128)}`);
  assert.equal(atCap.status, 200);

  // 129 chars previously passed the API's 256-char query cap only to 400 at
  // the daemon; the API now rejects it directly.
  const overCap = await request(api, `/api/logs?service=${"a".repeat(129)}`);
  assert.equal(overCap.status, 400);
  assert.equal(
    (await overCap.json()).message,
    "Query parameter service must be 128 characters or fewer"
  );
});

test("diagnostics aggregates compose and runtime findings", async () => {
  const api = await startApi({ DOCKERMAP_ALLOW_MOCK: "true" });

  const response = await request(api, "/api/diagnostics");
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(typeof body.generatedAt, "number");
  assert.ok(Array.isArray(body.entries));
  assert.ok(
    body.entries.some((entry: { source: string }) => entry.source === "compose"),
    "compose diagnostics should be aggregated"
  );
  assert.ok(
    body.entries.some((entry: { source: string }) => entry.source === "runtime"),
    "runtime diagnostics should be aggregated"
  );
});

test("diagnostics aggregation normalizes compose diagnostic origins", async () => {
  const daemon = await startStubDaemon((req, res) => {
    if (req.url === "/daemon/compose/scan") {
      sendJson(res, 200, {
        files: ["/project\u202e/compose.yaml"],
        projectRoot: "/project\u202e",
        services: [],
        mounts: [],
        correlations: [],
        diagnostics: [
          {
            id: "compose\u202eid",
            severity: "warning",
            message: "message\u202etext",
            origin: {
              file: "/project\u202e/compose.yaml",
              service: "service\u202ename",
              field: "services\u202e.web"
            }
          }
        ]
      });
      return;
    }
    if (req.url === "/daemon/runtime/map") {
      sendJson(res, 200, { nodes: [], edges: [], diagnostics: [], lastUpdated: 1 });
      return;
    }
    sendJson(res, 404, { code: "not_found", message: "missing" });
  });
  const api = await startApi({
    DOCKERMAP_DAEMON_URL: `http://127.0.0.1:${daemon.port}`,
    DOCKERMAP_API_TOKEN: "test-token"
  });

  const response = await request(api, "/api/diagnostics", {
    headers: { Authorization: "Bearer test-token" }
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  const compose = body.entries.find((entry: { source: string }) => entry.source === "compose");
  assert.ok(compose, "compose diagnostic should be aggregated");
  assert.doesNotMatch(JSON.stringify(compose), /\u202e/);
  assert.equal(compose.id, "compose�id");
  assert.equal(compose.message, "message�text");
  assert.equal(compose.file, "/project�/compose.yaml");
  assert.equal(compose.service, "service�name");
});

test("status endpoint reports widget-friendly health and versioned alias works", async () => {
  const api = await startApi({ DOCKERMAP_ALLOW_MOCK: "true" });

  const status = await request(api, "/api/status");
  assert.equal(status.status, 200);
  const body = await status.json();
  assert.equal(body.service, "dockermap");
  assert.equal(typeof body.containers, "number");
  assert.equal(typeof body.containersRunning, "number");
  assert.equal(typeof body.version, "string");

  const versioned = await request(api, "/api/v1/status");
  assert.equal(versioned.status, 200);
  assert.deepEqual(await versioned.json(), body);

  const openapi = await request(api, "/api/openapi.json");
  assert.equal(openapi.status, 200);
  const doc = await openapi.json();
  assert.equal(doc.openapi, "3.0.3");
  assert.ok(doc.paths["/api/logs"], "openapi should document the logs route");
  assert.ok(doc.paths["/api/diagnostics"], "openapi should document diagnostics");
});

test("status endpoint classifies free-form docker status texts", async () => {
  const daemon = await startStubDaemon((req, res) => {
    if (req.url === "/daemon/health") {
      sendJson(res, 200, {
        status: "ok",
        mode: "live",
        dockerReachable: true,
        lastUpdated: 1,
        snapshotVersion: "1",
        message: "stub daemon"
      });
      return;
    }

    if (req.url === "/daemon/snapshot") {
      sendJson(res, 200, {
        containers: [
          {
            id: "c1",
            name: "web",
            image: "nginx:1.27",
            status: "Up 3 hours",
            role: "web",
            networks: [],
            ports: [],
            mounts: [],
            dependsOn: []
          },
          {
            id: "c2",
            name: "db",
            image: "postgres:16",
            status: "Exited (0) 1 minute ago",
            role: "db",
            networks: [],
            ports: [],
            mounts: [],
            dependsOn: []
          },
          {
            id: "c3",
            name: "cache",
            image: "redis:7",
            status: "running",
            role: "cache",
            networks: [],
            ports: [],
            mounts: [],
            dependsOn: []
          },
          {
            id: "c4",
            name: "job",
            image: "busybox:1.36",
            status: "Created",
            role: "job",
            networks: [],
            ports: [],
            mounts: [],
            dependsOn: []
          }
        ],
        images: [],
        networks: [],
        volumes: [],
        lastUpdated: 1
      });
      return;
    }

    sendJson(res, 404, { code: "not_found", message: "missing" });
  });

  const api = await startApi({
    DOCKERMAP_DAEMON_URL: `http://127.0.0.1:${daemon.port}`,
    DOCKERMAP_API_TOKEN: "test-token"
  });

  const response = await request(api, "/api/status", {
    headers: { Authorization: "Bearer test-token" }
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.containers, 4);
  assert.equal(body.containersRunning, 2, "Up 3 hours and running count as running");
  assert.equal(body.offline, 1, "Exited (0) counts as offline");
  assert.equal(body.attention, 1, "Created counts as attention");
  assert.equal(body.healthy, 2);
  assert.equal(body.status, "degraded");
});

test("bare /api/v1 answers with a version descriptor instead of 404ing", async () => {
  const api = await startApi({ DOCKERMAP_ALLOW_MOCK: "true" });

  const bare = await request(api, "/api/v1");
  assert.equal(bare.status, 200);
  assert.deepEqual(await bare.json(), {
    service: "dockermap",
    apiVersion: "v1",
    version: "0.1.0"
  });

  const slashed = await request(api, "/api/v1/");
  assert.equal(slashed.status, 200);
  assert.equal((await slashed.json()).apiVersion, "v1");

  const versionedRoute = await request(api, "/api/v1/health");
  assert.equal(versionedRoute.status, 200, "versioned routes still alias the /api surface");
});

test("runtime map mock emits layer and service entities matching the daemon", async () => {
  const api = await startApi({ DOCKERMAP_ALLOW_MOCK: "true" });
  const response = await request(api, "/api/runtime/map");
  assert.equal(response.status, 200);

  const map = await response.json();
  const container = map.nodes.find((node: { type: string }) => node.type === "container");
  assert.ok(container, "mock runtime map should include container nodes");
  assert.equal(container.layer, "container");
  assert.equal(container.service.name, container.label);
  assert.ok(Array.isArray(container.service.logs), "service entity keeps the full contract shape");
  assert.equal(container.service.dependencies.length, 0);

  const network = map.nodes.find((node: { type: string }) => node.type === "docker_network");
  assert.equal(network.layer, "network");
  const volume = map.nodes.find((node: { type: string }) => node.type === "docker_volume");
  assert.equal(volume.layer, "storage");
});

test("mock logs honor service and q filters like the daemon mock", async () => {
  const api = await startApi({
    DOCKERMAP_ALLOW_MOCK: "true",
    DOCKERMAP_DAEMON_URL: `http://127.0.0.1:${await freePort()}`
  });

  const all = await request(api, "/api/logs");
  assert.equal(all.status, 200);
  const allBody = await all.json();
  assert.ok(allBody.entries.length > 1, "unfiltered mock logs span every container");

  const byService = await request(api, "/api/logs?service=api");
  assert.equal(byService.status, 200);
  const serviceBody = await byService.json();
  assert.ok(serviceBody.entries.length > 0, "api container has mock log entries");
  assert.ok(
    serviceBody.entries.every((entry: { container: string }) => entry.container === "api"),
    "service filter returns only the requested container's entries"
  );

  const byQuery = await request(api, "/api/logs?q=postgres");
  assert.equal(byQuery.status, 200);
  const queryBody = await byQuery.json();
  assert.ok(queryBody.entries.length > 0, "substring filter matches at least one entry");
  assert.ok(
    queryBody.entries.every((entry: { message: string }) =>
      entry.message.toLowerCase().includes("postgres")
    ),
    "q filter is a case-insensitive message substring"
  );
  assert.ok(
    queryBody.entries.every((entry: { container: string }) => entry.container === "postgres"),
    "the postgres message substring only exists on postgres entries"
  );

  const combined = await request(api, "/api/logs?service=worker&q=worker");
  const combinedBody = await combined.json();
  assert.ok(
    combinedBody.entries.every(
      (entry: { container: string; message: string }) =>
        entry.container === "worker" && entry.message.toLowerCase().includes("worker")
    ),
    "service and q filters compose"
  );
});

test("daemon failures hide details by default and expose details only when explicitly enabled", async () => {
  const closedPort = await freePort();
  const hidden = await startApi({
    DOCKERMAP_DAEMON_URL: `http://127.0.0.1:${closedPort}`
  });
  const hiddenResponse = await request(hidden, "/api/snapshot");
  assert.equal(hiddenResponse.status, 502);
  const hiddenBody = await hiddenResponse.json();
  assert.equal(hiddenBody.message, "Unable to reach DockerMap daemon");
  assert.equal(Object.hasOwn(hiddenBody, "details"), false);
  assert.doesNotMatch(JSON.stringify(hiddenBody), new RegExp(String(closedPort)));

  await stopApi(hidden);
  processes.splice(processes.indexOf(hidden), 1);

  const exposed = await startApi({
    DOCKERMAP_DAEMON_URL: `http://127.0.0.1:${closedPort}`,
    DOCKERMAP_EXPOSE_ERROR_DETAILS: "true"
  });
  const exposedResponse = await request(exposed, "/api/snapshot");
  assert.equal(exposedResponse.status, 502);
  const exposedBody = await exposedResponse.json();
  assert.equal(exposedBody.message, "Unable to reach DockerMap daemon");
  assert.equal(typeof exposedBody.details, "string");
  assert.doesNotMatch(JSON.stringify(exposedBody), new RegExp(String(closedPort)));
});

test("runtime map daemon failures keep error details hidden unless explicitly exposed", async () => {
  const closedPort = await freePort();
  const hidden = await startApi({
    DOCKERMAP_DAEMON_URL: `http://127.0.0.1:${closedPort}`,
    DOCKERMAP_API_TOKEN: "test-token"
  });

  const hiddenResponse = await request(hidden, "/api/runtime/map", {
    headers: { Authorization: "Bearer test-token" }
  });
  assert.equal(hiddenResponse.status, 502);
  const hiddenBody = await hiddenResponse.json();
  assert.equal(hiddenBody.code, "daemon_unavailable");
  assert.equal(hiddenBody.message, "Unable to reach DockerMap daemon");
  assert.equal(Object.hasOwn(hiddenBody, "details"), false);

  await stopApi(hidden);
  processes.splice(processes.indexOf(hidden), 1);

  const exposed = await startApi({
    DOCKERMAP_DAEMON_URL: `http://127.0.0.1:${closedPort}`,
    DOCKERMAP_API_TOKEN: "test-token",
    DOCKERMAP_EXPOSE_ERROR_DETAILS: "true"
  });

  const exposedResponse = await request(exposed, "/api/runtime/map", {
    headers: { Authorization: "Bearer test-token" }
  });
  assert.equal(exposedResponse.status, 502);
  const exposedBody = await exposedResponse.json();
  assert.equal(exposedBody.message, "Unable to reach DockerMap daemon");
  assert.equal(typeof exposedBody.details, "string");
});

test("daemon HTTP errors stay redacted on JSON routes and event streams unless explicitly enabled", async () => {
  const daemon = await startStubDaemon((req, res) => {
    if (req.url === "/daemon/health") {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("systemd token=alpha-secret");
      return;
    }

    if (req.url === "/daemon/runtime/map") {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("tmux pane SECRET=alpha-secret");
      return;
    }

    sendJson(res, 404, { code: "not_found", message: "missing" });
  });

  const hidden = await startApi({
    DOCKERMAP_DAEMON_URL: `http://127.0.0.1:${daemon.port}`,
    DOCKERMAP_API_TOKEN: "test-token"
  });

  const hiddenJson = await request(hidden, "/api/runtime/map", {
    headers: { Authorization: "Bearer test-token" }
  });
  assert.equal(hiddenJson.status, 500);
  const hiddenPayload = await hiddenJson.json();
  assert.equal(hiddenPayload.message, "Daemon request failed for /daemon/runtime/map");
  assert.equal(Object.hasOwn(hiddenPayload, "details"), false);

  const hiddenStream = await request(hidden, "/api/events/stream", {
    headers: { Authorization: "Bearer test-token" }
  });
  const hiddenChunk = await readFirstChunk(hiddenStream);
  assert.match(hiddenChunk, /event: error/);
  assert.match(hiddenChunk, /"code":"daemon_503"/);
  assert.doesNotMatch(hiddenChunk, /alpha-secret/);

  await stopApi(hidden);
  processes.splice(processes.indexOf(hidden), 1);

  const exposed = await startApi({
    DOCKERMAP_DAEMON_URL: `http://127.0.0.1:${daemon.port}`,
    DOCKERMAP_API_TOKEN: "test-token",
    DOCKERMAP_EXPOSE_ERROR_DETAILS: "true"
  });

  const exposedJson = await request(exposed, "/api/runtime/map", {
    headers: { Authorization: "Bearer test-token" }
  });
  assert.equal(exposedJson.status, 500);
  const exposedBody = await exposedJson.json();
  assert.equal(exposedBody.details, "[redacted]");
  assert.doesNotMatch(exposedBody.details, /alpha-secret/);
});

test("SSE stream survives a client disconnect mid-emit without crashing the API", async () => {
  const daemon = await startStubDaemon((req, res) => {
    if (req.url === "/daemon/health") {
      // Slow daemon: the first emit is still awaiting this response when the
      // client disconnects, so a write-after-end would fire on resolution.
      setTimeout(() => {
        sendJson(res, 200, {
          status: "ok",
          mode: "live",
          dockerReachable: true,
          lastUpdated: 1,
          snapshotVersion: "1",
          message: "stub daemon"
        });
      }, 2_000);
      return;
    }
    sendJson(res, 404, { code: "not_found", message: "missing" });
  });

  const api = await startApi({
    DOCKERMAP_DAEMON_URL: `http://127.0.0.1:${daemon.port}`,
    DOCKERMAP_API_TOKEN: "test-token",
    DOCKERMAP_SSE_INTERVAL_MS: "1000"
  });

  const controller = new AbortController();
  const streamPromise = request(api, "/api/events/stream", {
    headers: { Authorization: "Bearer test-token" },
    signal: controller.signal
  });
  const stream = await streamPromise;
  const reader = stream.body?.getReader();
  assert.ok(reader, "expected a streaming response body");
  await reader.cancel().catch(() => undefined);

  // Disconnect while the first emit is still awaiting the slow daemon, then
  // wait past the daemon's response — the window in which a write-after-end
  // (and the catch block writing again) would have crashed the process.
  controller.abort();
  await delay(2_500);

  assert.equal(api.child.exitCode, null, "API must not crash on write-after-end");
  const health = await request(api, "/api/health", {
    headers: { Authorization: "Bearer test-token" }
  });
  assert.equal(health.status, 200, "API must keep serving routes after the disconnect");
});

test("unsafe startup configuration fails before listening", async () => {
  await assertStartupFailure({ DOCKERMAP_DAEMON_URL: "ftp://127.0.0.1:4100" }, "must use http or https");
  await assertStartupFailure({ DOCKERMAP_DAEMON_URL: "http://192.0.2.10:4100" }, "must be loopback");
  await assertStartupFailure({ DOCKERMAP_ALLOWED_ORIGINS: "*" }, "wildcard is not allowed");
  await assertStartupFailure(
    { DOCKERMAP_ALLOWED_ORIGINS: "https://example.test/review" },
    "must contain origins only, not paths"
  );
  await assertStartupFailure(
    { DOCKERMAP_ALLOWED_ORIGINS: "ws://127.0.0.1:3233" },
    "contains unsupported origin"
  );
  await assertStartupFailure({ DOCKERMAP_API_TOKEN: "   " }, "must not be empty");
});

test("API forwards fixed read-only daemon paths with normalized query encoding", async () => {
  const daemon = await startStubDaemon((req, res) => {
    if (req.url === "/daemon/health") {
      sendJson(res, 200, {
        status: "ok",
        mode: "live",
        dockerReachable: true,
        lastUpdated: 1,
        snapshotVersion: "1",
        message: "stub daemon"
      });
      return;
    }

    if (req.url?.startsWith("/daemon/logs")) {
      sendJson(res, 200, { service: "worker", entries: [], nextCursor: null });
      return;
    }

    if (req.url?.startsWith("/daemon/compose/scan")) {
      sendJson(res, 200, {
        files: [],
        projectRoot: "/workspace",
        services: [],
        mounts: [],
        correlations: [],
        diagnostics: []
      });
      return;
    }

    if (req.url?.startsWith("/daemon/containers/")) {
      sendJson(res, 200, {
        id: "container-1",
        name: "api/worker",
        image: "python:3.11-slim",
        status: "running",
        role: "worker",
        ports: [],
        createdAt: 1,
        mounts: []
      });
      return;
    }

    sendJson(res, 404, { code: "not_found", message: "missing" });
  });

  const api = await startApi({
    DOCKERMAP_DAEMON_URL: `http://127.0.0.1:${daemon.port}`,
    DOCKERMAP_API_TOKEN: "test-token"
  });

  const logsParams = new URLSearchParams({ service: "worker", q: "error timeout" });
  const logsResponse = await request(api, `/api/logs?${logsParams.toString()}`, {
    headers: { Authorization: "Bearer test-token" }
  });
  assert.equal(logsResponse.status, 200);

  const paginatedLogs = await request(
    api,
    "/api/logs?service=worker&q=error&cursor=1785175506123&limit=50",
    {
      headers: { Authorization: "Bearer test-token" }
    }
  );
  assert.equal(paginatedLogs.status, 200);

  const composeParams = new URLSearchParams();
  composeParams.append("file", "docker-compose.yml");
  composeParams.append("file", "stack/systemd-proxy.yml");
  const composeResponse = await request(api, `/api/compose/scan?${composeParams.toString()}`, {
    headers: { Authorization: "Bearer test-token" }
  });
  assert.equal(composeResponse.status, 200);

  const containerResponse = await request(api, "/api/containers/api%2Fworker", {
    headers: { Authorization: "Bearer test-token" }
  });
  assert.equal(containerResponse.status, 200);

  assert.ok(
    daemon.requests.some((entry) => entry.method === "GET" && entry.url === "/daemon/logs?service=worker&q=error+timeout")
  );
  assert.ok(
    daemon.requests.some(
      (entry) =>
        entry.method === "GET" &&
        entry.url === "/daemon/logs?service=worker&q=error&cursor=1785175506123&limit=50"
    )
  );
  assert.ok(
    daemon.requests.some(
      (entry) =>
        entry.method === "GET" &&
        entry.url === "/daemon/compose/scan?file=docker-compose.yml%2Cstack%2Fsystemd-proxy.yml"
    )
  );
  assert.ok(
    daemon.requests.some((entry) => entry.method === "GET" && entry.url === "/daemon/containers/api%2Fworker")
  );
  assert.ok(
    daemon.requests.every((entry) => entry.authorization === "Bearer test-token"),
    "every daemon proxy request carries the fallback API token"
  );
});

test("API sends the dedicated daemon token before falling back to the API token", async () => {
  for (const tokenCase of [
    {
      name: "dedicated daemon token",
      env: { DOCKERMAP_API_TOKEN: "browser-token", DOCKERMAP_DAEMON_TOKEN: "daemon-token" },
      expectedAuthorization: "Bearer daemon-token"
    },
    {
      name: "API token fallback",
      env: { DOCKERMAP_API_TOKEN: "browser-token" },
      expectedAuthorization: "Bearer browser-token"
    }
  ]) {
    const daemon = await startStubDaemon((req, res) => {
      if (req.headers.authorization !== tokenCase.expectedAuthorization) {
        sendJson(res, 401, { code: "unauthorized", message: "daemon token missing" });
        return;
      }
      if (req.url === "/daemon/health") {
        sendJson(res, 200, {
          status: "ok",
          mode: "mock",
          dockerReachable: false,
          lastUpdated: 1,
          snapshotVersion: "1",
          message: "stub daemon"
        });
        return;
      }
      if (req.url === "/daemon/snapshot") {
        sendJson(res, 200, { containers: [], images: [], networks: [], volumes: [], lastUpdated: 1 });
        return;
      }
      sendJson(res, 404, { code: "not_found", message: "missing" });
    });
    const api = await startApi({
      DOCKERMAP_DAEMON_URL: `http://127.0.0.1:${daemon.port}`,
      ...tokenCase.env
    });
    const auth = { Authorization: "Bearer browser-token" };

    const health = await request(api, "/api/health", { headers: auth });
    assert.equal(health.status, 200, tokenCase.name);
    const snapshot = await request(api, "/api/snapshot", { headers: auth });
    assert.equal(snapshot.status, 200, tokenCase.name);
    assert.ok(
      daemon.requests.every((entry) => entry.authorization === tokenCase.expectedAuthorization),
      tokenCase.name
    );

    await stopApi(api);
    processes.splice(processes.indexOf(api), 1);
    await stopServer(daemon.server);
    servers.splice(servers.indexOf(daemon.server), 1);
  }
});

test("API publishes redacted and normalized daemon data on every response route", async () => {
  const sentinel = "DOCKERMAP_TEST_FAKE_API_ROUTE_SECRET";
  const hostile = `token=${sentinel}\u202e\u200b\u001b\u2028\ufdd0`;
  const snapshot = {
    containers: [
      {
        id: hostile,
        name: hostile,
        image: hostile,
        status: hostile,
        role: hostile,
        networks: [hostile],
        ports: [hostile],
        mounts: [{ id: hostile, kind: "bind", source: hostile, target: hostile, readOnly: false }],
        dependsOn: [hostile]
      }
    ],
    images: [{ image: hostile, containers: [hostile], status: hostile }],
    networks: [{ id: hostile, name: hostile, driver: hostile, internal: false, members: [hostile] }],
    volumes: [{ id: hostile, name: hostile, attachedTo: [hostile] }],
    lastUpdated: 1
  };
  const daemon = await startStubDaemon((req, res) => {
    if (req.url === "/daemon/health") {
      sendJson(res, 200, {
        status: "degraded",
        mode: "mock",
        dockerReachable: false,
        lastUpdated: 1,
        snapshotVersion: hostile,
        message: hostile
      });
      return;
    }
    if (req.url === "/daemon/snapshot") {
      sendJson(res, 200, snapshot);
      return;
    }
    if (req.url === "/daemon/graph") {
      sendJson(res, 200, { nodes: [{ id: hostile, type: "container", label: hostile }], edges: [{ source: hostile, target: hostile, relationship: "mounts" }] });
      return;
    }
    if (req.url === "/daemon/runtime/map") {
      sendJson(res, 200, {
        nodes: [{ id: hostile, provider: "other", type: "service", label: hostile, status: hostile, metadata: { [hostile]: hostile } }],
        edges: [{ source: hostile, target: hostile, relationship: "depends_on", metadata: { [hostile]: hostile } }],
        diagnostics: [{ provider: "other", severity: "warning", message: hostile }],
        lastUpdated: 1
      });
      return;
    }
    if (req.url === "/daemon/containers") {
      sendJson(res, 200, { containers: snapshot.containers });
      return;
    }
    if (req.url?.startsWith("/daemon/containers/")) {
      sendJson(res, 200, snapshot.containers[0]);
      return;
    }
    if (req.url === "/daemon/images") {
      sendJson(res, 200, { images: snapshot.images });
      return;
    }
    if (req.url === "/daemon/networks") {
      sendJson(res, 200, { networks: snapshot.networks });
      return;
    }
    if (req.url === "/daemon/volumes") {
      sendJson(res, 200, { volumes: snapshot.volumes });
      return;
    }
    if (req.url?.startsWith("/daemon/logs")) {
      sendJson(res, 200, {
        service: hostile,
        entries: [{ id: hostile, timestamp: 1, container: hostile, level: "info", message: hostile }],
        nextCursor: null
      });
      return;
    }
    if (req.url?.startsWith("/daemon/compose/scan")) {
      sendJson(res, 200, {
        files: [hostile],
        projectRoot: hostile,
        services: [{ name: hostile, image: hostile, environment: { [hostile]: hostile }, dependsOn: [hostile] }],
        mounts: [],
        correlations: [],
        diagnostics: [{ id: hostile, severity: "warning", message: hostile, origin: { file: hostile, service: hostile, field: hostile } }]
      });
      return;
    }
    if (req.url?.startsWith("/daemon/compose/graph")) {
      sendJson(res, 200, { nodes: [{ id: hostile, type: "service", label: hostile }], edges: [{ source: hostile, target: hostile, relationship: "declares_mount" }] });
      return;
    }
    if (req.url?.startsWith("/daemon/compose/edit-plan")) {
      sendJson(res, 200, {
        file: hostile,
        service: hostile,
        mountId: hostile,
        originalSource: hostile,
        originalTarget: hostile,
        newSource: hostile,
        newTarget: hostile,
        unifiedDiff: hostile,
        diagnostics: [{ id: hostile, severity: "warning", message: hostile, origin: { file: hostile, service: hostile, field: hostile } }],
        willWrite: false
      });
      return;
    }
    sendJson(res, 404, { code: "not_found", message: "missing" });
  });
  const api = await startApi({ DOCKERMAP_DAEMON_URL: `http://127.0.0.1:${daemon.port}`, DOCKERMAP_API_TOKEN: "test-token" });
  const auth = { Authorization: "Bearer test-token" };
  const routes = [
    "/health",
    "/api/health",
    "/api/status",
    "/api/snapshot",
    "/api/graph",
    "/api/runtime/map",
    "/api/diagnostics",
    "/api/containers",
    "/api/containers/api",
    "/api/images",
    "/api/networks",
    "/api/volumes",
    "/api/logs",
    "/api/compose/scan",
    "/api/compose/graph",
    "/api/compose/edit-plan?file=compose.yaml&service=api&mount=0"
  ];

  for (const path of routes) {
    const response = await request(api, path, { headers: auth });
    assert.equal(response.status, 200, path);
    assertPublishedPayload(await response.json(), sentinel, path);
  }

  const stream = await request(api, "/api/events/stream", { headers: auth });
  assertPublishedPayload(await readFirstChunk(stream), sentinel, "SSE snapshot");
});

test("SSE error payloads and invalid log service names cannot reflect hostile input", async () => {
  const sentinel = "DOCKERMAP_TEST_FAKE_API_SSE_SECRET";
  const hostile = `token=${sentinel}\u202e\u200b\u001b\u2028\ufdd0`;
  const daemon = await startStubDaemon((req, res) => {
    if (req.url === "/daemon/health") {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(hostile);
      return;
    }
    sendJson(res, 404, { code: "not_found", message: "missing" });
  });
  const api = await startApi({
    DOCKERMAP_DAEMON_URL: `http://127.0.0.1:${daemon.port}`,
    DOCKERMAP_API_TOKEN: "test-token",
    DOCKERMAP_EXPOSE_ERROR_DETAILS: "true"
  });
  const auth = { Authorization: "Bearer test-token" };

  const invalidService = await request(api, `/api/logs?service=${encodeURIComponent(hostile)}`, { headers: auth });
  assert.equal(invalidService.status, 400);
  assertPublishedPayload(await invalidService.json(), sentinel, "invalid service response");

  const stream = await request(api, "/api/events/stream", { headers: auth });
  const frame = await readFirstChunk(stream);
  assert.match(frame, /event: error/);
  assertPublishedPayload(frame, sentinel, "SSE error");
});

async function startApi(env: Record<string, string>): Promise<ApiProcess> {
  const port = await freePort();
  const child = spawn(process.execPath, ["node_modules/.bin/tsx", apiEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
      PORT: String(port),
      DOCKERMAP_ALLOWED_ORIGINS: env.DOCKERMAP_ALLOWED_ORIGINS ?? "http://127.0.0.1:3233"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const api = captureProcess(port, child);
  processes.push(api);
  await waitForListening(api);
  return api;
}

async function assertStartupFailure(env: Record<string, string>, expectedMessage: string) {
  const port = await freePort();
  const child = spawn(process.execPath, ["node_modules/.bin/tsx", apiEntry], {
    cwd: repoRoot,
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const logs: string[] = [];
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));

  const result = await waitForExit(child);
  assert.notEqual(result, 0, `expected startup to fail for ${JSON.stringify(env)}`);
  assert.match(logs.join(""), new RegExp(escapeRegExp(expectedMessage)));
}

function captureProcess(port: number, child: ChildProcessWithoutNullStreams): ApiProcess {
  const logs: string[] = [];
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));
  return { port, child, logs };
}

async function request(api: ApiProcess, path: string, init?: RequestInit) {
  return fetch(`http://127.0.0.1:${api.port}${path}`, init);
}

function rawRequest(
  api: ApiProcess,
  path: string,
  options: { method: string; headers: Record<string, string>; body: Buffer }
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: api.port,
      path,
      method: options.method,
      headers: { ...options.headers, "Content-Length": String(options.body.length) }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    request.once("error", reject);
    request.end(options.body);
  });
}

async function waitForListening(api: ApiProcess) {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    if (api.child.exitCode !== null) {
      throw new Error(`API exited before listening: ${api.logs.join("")}`);
    }
    try {
      await request(api, "/api/health");
      return;
    } catch {
      // Retry until the listener is available.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for API to listen: ${api.logs.join("")}`);
}

async function stopApi(api: ApiProcess) {
  if (api.child.exitCode !== null) {
    return;
  }
  api.child.kill("SIGTERM");
  const started = Date.now();
  while (Date.now() - started < 2_000) {
    if (api.child.exitCode !== null) {
      return;
    }
    await delay(50);
  }
  api.child.kill("SIGKILL");
}

async function startStubDaemon(
  handler: (req: IncomingMessage, res: ServerResponse, requests: DaemonRequest[]) => void
): Promise<StubDaemon> {
  const port = await freePort();
  const requests: DaemonRequest[] = [];
  const server = createServer((req, res) => {
    requests.push({
      method: req.method ?? "GET",
      url: req.url ?? "/",
      authorization: req.headers.authorization
    });
    handler(req, res, requests);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  servers.push(server);
  return { port, server, requests };
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function assertPublishedPayload(payload: unknown, sentinel: string, label: string) {
  // SSE framing uses LF separators by design; remove only those separators
  // before checking the JSON payload for hostile C0/C1 display scalars.
  const serialized = (typeof payload === "string" ? payload : JSON.stringify(payload)).replace(/[\r\n]/g, "");
  assert.doesNotMatch(serialized, new RegExp(escapeRegExp(sentinel)), label);
  assert.doesNotMatch(
    serialized,
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufdd0-\ufdef\ufeff]/u,
    label
  );
}

async function readFirstChunk(response: Response) {
  const reader = response.body?.getReader();
  assert.ok(reader, "expected a streaming response body");
  const decoder = new TextDecoder();
  let body = "";

  for (let reads = 0; reads < 8 && !body.includes("\n\n"); reads += 1) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false, "stream ended before the first SSE frame");
    body += decoder.decode(chunk.value ?? new Uint8Array(), { stream: true });
  }

  await reader.cancel();
  return body;
}

function stopServer(server: Server) {
  if (!server.listening) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a TCP port")));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
