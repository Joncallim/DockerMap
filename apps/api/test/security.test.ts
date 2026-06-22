import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
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

test("health routes stay public while protected routes require a bearer token", async () => {
  const closedPort = await freePort();
  const api = await startApi({
    DOCKERMAP_ALLOW_MOCK: "true",
    DOCKERMAP_DAEMON_URL: `http://127.0.0.1:${closedPort}`,
    DOCKERMAP_API_TOKEN: "test-token"
  });

  const health = await request(api, "/api/health");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).daemon.mode, "mock");

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

test("daemon failures hide details by default and expose details only when explicitly enabled", async () => {
  const closedPort = await freePort();
  const hidden = await startApi({
    DOCKERMAP_DAEMON_URL: `http://127.0.0.1:${closedPort}`
  });
  const hiddenResponse = await request(hidden, "/api/snapshot");
  assert.equal(hiddenResponse.status, 502);
  assert.equal(Object.hasOwn(await hiddenResponse.json(), "details"), false);

  await stopApi(hidden);
  processes.splice(processes.indexOf(hidden), 1);

  const exposed = await startApi({
    DOCKERMAP_DAEMON_URL: `http://127.0.0.1:${closedPort}`,
    DOCKERMAP_EXPOSE_ERROR_DETAILS: "true"
  });
  const exposedResponse = await request(exposed, "/api/snapshot");
  assert.equal(exposedResponse.status, 502);
  assert.equal(typeof (await exposedResponse.json()).details, "string");
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
  assert.equal(typeof (await exposedResponse.json()).details, "string");
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
  assert.equal((await exposedJson.json()).details, "tmux pane SECRET=alpha-secret");
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
        entry.url === "/daemon/compose/scan?file=docker-compose.yml%2Cstack%2Fsystemd-proxy.yml"
    )
  );
  assert.ok(
    daemon.requests.some((entry) => entry.method === "GET" && entry.url === "/daemon/containers/api%2Fworker")
  );
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
      url: req.url ?? "/"
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

async function readFirstChunk(response: Response) {
  const reader = response.body?.getReader();
  assert.ok(reader, "expected a streaming response body");
  const chunk = await reader.read();
  await reader.cancel();
  return new TextDecoder().decode(chunk.value ?? new Uint8Array());
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
