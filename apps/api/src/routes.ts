export type HttpMethod = "GET" | "POST";

export type RoutePath = {
  path: string;
  canonicalPath: string;
};

export type RouteManifestEntry = {
  id: string;
  method: HttpMethod;
  paths: readonly RoutePath[];
};

function apiPaths(path: string): readonly RoutePath[] {
  return [
    { path, canonicalPath: path },
    { path: path.replace("/api/", "/api/v1/"), canonicalPath: path }
  ];
}

// This is the single declaration of the browser-facing API. Express registers
// every entry below, and logging/tests use the same templates and aliases.
export const ROUTE_MANIFEST = [
  { id: "health", method: "GET", paths: [{ path: "/health", canonicalPath: "/health" }] },
  { id: "api-health", method: "GET", paths: apiPaths("/api/health") },
  { id: "status", method: "GET", paths: apiPaths("/api/status") },
  { id: "openapi", method: "GET", paths: apiPaths("/api/openapi.json") },
  { id: "auth-whoami", method: "GET", paths: apiPaths("/api/auth/whoami") },
  { id: "snapshot", method: "GET", paths: apiPaths("/api/snapshot") },
  { id: "graph", method: "GET", paths: apiPaths("/api/graph") },
  { id: "runtime-map", method: "GET", paths: apiPaths("/api/runtime/map") },
  { id: "diagnostics", method: "GET", paths: apiPaths("/api/diagnostics") },
  { id: "containers", method: "GET", paths: apiPaths("/api/containers") },
  { id: "container", method: "GET", paths: apiPaths("/api/containers/:name") },
  { id: "images", method: "GET", paths: apiPaths("/api/images") },
  { id: "networks", method: "GET", paths: apiPaths("/api/networks") },
  { id: "volumes", method: "GET", paths: apiPaths("/api/volumes") },
  { id: "logs", method: "GET", paths: apiPaths("/api/logs") },
  { id: "compose-scan", method: "GET", paths: apiPaths("/api/compose/scan") },
  { id: "compose-graph", method: "GET", paths: apiPaths("/api/compose/graph") },
  { id: "compose-edit-plan", method: "GET", paths: apiPaths("/api/compose/edit-plan") },
  { id: "events-stream", method: "GET", paths: apiPaths("/api/events/stream") },
  { id: "auth-session", method: "POST", paths: apiPaths("/api/auth/session") },
  { id: "auth-session-logout", method: "POST", paths: apiPaths("/api/auth/session/logout") },
  {
    id: "api-version",
    method: "GET",
    paths: [
      { path: "/api/v1", canonicalPath: "/api/v1" },
      { path: "/api/v1/", canonicalPath: "/api/v1/" }
    ]
  }
] as const satisfies readonly RouteManifestEntry[];

export type RouteId = (typeof ROUTE_MANIFEST)[number]["id"];

export function routeById(id: RouteId) {
  const route = ROUTE_MANIFEST.find((candidate) => candidate.id === id);
  if (!route) throw new Error(`Missing route manifest entry: ${id}`);
  return route;
}

function matchesPathTemplate(path: string, template: string) {
  const pathParts = path.split("/");
  const templateParts = template.split("/");
  return pathParts.length === templateParts.length && templateParts.every(
    (part, index) => part.startsWith(":") || part === pathParts[index]
  );
}

export function canonicalRoutePath(path: string) {
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
