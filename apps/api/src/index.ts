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
  DockerSnapshot,
  GraphResponse,
  HealthResponse,
  ImageRecord,
  LogsResponse,
  NetworkRecord,
  RuntimeMap,
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
    return {
      service: null,
      entries: mockContainers.flatMap((container, index) => [
        {
          id: `${container.id}-log-${index}`,
          timestamp: Date.now() - index * 30_000,
          container: container.name,
          level: "info",
          message: `${container.name} running on ${container.image}`
        }
      ]),
      nextCursor: null
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
  const service = readOptionalQueryString(query.service, "service", maxQueryLength);
  const q = readOptionalQueryString(query.q, "q", maxQueryLength);

  if (service) {
    params.set("service", service);
  }

  if (q) {
    params.set("q", q);
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

  const emit = async () => {
    try {
      const health = await fetchDaemon<HealthResponse>("/daemon/health");
      res.write(`event: snapshot\n`);
      res.write(`data: ${JSON.stringify(health)}\n\n`);
    } catch (error) {
      const payload =
        error instanceof HttpError
          ? error.body
          : {
              code: "stream_error",
              message: "Live stream failed"
            };
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  };

  const timer = setInterval(emit, pollIntervalMs);
  void emit();

  req.on("close", () => {
    clearInterval(timer);
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
