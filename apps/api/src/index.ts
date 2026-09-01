import { randomBytes, timingSafeEqual } from "node:crypto";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import type {
  ApiError,
  AuthWhoamiResponse,
  ContainerRecord,
  DockerSnapshot,
  GraphResponse,
  HealthResponse,
  ImageRecord,
  LogEntry,
  LogsResponse,
  NetworkRecord,
  RuntimeMap,
  RuntimeServiceStatus,
  StatusResponse,
  VolumeRecord
} from "@dockermap/contracts";
import { publishApiPayload, publishLogsResponse } from "./publication.js";
import { createDaemonClient, HttpError } from "./daemonClient.js";
import { createReadHandlers } from "./readHandlers.js";
import {
  readAllowedOrigins,
  readApiToken,
  readBoundedNumber,
  readCookieName,
  readDaemonBaseUrl,
  readDaemonToken,
  readHeaderName,
  readPort,
} from "./config.js";
import {
  containers as mockContainers,
  graph as mockGraph,
  images as mockImages,
  networks as mockNetworks,
  snapshot as mockSnapshot,
  volumes as mockVolumes
} from "./mockData.js";
import { canonicalRoutePath, routeById, routeForRequest, type RegisteredRoute, type RouteId } from "./routes.js";
import { SSE_CONTENT_TYPE, SSE_EVENT, formatSseEvent, formatSseHeartbeat } from "./sseProtocol.js";

export const app = express();
const expectedMiddleware = new WeakSet<Function>();

function trackedMiddleware<T extends express.RequestHandler | express.ErrorRequestHandler>(middleware: T): T {
  expectedMiddleware.add(middleware);
  return middleware;
}

const port = readPort(process.env.PORT, 4000);
const daemonBaseUrl = readDaemonBaseUrl(process.env.DOCKERMAP_DAEMON_URL ?? "http://127.0.0.1:4100");
const apiToken = readApiToken(process.env.DOCKERMAP_API_TOKEN);
const daemonToken = readDaemonToken(process.env.DOCKERMAP_DAEMON_TOKEN, apiToken);
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
const authCookieName = readCookieName(process.env.DOCKERMAP_AUTH_COOKIE, "dockermap_session");
const authMode: "none" | "bearer" | "forward-auth" = authRequired
  ? "forward-auth"
  : apiToken
    ? "bearer"
    : "none";
const maxQueryLength = 256;
const maxContainerNameLength = 128;
const maxComposeFiles = 8;
const maxComposeFileLength = 512;
const maxLogPageSize = 500;
const sessionTtlMs = 24 * 60 * 60 * 1_000;
const maxSessions = 1_024;
const sessions = new Map<string, number>();
const activeSessionStreams = new Map<string, Set<express.Response>>();
const maxStreamsPerSession = readBoundedNumber(process.env.DOCKERMAP_MAX_SSE_STREAMS_PER_SESSION, 8, 1, 64);
const maxStreams = readBoundedNumber(process.env.DOCKERMAP_MAX_SSE_STREAMS, 128, 1, 1_024);
let activeStreamCount = 0;
const sessionAttemptWindowMs = 60_000;
const maxSessionAttemptsPerWindow = 20;
const maxSessionAttemptSources = 1_024;
const sessionAttemptsBySource = new Map<string, number[]>();
// Base timestamp for the mock log timeline, fixed once per process so a
// compound "millis:offset" cursor taken from one request still matches
// entries on the next. A fresh Date.now() per request shifts the whole
// timeline by the request-to-request delta, so the boundary entry lands
// between two timestamps and is skipped by the cursor filter.
const MOCK_LOG_BASE_MILLIS = Date.now();

function tokenMatches(received: string, expected: string) {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
}

function readCookie(req: express.Request, name: string) {
  const prefix = `${name}=`;
  for (const cookie of (req.get("cookie") ?? "").split(";")) {
    const value = cookie.trim();
    if (value.startsWith(prefix)) {
      return value.slice(prefix.length);
    }
  }
  return "";
}

function issueSession() {
  const now = Date.now();
  for (const [session, expiresAt] of sessions) {
    if (expiresAt <= now) revokeSession(session);
  }
  while (sessions.size >= maxSessions) {
    const oldest = sessions.keys().next().value;
    if (!oldest) break;
    revokeSession(oldest);
  }
  const session = randomBytes(32).toString("base64url");
  sessions.set(session, now + sessionTtlMs);
  return session;
}

function validSession(session: string) {
  const expiresAt = sessions.get(session);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    revokeSession(session);
    return false;
  }
  return true;
}

function closeSessionStreams(session: string) {
  for (const response of activeSessionStreams.get(session) ?? []) {
    if (!response.writableEnded && !response.destroyed) response.end();
  }
}

function revokeSession(session: string) {
  sessions.delete(session);
  closeSessionStreams(session);
}

function registerSessionStream(session: string, response: express.Response) {
  if (activeStreamCount >= maxStreams) return "process" as const;
  const streams = activeSessionStreams.get(session) ?? new Set<express.Response>();
  if (session && streams.size >= maxStreamsPerSession) return "session" as const;
  streams.add(response);
  activeSessionStreams.set(session, streams);
  activeStreamCount += 1;
  return "accepted" as const;
}

function unregisterSessionStream(session: string, response: express.Response) {
  const streams = activeSessionStreams.get(session);
  if (!streams) return;
  if (streams.delete(response)) activeStreamCount = Math.max(0, activeStreamCount - 1);
  if (streams.size === 0) activeSessionStreams.delete(session);
}

function limitSessionAttempts(req: express.Request, res: express.Response, next: express.NextFunction) {
  const route = routeForRequest(req.method, req.path);
  if (authMode !== "bearer" || route?.rateLimit !== "session-attempts") {
    next();
    return;
  }

  const now = Date.now();
  const source = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const attempts = (sessionAttemptsBySource.get(source) ?? []).filter((attempt) => attempt > now - sessionAttemptWindowMs);
  if (attempts.length >= maxSessionAttemptsPerWindow) {
    const retryAfterSeconds = Math.max(1, Math.ceil(((attempts[0] ?? now) + sessionAttemptWindowMs - now) / 1_000));
    res.setHeader("Retry-After", String(retryAfterSeconds));
    res.status(429).json({ code: "rate_limited", message: "Too many session attempts; try again later" } satisfies ApiError);
    return;
  }

  attempts.push(now);
  if (!sessionAttemptsBySource.has(source) && sessionAttemptsBySource.size >= maxSessionAttemptSources) {
    const oldestSource = sessionAttemptsBySource.keys().next().value;
    if (oldestSource) sessionAttemptsBySource.delete(oldestSource);
  }
  sessionAttemptsBySource.set(source, attempts);
  next();
}

function sessionCookieAttributes(req: express.Request, maxAge: number) {
  // Only mark the cookie Secure when the external request was HTTPS. This
  // preserves local loopback HTTP development while protecting forwarded HTTPS.
  const secure = req.get("x-forwarded-proto")?.trim().toLowerCase() === "https";
  return `Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

function isPublicRoute(req: express.Request) {
  return authMode === "bearer" && routeForRequest(req.method, req.path)?.auth === "public-in-bearer";
}

function requireAuthentication(req: express.Request, res: express.Response, next: express.NextFunction) {
  // CORS preflight is global middleware behavior, not an API route policy.
  if (req.method === "OPTIONS" || isPublicRoute(req) || authMode === "none") {
    next();
    return;
  }

  if (authMode === "bearer") {
    const [scheme, headerToken = ""] = (req.get("authorization") ?? "").split(/\s+/, 2);
    const cookieToken = readCookie(req, authCookieName);
    if (scheme === "Bearer" && apiToken && tokenMatches(headerToken, apiToken)) {
      next();
      return;
    }
    if (!scheme && validSession(cookieToken)) {
      next();
      return;
    }
    res.status(401).json({
      code: "unauthorized",
      message: "A valid Bearer token is required for this DockerMap API route"
    } satisfies ApiError);
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
// Only the loopback nginx hop that ships in the image may supply forwarding
// metadata. The image nginx overwrites X-Forwarded-For from its peer address.
app.set("trust proxy", "loopback");
app.use(trackedMiddleware(helmet({ strictTransportSecurity: false })));
app.use(
  trackedMiddleware(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    methods: ["GET", "HEAD", "POST"],
    credentials: true,
    optionsSuccessStatus: 204
  })),
);
// Record only method, path, and response metadata before authentication or
// parsing. Deliberately never log headers, cookies, query strings, or bodies.
app.use(trackedMiddleware((req, res, next) => {
  const started = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`${req.method} ${canonicalRoutePath(req.path) ?? "/unknown"} ${res.statusCode} ${durationMs.toFixed(1)}ms`);
  });
  next();
}));
app.use(trackedMiddleware(limitSessionAttempts));
// Auth precedes body parsing so unauthenticated callers cannot observe or
// consume parser work; OPTIONS remains exempt inside requireAuthentication.
app.use(trackedMiddleware(requireAuthentication));
app.use(trackedMiddleware(express.json({ limit: "16kb" })));

function registerRoute(id: RouteId, handler: express.RequestHandler) {
  const route = routeById(id);
  for (const routePath of route.paths) {
    if (route.method === "GET") {
      app.get(routePath.path, handler);
    } else {
      app.post(routePath.path, handler);
    }
  }
}

registerRoute("auth-session", (req, res) => {
  if (authMode !== "bearer" || !apiToken || typeof req.body?.token !== "string" || !tokenMatches(req.body.token, apiToken)) {
    res.status(401).json({ code: "unauthorized", message: "A valid API token is required" } satisfies ApiError);
    return;
  }
  const session = issueSession();
  res.setHeader(
    "Set-Cookie",
    `${authCookieName}=${session}; ${sessionCookieAttributes(req, Math.floor(sessionTtlMs / 1_000))}`,
  );
  res.status(204).end();
});

registerRoute("auth-session-logout", (req, res) => {
  const session = readCookie(req, authCookieName);
  revokeSession(session);
  res.setHeader("Set-Cookie", `${authCookieName}=; ${sessionCookieAttributes(req, 0)}`);
  res.status(204).end();
});

function getMockResponse<T>(path: string): T {
  const health: HealthResponse = {
    status: "degraded",
    mode: "mock",
    dockerReachable: false,
    lastUpdated: mockSnapshot.lastUpdated ?? Date.now(),
    modelRevision: mockSnapshot.modelRevision ?? "node-mock-v1",
    snapshotVersion: String(mockSnapshot.lastUpdated ?? Date.now()),
    message: "Node mock fallback active"
  };

  if (path === "/daemon/health") {
    return health as T;
  }

  if (path === "/daemon/snapshot") {
    // Actual source stamp: the Node API's route-local fallback fabricated
    // these bytes, so they must attest "mock" — never "docker" (#85 A3).
    return { ...mockSnapshot, source: "mock" } as T;
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
      })),
      {
        id: "python_process_4242",
        provider: "python" as const,
        type: "python_application" as const,
        label: "worker.py",
        status: "running",
        layer: "process" as const,
        metadata: {
          pid: "4242",
          user: "jon",
          entry: "worker.py"
        } as Record<string, string>,
      },
      {
        id: "native_process_8080",
        provider: "process" as const,
        type: "process" as const,
        label: "nginx",
        status: "running",
        layer: "process" as const,
        metadata: {
          pid: "8080",
          user: "root",
          comm: "nginx"
        } as Record<string, string>,
      }
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
      lastUpdated: mockSnapshot.lastUpdated ?? Date.now(),
      modelRevision: mockSnapshot.modelRevision ?? "node-mock-v1",
      providerStates: [],
      source: "mock"
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
    const entries: LogEntry[] = mockContainers.map((container, index) => ({
      id: `${container.id}-log-${index}`,
      timestamp: MOCK_LOG_BASE_MILLIS - index * 30_000,
      container: container.name,
      level: "info",
      message: `${container.name} running on ${container.image}`
    }));
    return { ...publishLogsResponse(service, entries, q, cursor, limit), source: "mock" } as T;
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

const fetchDaemon = createDaemonClient({
  baseUrl: daemonBaseUrl,
  token: daemonToken,
  allowMockFallback,
  exposeErrorDetails,
  mockResponse: getMockResponse
});

function sendError(res: express.Response, error: unknown) {
  if (error instanceof HttpError) {
    res.status(error.status).json(publishApiPayload(error.body));
    return;
  }

  if (error instanceof SyntaxError && "body" in error) {
    res.status(400).json({
      code: "invalid_json",
      message: "Request body is invalid"
    } satisfies ApiError);
    return;
  }

  if (typeof error === "object" && error !== null && "type" in error && (error as { type?: string }).type === "entity.too.large") {
    res.status(413).json({
      code: "payload_too_large",
      message: "Request body is too large"
    } satisfies ApiError);
    return;
  }

  console.error(error);
  res.status(500).json(
    publishApiPayload({
      code: "internal_error",
      message: "Unexpected API failure"
    } satisfies ApiError)
  );
}

const readHandlers = createReadHandlers({ fetchDaemon, sendError, port });

// Route registration remains explicit here so the manifest is still the
// only browser-facing route inventory; readHandlers has no app/session state.
registerRoute("api-version", readHandlers.apiVersion);
registerRoute("health", readHandlers.health);
registerRoute("api-health", readHandlers.apiHealth);
registerRoute("status", readHandlers.status);
registerRoute("openapi", readHandlers.openapi);

registerRoute("auth-whoami", (req, res) => {
  const user = req.get(authUserHeader) ?? null;
  const name = req.get(authNameHeader) ?? null;
  const email = req.get(authEmailHeader) ?? null;
  const groups = (req.get(authGroupsHeader) ?? "").split(",").map((group) => group.trim()).filter(Boolean);
  res.json(publishApiPayload({ authenticated: authMode === "bearer" || Boolean(user), required: authRequired, user, name, email, groups } satisfies AuthWhoamiResponse));
});

registerRoute("snapshot", readHandlers.snapshot);
registerRoute("graph", readHandlers.graph);
registerRoute("runtime-map", readHandlers.runtimeMap);
registerRoute("diagnostics", readHandlers.diagnostics);
registerRoute("containers", readHandlers.containers);
registerRoute("container", readHandlers.container);
registerRoute("images", readHandlers.images);
registerRoute("networks", readHandlers.networks);
registerRoute("volumes", readHandlers.volumes);
registerRoute("logs", readHandlers.logs);
registerRoute("compose-scan", readHandlers.composeScan);
registerRoute("compose-graph", readHandlers.composeGraph);
registerRoute("compose-edit-plan", readHandlers.composeEditPlan);

registerRoute("events-stream", async (req, res) => {
  const requestedSession = readCookie(req, authCookieName);
  const cookieSession = authMode === "bearer" && validSession(requestedSession) ? requestedSession : "";
  const registration = registerSessionStream(cookieSession, res);
  if (registration !== "accepted") {
    res.status(registration === "session" ? 429 : 503).json({
      code: "stream_limit_reached",
      message: registration === "session" ? "Too many streams for this session" : "Too many active streams"
    } satisfies ApiError);
    return;
  }
  res.setHeader("Content-Type", SSE_CONTENT_TYPE);
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
    if (cookieSession && !validSession(cookieSession)) {
      res.end();
      return;
    }
    busy = true;
    try {
      const health = await fetchDaemon<HealthResponse>("/daemon/health");
      if (res.writableEnded || res.destroyed || (cookieSession && !validSession(cookieSession))) {
        if (!res.writableEnded && !res.destroyed) res.end();
        return;
      }
      res.write(formatSseEvent(SSE_EVENT.snapshot, publishApiPayload(health)));
    } catch (error) {
      if (res.writableEnded || res.destroyed || (cookieSession && !validSession(cookieSession))) {
        if (!res.writableEnded && !res.destroyed) res.end();
        return;
      }
      const payload = publishApiPayload(
        error instanceof HttpError
          ? error.body
          : {
              code: "stream_error",
              message: "Live stream failed"
            }
      );
      res.write(formatSseEvent(SSE_EVENT.error, payload));
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(emit, pollIntervalMs);
  // Comment-frame keepalive so proxies do not idle out the stream between
  // snapshot emits (SSE comments are ignored by EventSource clients).
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(formatSseHeartbeat());
    }
  }, 15_000);

  void emit();

  req.on("close", () => {
    clearInterval(timer);
    clearInterval(heartbeat);
    unregisterSessionStream(cookieSession, res);
    res.end();
  });
});

type ExpressLayer = {
  name?: string;
  route?: { path: string; methods: Record<string, boolean> };
  handle?: Function & { stack?: ExpressLayer[] };
};

export function registeredRoutes(appInstance: express.Express): RegisteredRoute[] {
  const router = appInstance as express.Express & { _router?: { stack?: ExpressLayer[] } };
  const routes: RegisteredRoute[] = [];
  const unknownLayers: string[] = [];
  const walk = (stack: readonly ExpressLayer[]) => {
    for (const layer of stack) {
      if (layer.route) {
        routes.push(...Object.entries(layer.route.methods)
          .filter(([, registered]) => registered)
          .map(([method]) => ({ method: method.toUpperCase() as RegisteredRoute["method"], path: layer.route!.path })));
        continue;
      }
      if (layer.handle?.stack) walk(layer.handle.stack);
      // Express itself installs these two initialization layers. Every
      // application middleware, responder, and error handler is explicitly
      // registered through trackedMiddleware above.
      const expressBuiltin = layer.name === "query" || layer.name === "expressInit";
      if (!expressBuiltin && !expectedMiddleware.has(layer.handle ?? (() => undefined))) {
        unknownLayers.push(layer.name || "anonymous middleware");
      }
    }
  };
  walk(router._router?.stack ?? []);
  if (unknownLayers.length) throw new Error(`Unknown Express layer(s): ${unknownLayers.join(", ")}`);
  return routes;
}

app.use(trackedMiddleware((_req, res) => {
  res.status(404).json({
    code: "not_found",
    message: "Route not found"
  } satisfies ApiError);
}));

app.use(
  trackedMiddleware((
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    sendError(res, error);
  }),
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
