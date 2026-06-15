from __future__ import annotations

from typing import Any, Dict, List, Protocol, TypedDict


class PortBinding(TypedDict):
    containerPort: int
    hostPort: int
    protocol: str


class VolumeMount(TypedDict):
    volumeId: str
    destination: str
    rw: bool


class ContainerRecord(TypedDict):
    id: str
    name: str
    image: str
    status: str
    networks: List[str]
    ports: List[PortBinding]
    mounts: List[VolumeMount]
    metadata: Dict[str, Any]


class NetworkRecord(TypedDict):
    id: str
    name: str
    driver: str
    scope: str
    metadata: Dict[str, Any]


class VolumeRecord(TypedDict):
    id: str
    name: str
    driver: str
    metadata: Dict[str, Any]


class DockerSnapshot(TypedDict):
    containers: List[ContainerRecord]
    networks: List[NetworkRecord]
    volumes: List[VolumeRecord]


class DockerDataProvider(Protocol):
    def get_snapshot(self) -> DockerSnapshot:
        ...


class MockDockerDataProvider:
    def get_snapshot(self) -> DockerSnapshot:
        return {
            "containers": [
                {
                    "id": "container_gateway",
                    "name": "gateway",
                    "image": "nginx:1.27-alpine",
                    "status": "running",
                    "networks": ["network_edge", "network_app"],
                    "ports": [
                        {
                            "containerPort": 80,
                            "hostPort": 3233,
                            "protocol": "tcp",
                        }
                    ],
                    "mounts": [],
                    "metadata": {
                        "role": "edge proxy",
                        "depends_on": ["container_api"],
                        "labels": {
                            "com.example.project": "docker-map",
                        },
                    },
                },
                {
                    "id": "container_api",
                    "name": "api",
                    "image": "python:3.11-slim",
                    "status": "running",
                    "networks": ["network_app", "network_data"],
                    "ports": [
                        {
                            "containerPort": 3233,
                            "hostPort": 3233,
                            "protocol": "tcp",
                        }
                    ],
                    "mounts": [
                        {
                            "volumeId": "volume_app_cache",
                            "destination": "/app/.cache",
                            "rw": True,
                        }
                    ],
                    "metadata": {
                        "role": "api service",
                        "depends_on": ["container_db", "container_cache"],
                        "labels": {
                            "com.example.project": "docker-map",
                        },
                    },
                },
                {
                    "id": "container_worker",
                    "name": "worker",
                    "image": "python:3.11-slim",
                    "status": "running",
                    "networks": ["network_app", "network_data"],
                    "ports": [],
                    "mounts": [
                        {
                            "volumeId": "volume_app_cache",
                            "destination": "/app/.cache",
                            "rw": True,
                        }
                    ],
                    "metadata": {
                        "role": "background jobs",
                        "depends_on": ["container_db", "container_cache"],
                        "labels": {
                            "com.example.project": "docker-map",
                        },
                    },
                },
                {
                    "id": "container_db",
                    "name": "postgres",
                    "image": "postgres:16-alpine",
                    "status": "running",
                    "networks": ["network_data"],
                    "ports": [
                        {
                            "containerPort": 5432,
                            "hostPort": 5432,
                            "protocol": "tcp",
                        }
                    ],
                    "mounts": [
                        {
                            "volumeId": "volume_postgres_data",
                            "destination": "/var/lib/postgresql/data",
                            "rw": True,
                        }
                    ],
                    "metadata": {
                        "role": "primary database",
                        "depends_on": [],
                        "labels": {
                            "com.example.project": "docker-map",
                        },
                    },
                },
                {
                    "id": "container_cache",
                    "name": "redis",
                    "image": "redis:7-alpine",
                    "status": "running",
                    "networks": ["network_data"],
                    "ports": [
                        {
                            "containerPort": 6379,
                            "hostPort": 6379,
                            "protocol": "tcp",
                        }
                    ],
                    "mounts": [],
                    "metadata": {
                        "role": "cache and queue broker",
                        "depends_on": [],
                        "labels": {
                            "com.example.project": "docker-map",
                        },
                    },
                },
            ],
            "networks": [
                {
                    "id": "network_edge",
                    "name": "edge",
                    "driver": "bridge",
                    "scope": "local",
                    "metadata": {
                        "internal": False,
                        "attachable": True,
                    },
                },
                {
                    "id": "network_app",
                    "name": "application",
                    "driver": "bridge",
                    "scope": "local",
                    "metadata": {
                        "internal": False,
                        "attachable": True,
                    },
                },
                {
                    "id": "network_data",
                    "name": "data",
                    "driver": "bridge",
                    "scope": "local",
                    "metadata": {
                        "internal": True,
                        "attachable": False,
                    },
                },
            ],
            "volumes": [
                {
                    "id": "volume_postgres_data",
                    "name": "postgres_data",
                    "driver": "local",
                    "metadata": {
                        "mountpoint": "/var/lib/docker/volumes/postgres_data/_data",
                    },
                },
                {
                    "id": "volume_app_cache",
                    "name": "app_cache",
                    "driver": "local",
                    "metadata": {
                        "mountpoint": "/var/lib/docker/volumes/app_cache/_data",
                    },
                }
            ],
        }
