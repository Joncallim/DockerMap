import type {
  ContainerRecord,
  DockerSnapshot,
  GraphResponse,
  ImageRecord,
  NetworkRecord,
  VolumeRecord
} from "@dockermap/contracts";

export const snapshot: DockerSnapshot = {
  containers: [
    {
      id: "container_gateway",
      name: "gateway",
      image: "nginx:1.27-alpine",
      status: "running",
      role: "edge proxy",
      networks: ["network_edge", "network_app"],
      ports: ["3233:80/tcp"],
      dependsOn: ["container_api"]
    },
    {
      id: "container_api",
      name: "api",
      image: "python:3.11-slim",
      status: "running",
      role: "api service",
      networks: ["network_app", "network_data"],
      ports: ["3233:3233/tcp"],
      dependsOn: ["container_db", "container_cache"]
    },
    {
      id: "container_worker",
      name: "worker",
      image: "python:3.11-slim",
      status: "running",
      role: "background jobs",
      networks: ["network_app", "network_data"],
      ports: [],
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
      dependsOn: []
    }
  ],
  images: [
    {
      image: "nginx:1.27-alpine",
      containers: ["gateway"],
      status: "running"
    },
    {
      image: "python:3.11-slim",
      containers: ["api", "worker"],
      status: "running"
    },
    {
      image: "postgres:16-alpine",
      containers: ["postgres"],
      status: "running"
    },
    {
      image: "redis:7-alpine",
      containers: ["redis"],
      status: "running"
    }
  ],
  networks: [
    {
      id: "network_edge",
      name: "edge",
      driver: "bridge",
      internal: false,
      members: ["gateway"]
    },
    {
      id: "network_app",
      name: "application",
      driver: "bridge",
      internal: false,
      members: ["gateway", "api", "worker"]
    },
    {
      id: "network_data",
      name: "data",
      driver: "bridge",
      internal: true,
      members: ["api", "worker", "postgres", "redis"]
    }
  ],
  volumes: [
    {
      id: "volume_postgres_data",
      name: "postgres_data",
      attachedTo: ["postgres"]
    },
    {
      id: "volume_app_cache",
      name: "app_cache",
      attachedTo: ["api", "worker"]
    }
  ],
  lastUpdated: Date.now()
};

export const graph: GraphResponse = {
  nodes: [
    { id: "container_gateway", type: "container", label: "gateway" },
    { id: "container_api", type: "container", label: "api" },
    { id: "container_worker", type: "container", label: "worker" },
    { id: "container_db", type: "container", label: "postgres" },
    { id: "container_cache", type: "container", label: "redis" },
    { id: "network_edge", type: "network", label: "edge" },
    { id: "network_app", type: "network", label: "application" },
    { id: "network_data", type: "network", label: "data" },
    { id: "volume_postgres_data", type: "volume", label: "postgres_data" },
    { id: "volume_app_cache", type: "volume", label: "app_cache" }
  ],
  edges: [
    { source: "container_gateway", target: "network_edge", relationship: "connected_to" },
    { source: "container_gateway", target: "network_app", relationship: "connected_to" },
    { source: "container_api", target: "network_app", relationship: "connected_to" },
    { source: "container_api", target: "network_data", relationship: "connected_to" },
    { source: "container_worker", target: "network_app", relationship: "connected_to" },
    { source: "container_worker", target: "network_data", relationship: "connected_to" },
    { source: "container_db", target: "network_data", relationship: "connected_to" },
    { source: "container_cache", target: "network_data", relationship: "connected_to" },
    { source: "container_db", target: "volume_postgres_data", relationship: "mounts" },
    { source: "container_api", target: "volume_app_cache", relationship: "mounts" },
    { source: "container_worker", target: "volume_app_cache", relationship: "mounts" }
  ]
};

export const containers: ContainerRecord[] = snapshot.containers;
export const images: ImageRecord[] = snapshot.images;
export const networks: NetworkRecord[] = snapshot.networks;
export const volumes: VolumeRecord[] = snapshot.volumes;
