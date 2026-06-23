import type {
  ComposeScan,
  ContainerRecord,
  DockerSnapshot,
  GraphResponse,
  HealthResponse,
  ImageRecord,
  LogsResponse,
  NetworkRecord,
  VolumeRecord
} from "@dockermap/contracts";

const demoSnapshot: DockerSnapshot = {
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

  throw new Error(`No demo data available for ${path}`);
}

export function getDemoHealth(): HealthResponse {
  return { ...demoHealth, lastUpdated: Date.now() };
}
