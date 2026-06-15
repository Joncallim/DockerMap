from __future__ import annotations

import math
from collections import Counter, defaultdict
from typing import Any, Dict, List, Optional


def normalize_snapshot(snapshot: Dict[str, Any]) -> Dict[str, Any]:
    containers = snapshot["containers"]
    networks = snapshot["networks"]
    volumes = snapshot["volumes"]

    container_by_id = {}
    container_by_name = {}
    image_index: Dict[str, Dict[str, Any]] = {}
    network_members: Dict[str, List[str]] = defaultdict(list)
    volume_usage: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    dependency_edges: List[Dict[str, str]] = []
    statuses = Counter()

    for container in containers:
        statuses[container["status"]] += 1
        container_by_id[container["id"]] = container
        container_by_name[container["name"]] = container

    normalized_containers = []
    for container in containers:
        role = container["metadata"].get("role", "service")
        dependency_names = [
            container_by_id.get(dep, {}).get("name", dep.replace("container_", ""))
            for dep in container["metadata"].get("depends_on", [])
        ]
        normalized = {
            "id": container["id"],
            "name": container["name"],
            "role": role,
            "image": container["image"],
            "status": container["status"],
            "networks": container["networks"],
            "ports": container["ports"],
            "mounts": container["mounts"],
            "depends_on": dependency_names,
            "labels": container["metadata"].get("labels", {}),
            "logs": _build_logs(container["name"], role),
            "cpu": _percent_for_name(container["name"], 18, 67),
            "memory": _percent_for_name(container["name"], 24, 79),
        }
        normalized_containers.append(normalized)

        image_entry = image_index.setdefault(
            normalized["image"],
            {
                "image": normalized["image"],
                "containers": [],
                "ports": set(),
                "roles": set(),
                "status": normalized["status"],
            },
        )
        image_entry["containers"].append(normalized["name"])
        image_entry["roles"].add(role)
        for port in normalized["ports"]:
            image_entry["ports"].add(_format_port(port))

        for network_id in normalized["networks"]:
            network_members[network_id].append(normalized["name"])

        for mount in normalized["mounts"]:
            volume_usage[mount["volumeId"]].append(
                {
                    "container": normalized["name"],
                    "destination": mount["destination"],
                    "rw": mount["rw"],
                }
            )

        for dependency_name in dependency_names:
            dependency_edges.append({"source": normalized["name"], "target": dependency_name})

    normalized_images = []
    for image, payload in image_index.items():
        normalized_images.append(
            {
                "image": image,
                "containers": sorted(payload["containers"]),
                "container_count": len(payload["containers"]),
                "roles": sorted(payload["roles"]),
                "ports": sorted(payload["ports"]),
                "status": payload["status"],
                "size": f"{_percent_for_name(image, 42, 220)} MB",
                "created": f"{_percent_for_name(image, 2, 21)} days ago",
                "id": _short_id(image),
            }
        )

    normalized_networks = []
    for network in networks:
        members = sorted(network_members.get(network["id"], []))
        normalized_networks.append(
            {
                "id": network["id"],
                "name": network["name"],
                "driver": network["driver"],
                "scope": network["scope"],
                "internal": network["metadata"].get("internal", False),
                "members": members,
                "traffic": f"{_percent_for_name(network['name'], 1, 9)}.{_percent_for_name(network['id'], 0, 9)} GB/s",
            }
        )

    normalized_volumes = []
    for volume in volumes:
        usage = volume_usage.get(volume["id"], [])
        normalized_volumes.append(
            {
                "id": volume["id"],
                "name": volume["name"],
                "driver": volume["driver"],
                "mountpoint": volume["metadata"].get("mountpoint", ""),
                "usage": usage,
                "attached": len(usage),
                "capacity": f"{_percent_for_name(volume['name'], 4, 18)} GB",
            }
        )

    topology_nodes = _build_topology_nodes(normalized_containers)
    positions = {node["id"]: {"x": node["x"], "y": node["y"]} for node in topology_nodes}
    topology_lines = []
    for edge in dependency_edges:
        source = next((c for c in normalized_containers if c["name"] == edge["source"]), None)
        target = next((c for c in normalized_containers if c["name"] == edge["target"]), None)
        if not source or not target:
            continue
        topology_lines.append(
            {
                "source": source["name"],
                "target": target["name"],
                "x1": positions[source["id"]]["x"],
                "y1": positions[source["id"]]["y"],
                "x2": positions[target["id"]]["x"],
                "y2": positions[target["id"]]["y"],
            }
        )

    return {
        "containers": sorted(normalized_containers, key=lambda item: item["name"]),
        "images": sorted(normalized_images, key=lambda item: item["image"]),
        "networks": sorted(normalized_networks, key=lambda item: item["name"]),
        "volumes": sorted(normalized_volumes, key=lambda item: item["name"]),
        "dependencies": dependency_edges,
        "status": {
            "running": statuses.get("running", 0),
            "warning": 1,
            "stopped": max(0, len(normalized_containers) - statuses.get("running", 0)),
        },
        "topology": {
            "center": {"label": "dockermap-cluster", "x": 50, "y": 50},
            "nodes": topology_nodes,
            "lines": topology_lines,
        },
        "registry": {
            "docker_hub": "Connected",
            "ghcr": "Connected",
            "private_acr": "Auth Needed",
        },
    }


def build_page_summary(
    store: Dict[str, Any],
    *,
    q: Optional[str] = None,
    status: Optional[str] = None,
    network: Optional[str] = None,
    image: Optional[str] = None,
    volume: Optional[str] = None,
    service: Optional[str] = None,
    sort: Optional[str] = None,
    filter_value: Optional[str] = None,
) -> Dict[str, Any]:
    containers = list(store["containers"])
    images = list(store["images"])
    networks = list(store["networks"])
    volumes = list(store["volumes"])
    dependencies = list(store["dependencies"])

    if q:
        needle = q.lower()
        containers = [
            item for item in containers
            if needle in item["name"].lower()
            or needle in item["image"].lower()
            or needle in item["role"].lower()
            or any(needle in str(value).lower() for value in item["labels"].values())
        ]
        images = [
            item for item in images
            if needle in item["image"].lower()
            or any(needle in name.lower() for name in item["containers"])
        ]
        networks = [
            item for item in networks
            if needle in item["name"].lower()
            or any(needle in name.lower() for name in item["members"])
        ]
        volumes = [
            item for item in volumes
            if needle in item["name"].lower()
            or needle in item["mountpoint"].lower()
            or any(needle in item_usage["container"].lower() for item_usage in item["usage"])
        ]

    if status:
        containers = [item for item in containers if item["status"] == status]

    if network:
        containers = [item for item in containers if network in item["networks"]]
        networks = [item for item in networks if item["id"] == network or item["name"] == network]

    if image:
        containers = [item for item in containers if item["image"] == image]
        images = [item for item in images if item["image"] == image]

    if volume:
        containers = [
            item for item in containers
            if any(mount["volumeId"] == volume for mount in item["mounts"])
        ]
        volumes = [item for item in volumes if item["id"] == volume or item["name"] == volume]

    if service:
        containers = [item for item in containers if item["name"] == service]

    if filter_value == "unused":
        images = [item for item in images if item["container_count"] == 0]
        volumes = [item for item in volumes if item["attached"] == 0]
    elif filter_value == "in-use":
        images = [item for item in images if item["container_count"] > 0]
    elif filter_value == "internal":
        networks = [item for item in networks if item["internal"]]
    elif filter_value == "public":
        networks = [item for item in networks if not item["internal"]]

    if sort == "name":
        containers.sort(key=lambda item: item["name"])
        images.sort(key=lambda item: item["image"])
        networks.sort(key=lambda item: item["name"])
        volumes.sort(key=lambda item: item["name"])
    elif sort == "image":
        containers.sort(key=lambda item: item["image"])
    elif sort == "size":
        images.sort(key=lambda item: item["size"])
    elif sort == "traffic":
        networks.sort(key=lambda item: item["traffic"], reverse=True)
    elif sort == "attached":
        volumes.sort(key=lambda item: item["attached"], reverse=True)

    visible_container_names = {item["name"] for item in containers}
    visible_container_ids = {item["id"] for item in containers}
    dependencies = [
        edge for edge in dependencies
        if edge["source"] in visible_container_names and edge["target"] in visible_container_names
    ]

    topology_nodes = [node for node in store["topology"]["nodes"] if node["id"] in visible_container_ids]
    visible_ids = {node["id"] for node in topology_nodes}
    topology_lines = []
    name_to_id = {item["name"]: item["id"] for item in containers}
    for edge in dependencies:
        source_id = name_to_id.get(edge["source"])
        target_id = name_to_id.get(edge["target"])
        if source_id in visible_ids and target_id in visible_ids:
            source = next(node for node in topology_nodes if node["id"] == source_id)
            target = next(node for node in topology_nodes if node["id"] == target_id)
            topology_lines.append(
                {
                    "source": edge["source"],
                    "target": edge["target"],
                    "x1": source["x"],
                    "y1": source["y"],
                    "x2": target["x"],
                    "y2": target["y"],
                }
            )

    return {
        "stats": {
            "containers": len(containers),
            "images": len(images),
            "networks": len(networks),
            "volumes": len(volumes),
            "dependencies": len(dependencies),
        },
        "status": store["status"],
        "containers": containers,
        "images": images,
        "networks": networks,
        "volumes": volumes,
        "dependencies": dependencies,
        "topology": {
            "center": store["topology"]["center"],
            "nodes": topology_nodes,
            "lines": topology_lines,
        },
        "registry": store["registry"],
        "filters": {
            "q": q or "",
            "status": status or "",
            "network": network or "",
            "image": image or "",
            "volume": volume or "",
            "service": service or "",
            "sort": sort or "",
            "filter": filter_value or "",
        },
    }


def get_container(store: Dict[str, Any], name: str) -> Optional[Dict[str, Any]]:
    return next((item for item in store["containers"] if item["name"] == name), None)


def get_logs(store: Dict[str, Any], service: Optional[str] = None) -> List[Dict[str, Any]]:
    containers = store["containers"]
    if service:
        containers = [item for item in containers if item["name"] == service]
    lines = []
    for container in containers:
        for line in container["logs"]:
            lines.append({"service": container["name"], **line})
    return lines


def _build_logs(name: str, role: str) -> List[Dict[str, str]]:
    return [
        {"timestamp": "22:03:11", "message": f"{name} accepted deployment sync for {role}"},
        {"timestamp": "22:03:18", "message": f"{name} refreshed health probes and route cache"},
        {"timestamp": "22:03:24", "message": f"{name} reported stable resource envelope"},
    ]


def _build_topology_nodes(containers: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    nodes = []
    for index, container in enumerate(containers):
        angle = (2 * math.pi * index) / max(len(containers), 1)
        radius = 190 if index % 2 == 0 else 145
        x = round(50 + math.cos(angle - math.pi / 2) * (radius / 6), 2)
        y = round(50 + math.sin(angle - math.pi / 2) * (radius / 6), 2)
        nodes.append(
            {
                "id": container["id"],
                "name": container["name"],
                "role": container["role"],
                "status": container["status"],
                "x": x,
                "y": y,
            }
        )
    return nodes


def _percent_for_name(seed: str, low: int, high: int) -> int:
    spread = max(high - low, 1)
    return low + (sum(ord(char) for char in seed) % spread)


def _short_id(seed: str) -> str:
    return hex(sum(ord(char) for char in seed))[2:12]


def _format_port(port: Dict[str, Any]) -> str:
    return f'{port["hostPort"]}:{port["containerPort"]}/{port["protocol"]}'
