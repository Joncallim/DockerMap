export type HttpMethod = "GET" | "POST";
export type RouteAuth = "authenticated" | "public-in-bearer";
export type RouteRateLimit = "session-attempts" | null;

export type RoutePath = {
  path: string;
  canonicalPath: string;
};

export type RouteManifestEntry = {
  id: string;
  method: HttpMethod;
  paths: readonly RoutePath[];
  auth: RouteAuth;
  rateLimit: RouteRateLimit;
};

export type RegisteredRoute = Pick<RouteManifestEntry, "method"> & { path: string };

function apiPaths(path: string): readonly RoutePath[] {
  return [
    { path, canonicalPath: path },
    { path: path.replace("/api/", "/api/v1/"), canonicalPath: path }
  ];
}

// This is the single declaration of the browser-facing API. Express registers
// every entry below, and logging, authentication, rate limiting, and tests use
// the same templates and aliases.
export const ROUTE_MANIFEST = [
  { id: "health", method: "GET", paths: [{ path: "/health", canonicalPath: "/health" }], auth: "authenticated", rateLimit: null },
  { id: "api-health", method: "GET", paths: apiPaths("/api/health"), auth: "authenticated", rateLimit: null },
  { id: "status", method: "GET", paths: apiPaths("/api/status"), auth: "authenticated", rateLimit: null },
  { id: "openapi", method: "GET", paths: apiPaths("/api/openapi.json"), auth: "authenticated", rateLimit: null },
  { id: "auth-whoami", method: "GET", paths: apiPaths("/api/auth/whoami"), auth: "authenticated", rateLimit: null },
  { id: "snapshot", method: "GET", paths: apiPaths("/api/snapshot"), auth: "authenticated", rateLimit: null },
  { id: "graph", method: "GET", paths: apiPaths("/api/graph"), auth: "authenticated", rateLimit: null },
  { id: "runtime-map", method: "GET", paths: apiPaths("/api/runtime/map"), auth: "authenticated", rateLimit: null },
  { id: "diagnostics", method: "GET", paths: apiPaths("/api/diagnostics"), auth: "authenticated", rateLimit: null },
  { id: "containers", method: "GET", paths: apiPaths("/api/containers"), auth: "authenticated", rateLimit: null },
  { id: "container", method: "GET", paths: apiPaths("/api/containers/:name"), auth: "authenticated", rateLimit: null },
  { id: "images", method: "GET", paths: apiPaths("/api/images"), auth: "authenticated", rateLimit: null },
  { id: "networks", method: "GET", paths: apiPaths("/api/networks"), auth: "authenticated", rateLimit: null },
  { id: "volumes", method: "GET", paths: apiPaths("/api/volumes"), auth: "authenticated", rateLimit: null },
  { id: "logs", method: "GET", paths: apiPaths("/api/logs"), auth: "authenticated", rateLimit: null },
  { id: "compose-scan", method: "GET", paths: apiPaths("/api/compose/scan"), auth: "authenticated", rateLimit: null },
  { id: "compose-graph", method: "GET", paths: apiPaths("/api/compose/graph"), auth: "authenticated", rateLimit: null },
  { id: "compose-edit-plan", method: "GET", paths: apiPaths("/api/compose/edit-plan"), auth: "authenticated", rateLimit: null },
  { id: "events-stream", method: "GET", paths: apiPaths("/api/events/stream"), auth: "authenticated", rateLimit: null },
  { id: "auth-session", method: "POST", paths: apiPaths("/api/auth/session"), auth: "public-in-bearer", rateLimit: "session-attempts" },
  { id: "auth-session-logout", method: "POST", paths: apiPaths("/api/auth/session/logout"), auth: "authenticated", rateLimit: null },
  {
    id: "api-version",
    method: "GET",
    paths: [
      { path: "/api/v1", canonicalPath: "/api/v1" },
      { path: "/api/v1/", canonicalPath: "/api/v1/" }
    ],
    auth: "authenticated",
    rateLimit: null
  }
] as const satisfies readonly RouteManifestEntry[];

export type RouteId = (typeof ROUTE_MANIFEST)[number]["id"];

export function routeById(id: RouteId) {
  const route = ROUTE_MANIFEST.find((candidate) => candidate.id === id);
  if (!route) throw new Error(`Missing route manifest entry: ${id}`);
  return route;
}

function matchesPathTemplate(path: string, template: string): boolean {
  // Express routes are case-insensitive unless explicitly configured otherwise.
  const normalizedPath = path.toLowerCase();
  const normalizedTemplate = template.toLowerCase();
  const pathParts = normalizedPath.split("/");
  const templateParts = normalizedTemplate.split("/");
  const exactMatch = pathParts.length === templateParts.length && templateParts.every(
    (part, index) => part.startsWith(":") || part === pathParts[index]
  );
  // Express uses non-strict routing by default: a route without a trailing
  // slash also accepts exactly one trailing slash, but it does not collapse
  // double slashes or encoded separators.
  return exactMatch || (
    !normalizedTemplate.endsWith("/") &&
    normalizedPath.endsWith("/") &&
    !normalizedPath.endsWith("//") &&
    matchesPathTemplate(normalizedPath.slice(0, -1), normalizedTemplate)
  );
}

export function routeForRequest(method: string, path: string) {
  // Express resolves HEAD through a GET handler when there is no explicit HEAD route.
  const resolvedMethod = method === "HEAD" ? "GET" : method;
  return ROUTE_MANIFEST.find(
    (route) => route.method === resolvedMethod && route.paths.some((routePath) => matchesPathTemplate(path, routePath.path))
  );
}

export function routePolicyForRequest(method: string, path: string) {
  const route = routeForRequest(method, path);
  return route && { auth: route.auth, rateLimit: route.rateLimit };
}

export function canonicalRoutePath(path: string) {
  for (const route of ROUTE_MANIFEST) {
    for (const routePath of route.paths) {
      if (path === routePath.path) return routePath.canonicalPath;
    }
  }
  for (const route of ROUTE_MANIFEST) {
    for (const routePath of route.paths) {
      if (matchesPathTemplate(path, routePath.path)) return routePath.canonicalPath;
    }
  }
  return undefined;
}

export function isRoutePath(id: RouteId, method: string, path: string) {
  const route = routeById(id);
  return route.method === method && route.paths.some((routePath) => matchesPathTemplate(path, routePath.path));
}

export function assertRouteManifestComplete(liveRoutes: readonly RegisteredRoute[]) {
  const manifestRoutes = ROUTE_MANIFEST.flatMap((route) =>
    route.paths.map((routePath) => ({ method: route.method, path: routePath.path }))
  );
  const routeKey = (route: RegisteredRoute) => `${route.method} ${route.path}`;
  const liveKeys = new Set(liveRoutes.map(routeKey));
  const manifestKeys = new Set(manifestRoutes.map(routeKey));
  const missingFromManifest = [...liveKeys].filter((key) => !manifestKeys.has(key));
  const missingFromLiveRouter = [...manifestKeys].filter((key) => !liveKeys.has(key));
  if (missingFromManifest.length || missingFromLiveRouter.length) {
    throw new Error([
      missingFromManifest.length ? `Live routes missing from manifest: ${missingFromManifest.join(", ")}` : "",
      missingFromLiveRouter.length ? `Manifest routes missing from live router: ${missingFromLiveRouter.join(", ")}` : ""
    ].filter(Boolean).join("; "));
  }
}
