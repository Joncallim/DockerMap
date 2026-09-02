import type {
  ComposeScan,
  ContainerRecord,
  DiagnosticsReport,
  DockerSnapshot,
  FindingsResponse,
  GraphResponse,
  HealthResponse,
  ImageRecord,
  LogsResponse,
  NetworkRecord,
  RuntimeMap,
  VolumeRecord
} from "@dockermap/contracts";

const demoSnapshot: DockerSnapshot = {
  modelRevision: "demo-v1",
  containers: [
    {
      id: "container_gateway",
      name: "gateway",
      image: "nginx:1.27-alpine",
      status: "running",
      role: "edge proxy",
      networks: ["network_edge", "network_app"],
      ports: ["3233:80/tcp"],
      mounts: [],
      dependsOn: ["container_api"]
    },
    {
      id: "container_api",
      name: "api",
      image: "python:3.11-slim",
      status: "running",
      role: "api",
      networks: ["network_app", "network_data"],
      ports: ["4000:4000/tcp"],
      mounts: [
        {
          id: "container_api:/workspace/src:/srv/dockermap/src",
          kind: "bind",
          source: "/srv/dockermap/src",
          target: "/workspace/src",
          readOnly: false
        }
      ],
      dependsOn: ["container_db", "container_cache"]
    },
    {
      id: "container_worker",
      name: "worker",
      image: "python:3.11-slim",
      status: "running",
      role: "worker",
      networks: ["network_app", "network_data"],
      ports: [],
      mounts: [
        {
          id: "container_worker:/var/log/dockermap:logs",
          kind: "named_volume",
          source: "logs",
          target: "/var/log/dockermap",
          readOnly: false
        }
      ],
      dependsOn: ["container_db", "container_cache"]
    },
    {
      id: "container_db",
      name: "postgres",
      image: "postgres:16-alpine",
      status: "running",
      role: "primary database",
      networks: ["network_data"],
      ports: ["5432:5432/tcp"],
      mounts: [
        {
          id: "container_db:/var/lib/postgresql/data:postgres_data",
          kind: "named_volume",
          source: "postgres_data",
          target: "/var/lib/postgresql/data",
          readOnly: false
        }
      ],
      dependsOn: []
    },
    {
      id: "container_cache",
      name: "redis",
      image: "redis:7-alpine",
      status: "running",
      role: "cache and queue broker",
      networks: ["network_data"],
      ports: ["6379:6379/tcp"],
      mounts: [],
      dependsOn: []
    },
    {
      id: "container_billing",
      name: "billing",
      image: "node:20-alpine",
      status: "restarting",
      role: "worker",
      networks: ["network_app", "network_data"],
      ports: [],
      mounts: [],
      dependsOn: ["container_db"]
    }
  ],
  images: [
    { image: "nginx:1.27-alpine", containers: ["gateway"], status: "running" },
    { image: "python:3.11-slim", containers: ["api", "worker"], status: "running" },
    { image: "postgres:16-alpine", containers: ["postgres"], status: "running" },
    { image: "redis:7-alpine", containers: ["redis"], status: "running" },
    { image: "node:20-alpine", containers: ["billing"], status: "restarting" }
  ],
  networks: [
    { id: "network_edge", name: "edge", driver: "bridge", internal: false, members: ["gateway"] },
    {
      id: "network_app",
      name: "application",
      driver: "bridge",
      internal: false,
      members: ["gateway", "api", "worker", "billing"]
    },
    {
      id: "network_data",
      name: "data",
      driver: "bridge",
      internal: true,
      members: ["api", "worker", "postgres", "redis", "billing"]
    }
  ],
  volumes: [
    { id: "volume_postgres_data", name: "postgres_data", attachedTo: ["postgres"] },
    { id: "volume_logs", name: "logs", attachedTo: ["worker"] }
  ],
  lastUpdated: Date.now()
};

const demoGraph: GraphResponse = {
  nodes: [
    { id: "container_gateway", type: "container", label: "gateway" },
    { id: "container_api", type: "container", label: "api" },
    { id: "container_worker", type: "container", label: "worker" },
    { id: "container_db", type: "container", label: "postgres" },
    { id: "container_cache", type: "container", label: "redis" },
    { id: "container_billing", type: "container", label: "billing" },
    { id: "network_edge", type: "network", label: "edge" },
    { id: "network_app", type: "network", label: "application" },
    { id: "network_data", type: "network", label: "data" },
    { id: "volume_postgres_data", type: "volume", label: "postgres_data" },
    { id: "volume_logs", type: "volume", label: "logs" }
  ],
  edges: [
    { source: "container_gateway", target: "network_edge", relationship: "connected_to" },
    { source: "container_gateway", target: "network_app", relationship: "connected_to" },
    { source: "container_api", target: "network_app", relationship: "connected_to" },
    { source: "container_api", target: "network_data", relationship: "connected_to" },
    { source: "container_worker", target: "network_app", relationship: "connected_to" },
    { source: "container_worker", target: "network_data", relationship: "connected_to" },
    { source: "container_billing", target: "network_app", relationship: "connected_to" },
    { source: "container_billing", target: "network_data", relationship: "connected_to" },
    { source: "container_db", target: "network_data", relationship: "connected_to" },
    { source: "container_cache", target: "network_data", relationship: "connected_to" },
    { source: "container_db", target: "volume_postgres_data", relationship: "mounts" },
    { source: "container_worker", target: "volume_logs", relationship: "mounts" }
  ]
};

const demoContainers: ContainerRecord[] = demoSnapshot.containers;
const demoImages: ImageRecord[] = demoSnapshot.images;
const demoNetworks: NetworkRecord[] = demoSnapshot.networks;
const demoVolumes: VolumeRecord[] = demoSnapshot.volumes;

const demoHealth: HealthResponse = {
  status: "ok",
  mode: "mock",
  dockerReachable: true,
  lastUpdated: Date.now(),
  modelRevision: "demo-v1",
  snapshotVersion: "demo",
  message: "Demo mode — showing sample data, no Docker host connected"
};

const demoComposeScan: ComposeScan = {
  files: ["docker-compose.yml"],
  projectRoot: "/home/demo/dockermap",
  services: demoContainers.map((container) => ({
    name: container.name,
    image: container.image,
    environment: {},
    dependsOn: container.dependsOn.map(
      (id) => demoContainers.find((c) => c.id === id)?.name ?? id
    )
  })),
  mounts: [],
  correlations: [
    {
      id: "corr_postgres_data",
      service: "postgres",
      container: "postgres",
      composeMountId: "compose_postgres_data",
      kind: "named_volume",
      target: "/var/lib/postgresql/data",
      declaredSource: "postgres_data",
      runtimeSource: "postgres_data",
      status: "matched"
    },
    {
      id: "corr_logs",
      service: "worker",
      container: "worker",
      composeMountId: "compose_logs",
      kind: "named_volume",
      target: "/var/log/dockermap",
      declaredSource: "logs",
      runtimeSource: "logs",
      status: "matched"
    }
  ],
  diagnostics: [
    {
      id: "demo_diagnostic",
      severity: "info",
      message: "This Compose scan is sample data shown because Demo Mode is enabled.",
      origin: { file: "docker-compose.yml", service: null, field: "files" }
    }
  ]
};

const demoRuntimeMap: RuntimeMap = {
  modelRevision: "demo-v1",
  providerStates: [
    { slot: "network_infrastructure", state: "unavailable", lastAttemptMs: null, lastSuccessMs: null, lastDurationMs: null, consecutiveFailureCount: 0, dataRevision: null, statusReason: "initial" },
    { slot: "host_scoped", state: "unavailable", lastAttemptMs: null, lastSuccessMs: null, lastDurationMs: null, consecutiveFailureCount: 0, dataRevision: null, statusReason: "initial" },
    { slot: "python_processes", state: "unavailable", lastAttemptMs: null, lastSuccessMs: null, lastDurationMs: null, consecutiveFailureCount: 0, dataRevision: null, statusReason: "initial" },
    { slot: "native_processes", state: "unavailable", lastAttemptMs: null, lastSuccessMs: null, lastDurationMs: null, consecutiveFailureCount: 0, dataRevision: null, statusReason: "initial" },
    { slot: "systemd", state: "unavailable", lastAttemptMs: null, lastSuccessMs: null, lastDurationMs: null, consecutiveFailureCount: 0, dataRevision: null, statusReason: "initial" },
    { slot: "project_npm", state: "unavailable", lastAttemptMs: null, lastSuccessMs: null, lastDurationMs: null, consecutiveFailureCount: 0, dataRevision: null, statusReason: "initial" }
  ],
  nodes: [
    {
      id: "runtime_gateway",
      provider: "reverse_proxy",
      type: "reverse_proxy",
      layer: "edge",
      label: "gateway",
      status: "running",
      metadata: {
        config: "nginx.conf",
        tls: true
      },
      service: {
        name: "gateway",
        status: "running",
        dependencies: ["api"],
        dependents: ["review-browser"],
        health: { state: "healthy", source: "nginx", message: "Serving edge traffic" },
        logs: [{ id: "runtime_gateway_log", source: "nginx", level: "info" }],
        events: [{ id: "runtime_gateway_event", kind: "reload", message: "Proxy config reloaded" }],
        owner: { kind: "team", name: "platform" },
        location: { kind: "host", value: "demo-host" }
      }
    },
    {
      id: "runtime_api",
      provider: "docker",
      type: "container",
      layer: "container",
      label: "api",
      status: "running",
      metadata: {
        image: "python:3.11-slim",
        role: "api"
      },
      service: {
        name: "api",
        status: "running",
        dependencies: ["postgres", "redis"],
        dependents: ["gateway", "worker"],
        health: { state: "healthy", source: "http", message: "Responding in 42ms" },
        logs: [{ id: "runtime_api_log", source: "docker logs api", level: "info" }],
        events: [{ id: "runtime_api_event", kind: "deploy", message: "API revision promoted" }],
        owner: { kind: "team", name: "product" },
        location: { kind: "container", value: "application" }
      }
    },
    {
      id: "runtime_worker",
      provider: "process",
      type: "worker",
      layer: "process",
      label: "worker",
      status: "running",
      metadata: {
        pid: 2412,
        command: "python worker.py"
      },
      service: {
        name: "worker",
        status: "running",
        dependencies: ["api", "postgres"],
        dependents: [],
        health: { state: "degraded", source: "heartbeat", message: "Queue lag above target" },
        logs: [{ id: "runtime_worker_log", source: "worker", level: "warn" }],
        events: [{ id: "runtime_worker_event", kind: "lag", message: "Queue delay crossed 30 seconds" }],
        owner: { kind: "team", name: "ops" },
        location: { kind: "host", value: "demo-host" }
      }
    },
    {
      id: "runtime_systemd_api",
      provider: "systemd",
      type: "systemd_service",
      layer: "host",
      label: "dockermap-api.service",
      status: "running",
      metadata: {
        unit: "dockermap-api.service",
        restart: "always"
      },
      service: {
        name: "dockermap-api.service",
        status: "running",
        dependencies: ["docker.service"],
        dependents: ["gateway"],
        health: { state: "healthy", source: "systemd", message: "Unit is active" },
        logs: [],
        events: [{ id: "runtime_systemd_event", kind: "start", message: "systemd marked the unit active" }],
        owner: { kind: "system", name: "systemd" },
        location: { kind: "host", value: "demo-host" }
      }
    },
    {
      id: "runtime_npm_forge",
      provider: "npm",
      type: "node_application",
      layer: "package",
      label: "forge-ui",
      status: "running",
      metadata: {
        framework: "vite",
        path: "/srv/forge"
      },
      package: {
        name: "forge-ui",
        manager: "npm",
        version: "0.4.0",
        dependencies: ["react", "vite"],
        dependents: [],
        update: {
          currentVersion: "0.4.0",
          latestVersion: null,
          available: false,
          advisories: []
        },
        owner: { kind: "team", name: "frontend" },
        location: { kind: "path", value: "/srv/forge" }
      }
    },
    {
      id: "runtime_postgres",
      provider: "docker",
      type: "database",
      layer: "container",
      label: "postgres",
      status: "running",
      metadata: {
        image: "postgres:16-alpine",
        role: "database"
      },
      service: {
        name: "postgres",
        status: "running",
        dependencies: ["postgres_data"],
        dependents: ["api", "worker"],
        health: { state: "healthy", source: "postgres", message: "Primary is ready" },
        logs: [],
        events: [{ id: "runtime_postgres_event", kind: "backup", message: "Nightly backup completed" }],
        owner: { kind: "team", name: "platform" },
        location: { kind: "container", value: "data" }
      }
    },
    {
      id: "runtime_postgres_data",
      provider: "docker",
      type: "docker_volume",
      layer: "storage",
      label: "postgres_data",
      status: "attached",
      metadata: {
        driver: "local"
      }
    }
  ],
  edges: [
    { source: "runtime_gateway", target: "runtime_api", relationship: "proxies_to", metadata: { port: 80 }, evidenceRefs: [] },
    { source: "runtime_api", target: "runtime_postgres", relationship: "depends_on", metadata: { source: "compose" }, evidenceRefs: [] },
    { source: "runtime_worker", target: "runtime_api", relationship: "calls", metadata: { queue: "jobs" }, evidenceRefs: [] },
    { source: "runtime_worker", target: "runtime_postgres", relationship: "depends_on", metadata: { source: "runtime" }, evidenceRefs: [] },
    { source: "runtime_postgres", target: "runtime_postgres_data", relationship: "mounts", metadata: { path: "/var/lib/postgresql/data" }, evidenceRefs: [] },
    { source: "runtime_systemd_api", target: "runtime_gateway", relationship: "exposes", metadata: { unit: "dockermap-api.service" }, evidenceRefs: [] }
  ],
  diagnostics: [
    {
      provider: "process",
      severity: "warning",
      message: "Worker heartbeat is stale enough to warrant inspection."
    }
  ],
  lastUpdated: Date.now()
};

function demoLogs(service: string | null): LogsResponse {
  const containers = service ? demoContainers.filter((c) => c.name === service) : demoContainers;
  const now = Date.now();
  return {
    service,
    entries: containers.flatMap((container, index) => [
      {
        id: `${container.id}-log-${index}-0`,
        timestamp: now - index * 45_000,
        container: container.name,
        level: container.status === "restarting" ? "warn" : "info",
        message: `${container.name} (${container.image}) reporting status: ${container.status}`
      },
      {
        id: `${container.id}-log-${index}-1`,
        timestamp: now - index * 45_000 - 15_000,
        container: container.name,
        level: "info",
        message: `Health check passed for ${container.name}`
      }
    ]),
    nextCursor: null
  };
}

export function getDemoResponse<T>(path: string): T {
  const [pathname, search] = path.split("?");
  const params = new URLSearchParams(search ?? "");

  if (pathname === "/api/snapshot") return demoSnapshot as T;
  if (pathname === "/api/graph") return demoGraph as T;
  if (pathname === "/api/runtime/map") return demoRuntimeMap as T;
  if (pathname === "/api/findings") return { findings: [], modelRevision: demoSnapshot.modelRevision } as FindingsResponse as T;
  // Demo Mode has no observed host history. Return only the daemon's safe
  // empty shape so the background resource request cannot turn a demo render
  // into an error state; observedHistory.ts still rejects this mock source.
  if (pathname === "/api/history") return { source: "mock", baselineEstablished: false, currentModelRevision: null, observedRevision: null, events: [] } as T;
  if (pathname === "/api/resource-telemetry") return { source: "mock", collectionState: "unavailable", currentModelRevision: null, currentObservationRevision: null, samples: [] } as T;
  if (pathname === "/api/health") {
    return {
      node: { status: "ok", port: 4000 },
      daemon: demoHealth,
      dockerReachable: demoHealth.dockerReachable
    } as T;
  }
  if (pathname === "/api/containers") return { containers: demoContainers } as T;
  if (pathname === "/api/images") return { images: demoImages } as T;
  if (pathname === "/api/networks") return { networks: demoNetworks } as T;
  if (pathname === "/api/volumes") return { volumes: demoVolumes } as T;
  if (pathname === "/api/logs") return demoLogs(params.get("service")) as T;
  if (pathname === "/api/compose/scan") return demoComposeScan as T;
  if (pathname === "/api/diagnostics") return demoDiagnostics() as T;

  throw new Error(`No demo data available for ${path}`);
}

function demoDiagnostics(): DiagnosticsReport {
  return {
    generatedAt: Date.now(),
    entries: [
      {
        id: "demo_compose_sample",
        source: "compose",
        severity: "info",
        message: "Demo mode — Compose scan is bundled sample data, not a live project",
        file: "docker-compose.yml",
        service: null
      },
      {
        id: "demo_runtime_sample",
        source: "runtime",
        severity: "warning",
        message: "Demo mode — runtime providers reflect a sample host, not this machine",
        file: null,
        service: null
      }
    ]
  };
}

export function getDemoHealth(): HealthResponse {
  return { ...demoHealth, lastUpdated: Date.now() };
}
