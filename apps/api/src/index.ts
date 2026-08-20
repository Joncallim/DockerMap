import { timingSafeEqual } from "node:crypto";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import type {
  ApiError,
  AuthWhoamiResponse,
  ComposeEditPlan,
  ComposeGraph,
  ComposeScan,
  ContainerRecord,
  DiagnosticsEntry,
  DiagnosticsReport,
  DockerSnapshot,
  GraphResponse,
  HealthResponse,
  ImageRecord,
  LogsResponse,
  NetworkRecord,
  RuntimeMap,
  RuntimeServiceStatus,
  StatusResponse,
  VolumeRecord
} from "@dockermap/contracts";
import {
  containers as mockContainers,
  graph as mockGraph,
  images as mockImages,
  networks as mockNetworks,
  snapshot as mockSnapshot,
  volumes as mockVolumes
} from "./mockData.js";

const app = express();
const port = readPort(process.env.PORT, 4000);
const daemonBaseUrl = readDaemonBaseUrl(process.env.DOCKERMAP_DAEMON_URL ?? "http://127.0.0.1:4100");
const apiToken = readApiToken(process.env.DOCKERMAP_API_TOKEN);
const allowMockFallback = process.env.DOCKERMAP_ALLOW_MOCK === "true";
const exposeErrorDetails = process.env.DOCKERMAP_EXPOSE_ERROR_DETAILS === "true";
const pollIntervalMs = readBoundedNumber(process.env.DOCKERMAP_SSE_INTERVAL_MS, 2_000, 1_000, 30_000);
const allowedOrigins = readAllowedOrigins(
  process.env.DOCKERMAP_ALLOWED_ORIGINS ?? "http://127.0.0.1:3233,http://localhost:3233",
);
// Forward-auth: trust identity headers set by an authenticating reverse proxy
// (Authelia, Authentik, oauth2-proxy, Traefik/Caddy forward-auth, etc.) placed in
// front of this API. DockerMap never speaks OIDC itself.
const authUserHeader = readHeaderName(process.env.DOCKERMAP_AUTH_USER_HEADER, "x-remote-user");
const authNameHeader = readHeaderName(process.env.DOCKERMAP_AUTH_NAME_HEADER, "x-remote-name");
const authEmailHeader = readHeaderName(process.env.DOCKERMAP_AUTH_EMAIL_HEADER, "x-remote-email");
const authGroupsHeader = readHeaderName(process.env.DOCKERMAP_AUTH_GROUPS_HEADER, "x-remote-groups");
const authRequired = process.env.DOCKERMAP_AUTH_REQUIRED === "true";
const maxQueryLength = 256;
const maxContainerNameLength = 128;
const maxComposeFiles = 8;
const maxComposeFileLength = 512;
const maxLogPageSize = 500;

function readPort(value: string | undefined, fallback: number) {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid PORT value: ${value}`);
  }
  return port;
}

function readBoundedNumber(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function readDaemonBaseUrl(value: string) {
  const parsed = new URL(value);
  const allowRemoteDaemon = process.env.DOCKERMAP_ALLOW_REMOTE_DAEMON === "true";
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("DOCKERMAP_DAEMON_URL must use http or https");
  }

  if (!allowRemoteDaemon && !loopbackHosts.has(parsed.hostname)) {
    throw new Error("DOCKERMAP_DAEMON_URL must be loopback unless DOCKERMAP_ALLOW_REMOTE_DAEMON=true");
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function readAllowedOrigins(value: string) {
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => {
      if (origin === "*") {
        throw new Error("DOCKERMAP_ALLOWED_ORIGINS must list explicit origins; wildcard is not allowed");
      }

      const parsed = new URL(origin);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error(`DOCKERMAP_ALLOWED_ORIGINS contains unsupported origin: ${origin}`);
      }
      if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
        throw new Error(`DOCKERMAP_ALLOWED_ORIGINS must contain origins only, not paths: ${origin}`);
      }

      return parsed.origin;
    });
}

function readHeaderName(value: string | undefined, fallback: string) {
  const name = (value ?? fallback).trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new Error(`Invalid forward-auth header name: ${value}`);
  }
  return name;
}

function readApiToken(value: string | undefined) {
  if (value === undefined) {
    return null;
  }

  const token = value.trim();
  if (!token) {
    throw new Error("DOCKERMAP_API_TOKEN must not be empty when set");
  }
  return token;
}

function tokenMatches(received: string, expected: string) {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
}

function isPublicRoute(req: express.Request) {
  return req.method === "OPTIONS" || req.path === "/health" || req.path === "/api/health";
}

function requireBearerToken(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!apiToken || isPublicRoute(req)) {
    next();
    return;
  }

  const [scheme, token = ""] = (req.get("authorization") ?? "").split(/\s+/, 2);
  if (scheme !== "Bearer" || !tokenMatches(token, apiToken)) {
    res.status(401).json({
      code: "unauthorized",
      message: "A valid Bearer token is required for this DockerMap API route"
    } satisfies ApiError);
    return;
  }

  next();
}

function requireForwardAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!authRequired || isPublicRoute(req)) {
    next();
    return;
  }

  const user = req.get(authUserHeader);
  if (!user) {
    res.status(401).json({
      code: "auth_required",
      message: `Missing trusted identity header "${authUserHeader}". DockerMap must run behind an authenticating reverse proxy (Authelia, Authentik, oauth2-proxy, etc.) when DOCKERMAP_AUTH_REQUIRED is enabled.`
    } satisfies ApiError);
    return;
  }

  next();
}

app.disable("x-powered-by");
app.use(helmet({ strictTransportSecurity: false }));
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    methods: ["GET", "HEAD"],
    optionsSuccessStatus: 204
  }),
);
app.use(express.json({ limit: "16kb" }));

// Minimal redacted access log: method, pathname (never query strings, which
// can carry tokens), status, and duration. Logged for every request so
// auth failures and daemon errors are visible in the API's stderr.
app.use((req, res, next) => {
  const started = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`${req.method} ${req.path} ${res.statusCode} ${durationMs.toFixed(1)}ms`);
  });
  next();
});

// Versioned alias: /api/v1/* maps to the same read-only /api/* surface so
// consumers can pin a version. Authentication and CORS behave identically.
// The bare /api/v1 (with or without trailing slash) answers with a small
// version descriptor instead of 404ing, matching the OpenAPI alias claim.
const VERSION_DESCRIPTOR = {
  service: "dockermap",
  apiVersion: "v1",
  version: "0.1.0"
} as const;

app.use((req, res, next) => {
  if (req.path === "/api/v1" || req.path === "/api/v1/") {
    res.json(VERSION_DESCRIPTOR);
    return;
  }
  if (req.path.startsWith("/api/v1/")) {
    req.url = req.url.replace(/^\/api\/v1/, "/api");
  }
  next();
});

app.use(requireBearerToken);
app.use(requireForwardAuth);

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(body.message);
  }
}

async function fetchDaemon<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);

  try {
    const response = await fetch(`${daemonBaseUrl}${path}`, {
      ...init,
      signal: controller.signal
    });

    if (!response.ok) {
      const details = exposeErrorDetails ? (await response.text()).slice(0, 2_000) : undefined;
      throw new HttpError(response.status, {
        code: `daemon_${response.status}`,
        message: `Daemon request failed for ${path}`,
        ...(details ? { details } : {})
      });
    }

    return (await response.json()) as T;
  } catch (error) {
    if (allowMockFallback) {
      return getMockResponse<T>(path);
    }

    if (error instanceof HttpError) {
      throw error;
    }

    throw new HttpError(502, {
      code: "daemon_unavailable",
      message: `Unable to reach DockerMap daemon at ${daemonBaseUrl}`,
      ...(exposeErrorDetails ? { details: error instanceof Error ? error.message : String(error) } : {})
    });
  } finally {
    clearTimeout(timeout);
  }
}

function getMockResponse<T>(path: string): T {
  const health: HealthResponse = {
    status: "degraded",
    mode: "mock",
    dockerReachable: false,
    lastUpdated: mockSnapshot.lastUpdated ?? Date.now(),
    snapshotVersion: String(mockSnapshot.lastUpdated ?? Date.now()),
    message: "Node mock fallback active"
  };

  if (path === "/daemon/health") {
    return health as T;
  }

  if (path === "/daemon/snapshot") {
    return mockSnapshot as T;
  }

  if (path === "/daemon/graph") {
    return mockGraph as T;
  }

  if (path === "/daemon/runtime/map") {
    const nodes = [
      ...mockContainers.map((container) => ({
        id: `docker_container_${container.id}`,
        provider: "docker" as const,
        type: "container" as const,
        label: container.name,
        status: container.status,
        layer: "container" as const,
        service: {
          name: container.name,
          status: container.status as RuntimeServiceStatus,
          dependencies: [],
          dependents: [],
          health: null,
          logs: [],
          events: [],
          owner: null,
          location: null
        },
        metadata: {
          image: container.image,
          role: container.role,
          ports: container.ports.join(",")
        }
      })),
      ...mockNetworks.map((network) => ({
        id: `docker_network_${network.id}`,
        provider: "docker" as const,
        type: "docker_network" as const,
        label: network.name,
        status: null,
        layer: "network" as const,
        metadata: {
          driver: network.driver,
          internal: String(network.internal)
        }
      })),
      ...mockVolumes.map((volume) => ({
        id: `docker_volume_${volume.id}`,
        provider: "docker" as const,
        type: "docker_volume" as const,
        label: volume.name,
        status: null,
        layer: "storage" as const,
        metadata: {}
      }))
    ];

    const runtimeMap: RuntimeMap = {
      nodes,
      edges: [],
      diagnostics: [
        {
          provider: "other",
          severity: "warning",
          message: "Runtime map is using Node mock fallback"
        }
      ],
      lastUpdated: mockSnapshot.lastUpdated ?? Date.now()
    };
    return runtimeMap as T;
  }

  if (path === "/daemon/containers") {
    return { containers: mockContainers } as T;
  }

  if (path.startsWith("/daemon/containers/")) {
    const name = decodeURIComponent(path.split("/").at(-1) ?? "");
    const container = mockContainers.find((item) => item.name === name);
    if (!container) {
      throw new HttpError(404, {
        code: "container_not_found",
        message: `Container ${name} not found`
      });
    }
    return container as T;
  }

  if (path === "/daemon/images") {
    return { images: mockImages } as T;
  }

  if (path === "/daemon/networks") {
    return { networks: mockNetworks } as T;
  }

  if (path === "/daemon/volumes") {
    return { volumes: mockVolumes } as T;
  }

  if (path.startsWith("/daemon/logs")) {
    const logQuery = new URLSearchParams(path.includes("?") ? path.split("?")[1] : "");
    const service = logQuery.get("service");
    const q = logQuery.get("q");
    const cursor = logQuery.get("cursor");
    const limit = Number(logQuery.get("limit") ?? "100");
    const cursorMillis = cursor ? Number(cursor.split(":")[0]) : null;
    const cursorOffset = cursor ? Number(cursor.split(":")[1] ?? "0") : 0;
    const filter = q?.toLowerCase() ?? null;
    const entries = mockContainers.flatMap((container, index) => [
      {
        id: `${container.id}-log-${index}`,
        timestamp: Date.now() - index * 30_000,
        container: container.name,
        level: "info",
        message: `${container.name} running on ${container.image}`
      }
    ]);
    // Sort newest-first so the compound "millis:offset" cursor logic below
    // agrees with the daemon's page_log_entries (same-ms runs are contiguous).
    const sorted = [...entries].sort((left, right) => right.timestamp - left.timestamp);
    const filtered = sorted.filter((entry) => {
      if (service !== null && entry.container !== service) {
        return false;
      }
      if (filter !== null && !entry.message.toLowerCase().includes(filter)) {
        return false;
      }
      if (cursorMillis === null) {
        return true;
      }
      if (entry.timestamp < cursorMillis) {
        return true;
      }
      if (entry.timestamp > cursorMillis) {
        return false;
      }
      const sameTimestampIndex = sorted.filter((other) => other.timestamp === cursorMillis).indexOf(entry);
      return sameTimestampIndex >= cursorOffset;
    });
    const nextCursor =
      filtered.length > limit
        ? (() => {
            const boundary = filtered[limit - 1];
            const firstAtBoundary = filtered
              .slice(0, limit)
              .findIndex((entry) => entry.timestamp === boundary.timestamp);
            const previouslyEmitted = cursorMillis === boundary.timestamp ? cursorOffset : 0;
            return `${boundary.timestamp}:${previouslyEmitted + limit - firstAtBoundary}`;
          })()
        : null;
    return {
      service,
      entries: filtered.slice(0, limit),
      nextCursor
    } as T;
  }

  if (path.startsWith("/daemon/compose/scan")) {
    return {
      files: [],
      projectRoot: process.cwd(),
      services: [],
      mounts: [],
      correlations: [],
      diagnostics: [
        {
          id: "compose_mock_unavailable",
          severity: "warning",
          message: "Compose scanning is unavailable while Node mock fallback is active",
          origin: {
            file: process.cwd(),
            service: null,
            field: "files"
          }
        }
      ]
    } as T;
  }

  if (path.startsWith("/daemon/compose/graph")) {
    return {
      nodes: [],
      edges: []
    } as T;
  }

  if (path.startsWith("/daemon/compose/edit-plan")) {
    throw new HttpError(503, {
      code: "compose_edit_plan_unavailable",
      message: "Compose edit planning requires the Rust daemon"
    });
  }

  throw new HttpError(500, {
    code: "unknown_mock_path",
    message: `No mock response for ${path}`
  });
}

function sendError(res: express.Response, error: unknown) {
  if (error instanceof HttpError) {
    res.status(error.status).json(error.body);
    return;
  }

  console.error(error);
  res.status(500).json({
    code: "internal_error",
    message: "Unexpected API failure"
  } satisfies ApiError);
}

function buildLogsPath(query: express.Request["query"]) {
  const params = new URLSearchParams();
  // The daemon caps a log `service` (a container name) at
  // MAX_LOG_SERVICE_CHARS = 128; mirror that so the API rejects the value
  // with a 400 instead of forwarding it and surfacing the daemon's 400.
  const service = readOptionalQueryString(query.service, "service", maxContainerNameLength);
  const q = readOptionalQueryString(query.q, "q", maxQueryLength);
  const cursor = readOptionalQueryString(query.cursor, "cursor", 32);
  const limit = readOptionalQueryInt(query.limit, "limit", 1, maxLogPageSize);

  if (service) {
    params.set("service", service);
  }

  if (q) {
    params.set("q", q);
  }

  if (cursor) {
    // Compound cursor "millis:offset" (plain "millis" also accepted) —
    // mirrors the daemon's parse_log_cursor so same-millisecond entries can
    // be resumed mid-run instead of silently dropped at page boundaries.
    if (!/^\d+(:\d+)?$/.test(cursor)) {
      throw new HttpError(400, {
        code: "invalid_query",
        message: "Query parameter cursor must be `millis` or `millis:offset`"
      });
    }
    params.set("cursor", cursor);
  }

  if (limit !== undefined) {
    params.set("limit", String(limit));
  }

  const suffix = params.toString();
  return suffix ? `/daemon/logs?${suffix}` : "/daemon/logs";
}

function buildComposeScanPath(query: express.Request["query"]) {
  const params = new URLSearchParams();
  const files = Array.isArray(query.file) ? query.file : query.file ? [query.file] : [];
  const normalizedFiles: string[] = [];

  if (files.length > maxComposeFiles) {
    throw new HttpError(400, {
      code: "too_many_compose_files",
      message: `Compose scan accepts at most ${maxComposeFiles} files`
    });
  }

  for (const file of files) {
    if (typeof file !== "string" || !file.trim()) {
      throw new HttpError(400, {
        code: "invalid_compose_file",
        message: "Compose scan file query values must be non-empty strings"
      });
    }
    const normalized = file.trim();
    if (normalized.length > maxComposeFileLength || normalized.includes("\0")) {
      throw new HttpError(400, {
        code: "invalid_compose_file",
        message: `Compose scan file query values must be ${maxComposeFileLength} characters or fewer`
      });
    }
    normalizedFiles.push(normalized);
  }

  if (normalizedFiles.length > 0) {
    params.set("file", normalizedFiles.join(","));
  }

  const suffix = params.toString();
  return suffix ? `/daemon/compose/scan?${suffix}` : "/daemon/compose/scan";
}

function buildComposeEditPlanPath(query: express.Request["query"]) {
  const params = new URLSearchParams();
  const file = readRequiredQueryString(query.file, "file", maxComposeFileLength);
  const service = readRequiredQueryString(query.service, "service", maxQueryLength);
  const mount = readRequiredQueryString(query.mount, "mount", 16);
  const source = readOptionalQueryString(query.source, "source", maxComposeFileLength);
  const target = readOptionalQueryString(query.target, "target", maxComposeFileLength);

  if (!/^\d+$/.test(mount)) {
    throw new HttpError(400, {
      code: "invalid_query",
      message: "Query parameter mount must be a zero-based integer"
    });
  }

  params.set("file", file);
  params.set("service", service);
  params.set("mount", mount);

  if (source) {
    params.set("source", source);
  }

  if (target) {
    params.set("target", target);
  }

  return `/daemon/compose/edit-plan?${params.toString()}`;
}

function readOptionalQueryString(value: unknown, name: string, maxLength: number) {
  if (value === undefined) {
    return "";
  }

  if (typeof value !== "string") {
    throw new HttpError(400, {
      code: "invalid_query",
      message: `Query parameter ${name} must be a string`
    });
  }

  const trimmed = value.trim();
  if (trimmed.length > maxLength || trimmed.includes("\0")) {
    throw new HttpError(400, {
      code: "invalid_query",
      message: `Query parameter ${name} must be ${maxLength} characters or fewer`
    });
  }

  return trimmed;
}

function readRequiredQueryString(value: unknown, name: string, maxLength: number) {
  const parsed = readOptionalQueryString(value, name, maxLength);
  if (!parsed) {
    throw new HttpError(400, {
      code: "invalid_query",
      message: `Query parameter ${name} is required`
    });
  }
  return parsed;
}

function readOptionalQueryInt(value: unknown, name: string, min: number, max: number) {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new HttpError(400, {
      code: "invalid_query",
      message: `Query parameter ${name} must be an integer`
    });
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, {
      code: "invalid_query",
      message: `Query parameter ${name} must be between ${min} and ${max}`
    });
  }

  return parsed;
}

app.get("/health", async (_req, res) => {
  try {
    const health = await fetchDaemon<HealthResponse>("/daemon/health");
    res.json({ status: "ok", daemon: health });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/health", async (_req, res) => {
  try {
    const health = await fetchDaemon<HealthResponse>("/daemon/health");
    res.json({
      node: { status: "ok", port },
      daemon: health,
      dockerReachable: health.dockerReachable
    });
  } catch (error) {
    sendError(res, error);
  }
});

/**
 * Classify a Docker container status text for /api/status. Docker's
 * ContainerSummary.status is free-form ("Up 3 hours", "Exited (0) ..."),
 * so normalize on the first whitespace/paren-delimited token, mirroring
 * the web model's stateForStatus.
 */
function containerStatusKind(status: string): "running" | "offline" | "attention" {
  const key = status.toLowerCase().split(/[\s(]/)[0];
  if (key === "up" || key === "running") return "running";
  if (key === "exited" || key === "dead") return "offline";
  return "attention";
}

app.get("/api/status", async (_req, res) => {
  try {
    const [health, snapshot] = await Promise.all([
      fetchDaemon<HealthResponse>("/daemon/health"),
      fetchDaemon<DockerSnapshot>("/daemon/snapshot")
    ]);

    const containers = snapshot.containers.length;
    const containersRunning = snapshot.containers.filter(
      (container) => containerStatusKind(container.status) === "running"
    ).length;
    const offline = snapshot.containers.filter(
      (container) => containerStatusKind(container.status) === "offline"
    ).length;
    const attention = snapshot.containers.filter(
      (container) => containerStatusKind(container.status) === "attention"
    ).length;
    const healthy = containers - offline - attention;

    res.json({
      service: "dockermap",
      status: !health.dockerReachable
        ? health.mode === "mock"
          ? "degraded"
          : "offline"
        : attention + offline > 0
          ? "degraded"
          : "ok",
      mode: health.mode,
      dockerReachable: health.dockerReachable,
      containers,
      containersRunning,
      networks: snapshot.networks.length,
      volumes: snapshot.volumes.length,
      images: snapshot.images.length,
      healthy,
      attention,
      offline,
      version: "0.1.0"
    } satisfies StatusResponse);
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/openapi.json", (_req, res) => {
  res.json({
    openapi: "3.0.3",
    info: {
      title: "DockerMap Read-Only API",
      version: "0.1.0",
      description:
        "Read-only inventory, topology, runtime, compose, logs, and diagnostics endpoints. All /api/v1/* routes alias these paths. Protected routes require a Bearer token (or reverse-proxy forward-auth)."
    },
    paths: {
      "/health": {
        get: { summary: "Liveness probe (unauthenticated)", tags: ["system"] }
      },
      "/api/v1": {
        get: { summary: "Version descriptor for the /api/v1 alias", tags: ["system"] }
      },
      "/api/health": {
        get: { summary: "API and daemon health", tags: ["system"] }
      },
      "/api/status": {
        get: {
          summary: "Compact dashboard status for external widgets (Homepage-style)",
          tags: ["system"]
        }
      },
      "/api/auth/whoami": {
        get: { summary: "Current authenticated identity", tags: ["system"] }
      },
      "/api/snapshot": {
        get: { summary: "Full Docker inventory snapshot", tags: ["docker"] }
      },
      "/api/containers": {
        get: { summary: "List containers", tags: ["docker"] }
      },
      "/api/containers/{name}": {
        get: { summary: "Container detail", tags: ["docker"] }
      },
      "/api/images": {
        get: { summary: "List images", tags: ["docker"] }
      },
      "/api/networks": {
        get: { summary: "List networks", tags: ["docker"] }
      },
      "/api/volumes": {
        get: { summary: "List volumes", tags: ["docker"] }
      },
      "/api/graph": {
        get: { summary: "Topology graph", tags: ["topology"] }
      },
      "/api/runtime/map": {
        get: { summary: "Runtime map across all providers", tags: ["runtime"] }
      },
      "/api/logs": {
        get: {
          summary: "Container logs with cursor pagination",
          parameters: [
            { name: "service", in: "query", schema: { type: "string" } },
            { name: "q", in: "query", schema: { type: "string" } },
            { name: "cursor", in: "query", schema: { type: "string" } },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 500 }
            }
          ],
          tags: ["logs"]
        }
      },
      "/api/compose/scan": {
        get: { summary: "Scan Compose files and correlate mounts", tags: ["compose"] }
      },
      "/api/compose/graph": {
        get: { summary: "Derive Compose dependency graph", tags: ["compose"] }
      },
      "/api/compose/edit-plan": {
        get: {
          summary: "Dry-run edit plan (never writes)",
          tags: ["compose"]
        }
      },
      "/api/diagnostics": {
        get: { summary: "Aggregated compose + runtime diagnostics", tags: ["system"] }
      },
      "/api/events/stream": {
        get: { summary: "Server-sent event stream of health snapshots", tags: ["system"] }
      }
    }
  });
});

app.get("/api/auth/whoami", (req, res) => {
  const user = req.get(authUserHeader) ?? null;
  const name = req.get(authNameHeader) ?? null;
  const email = req.get(authEmailHeader) ?? null;
  const groups = (req.get(authGroupsHeader) ?? "")
    .split(",")
    .map((group) => group.trim())
    .filter(Boolean);

  res.json({
    authenticated: Boolean(user),
    required: authRequired,
    user,
    name,
    email,
    groups
  } satisfies AuthWhoamiResponse);
});

app.get("/api/snapshot", async (_req, res) => {
  try {
    res.json(await fetchDaemon<DockerSnapshot>("/daemon/snapshot"));
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/graph", async (_req, res) => {
  try {
    res.json(await fetchDaemon<GraphResponse>("/daemon/graph"));
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/runtime/map", async (_req, res) => {
  try {
    res.json(await fetchDaemon<RuntimeMap>("/daemon/runtime/map"));
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/diagnostics", async (_req, res) => {
  try {
    const entries: DiagnosticsEntry[] = [];
    const [scanResult, runtimeResult] = await Promise.allSettled([
      fetchDaemon<ComposeScan>("/daemon/compose/scan"),
      fetchDaemon<RuntimeMap>("/daemon/runtime/map")
    ]);

    if (scanResult.status === "fulfilled") {
      for (const diagnostic of scanResult.value.diagnostics) {
        entries.push({
          id: diagnostic.id,
          source: "compose",
          severity: diagnostic.severity,
          message: diagnostic.message,
          file: diagnostic.origin.file,
          service: diagnostic.origin.service
        });
      }
    } else {
      entries.push({
        id: null,
        source: "api",
        severity: "warning",
        message: `Compose diagnostics unavailable: ${scanResult.reason instanceof Error ? scanResult.reason.message : "request failed"}`,
        file: null,
        service: null
      });
    }

    if (runtimeResult.status === "fulfilled") {
      for (const diagnostic of runtimeResult.value.diagnostics) {
        entries.push({
          id: diagnostic.provider,
          source: "runtime",
          severity: diagnostic.severity,
          message: diagnostic.message,
          file: null,
          service: null
        });
      }
    } else {
      entries.push({
        id: null,
        source: "api",
        severity: "warning",
        message: `Runtime diagnostics unavailable: ${runtimeResult.reason instanceof Error ? runtimeResult.reason.message : "request failed"}`,
        file: null,
        service: null
      });
    }

    res.json({ generatedAt: Date.now(), entries } satisfies DiagnosticsReport);
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/containers", async (_req, res) => {
  try {
    res.json(await fetchDaemon<{ containers: ContainerRecord[] }>("/daemon/containers"));
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/containers/:name", async (req, res) => {
  try {
    const name = readRequiredQueryString(req.params.name, "name", maxContainerNameLength);
    res.json(
      await fetchDaemon<ContainerRecord>(`/daemon/containers/${encodeURIComponent(name)}`),
    );
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/images", async (_req, res) => {
  try {
    res.json(await fetchDaemon<{ images: ImageRecord[] }>("/daemon/images"));
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/networks", async (_req, res) => {
  try {
    res.json(await fetchDaemon<{ networks: NetworkRecord[] }>("/daemon/networks"));
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/volumes", async (_req, res) => {
  try {
    res.json(await fetchDaemon<{ volumes: VolumeRecord[] }>("/daemon/volumes"));
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/logs", async (req, res) => {
  try {
    res.json(await fetchDaemon<LogsResponse>(buildLogsPath(req.query)));
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/compose/scan", async (req, res) => {
  try {
    res.json(await fetchDaemon<ComposeScan>(buildComposeScanPath(req.query)));
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/compose/graph", async (req, res) => {
  try {
    res.json(await fetchDaemon<ComposeGraph>(buildComposeScanPath(req.query).replace("/scan", "/graph")));
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/compose/edit-plan", async (req, res) => {
  try {
    res.json(await fetchDaemon<ComposeEditPlan>(buildComposeEditPlanPath(req.query)));
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/events/stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Serialize emits: fetchDaemon can take up to 4s, so without a busy guard
  // a slow daemon stacks overlapping emits. And a client that disconnects
  // mid-emit must never be written to — write-after-end throws, and the
  // catch block writing AGAIN becomes an unhandled rejection (a crash on
  // Node >= 15), so every write path checks writableEnded/destroyed first.
  let busy = false;

  const emit = async () => {
    if (busy || res.writableEnded || res.destroyed) {
      return;
    }
    busy = true;
    try {
      const health = await fetchDaemon<HealthResponse>("/daemon/health");
      if (res.writableEnded || res.destroyed) {
        return;
      }
      res.write(`event: snapshot\n`);
      res.write(`data: ${JSON.stringify(health)}\n\n`);
    } catch (error) {
      if (res.writableEnded || res.destroyed) {
        return;
      }
      const payload =
        error instanceof HttpError
          ? error.body
          : {
              code: "stream_error",
              message: "Live stream failed"
            };
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(emit, pollIntervalMs);
  // Comment-frame keepalive so proxies do not idle out the stream between
  // snapshot emits (SSE comments are ignored by EventSource clients).
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(": ping\n\n");
    }
  }, 15_000);

  void emit();

  req.on("close", () => {
    clearInterval(timer);
    clearInterval(heartbeat);
    res.end();
  });
});

app.use((_req, res) => {
  res.status(404).json({
    code: "not_found",
    message: "Route not found"
  } satisfies ApiError);
});

app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    sendError(res, error);
  },
);

const server = app.listen(port, "127.0.0.1", () => {
  console.log(`@dockermap/api listening on http://127.0.0.1:${port}`);
});

server.requestTimeout = 10_000;
server.headersTimeout = 11_000;
server.keepAliveTimeout = 5_000;

// Unhandled async rejections must be visible in the API's stderr instead of
// vanishing; uncaught exceptions crash loudly (exit 1) so a supervisor
// restarts the process rather than serving a half-broken API.
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});
process.on("uncaughtException", (error) => {
  console.error("uncaughtException:", error);
  process.exit(1);
});
