import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import net from "node:net";
import { afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

type ApiProcess = {
  port: number;
  child: ChildProcessWithoutNullStreams;
  logs: string[];
};

const apiEntry = "apps/api/src/index.ts";
const repoRoot = new URL("../../..", import.meta.url);
const processes: ApiProcess[] = [];

afterEach(async () => {
  await Promise.all(processes.splice(0).map(stopApi));
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

test("unsafe startup configuration fails before listening", async () => {
  await assertStartupFailure({ DOCKERMAP_DAEMON_URL: "ftp://127.0.0.1:4100" }, "must use http or https");
  await assertStartupFailure({ DOCKERMAP_DAEMON_URL: "http://192.0.2.10:4100" }, "must be loopback");
  await assertStartupFailure({ DOCKERMAP_ALLOWED_ORIGINS: "*" }, "wildcard is not allowed");
  await assertStartupFailure({ DOCKERMAP_API_TOKEN: "   " }, "must not be empty");
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
