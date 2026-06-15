from __future__ import annotations

from typing import List, Set

from dockermap.models import Edge, GraphResponse, Node, NodeType, RelationshipType
from dockermap.providers import DockerDataProvider


class GraphService:
    def __init__(self, provider: DockerDataProvider) -> None:
        self.provider = provider

    def get_graph(self) -> GraphResponse:
        snapshot = self.provider.get_snapshot()

        nodes: List[Node] = []
        edges: List[Edge] = []
        known_node_ids: Set[str] = set()

        for network in snapshot["networks"]:
            self._append_node(
                nodes,
                known_node_ids,
                Node(
                    id=network["id"],
                    type=NodeType.NETWORK,
                    label=network["name"],
                    metadata={
                        "driver": network["driver"],
                        "scope": network["scope"],
                        **network["metadata"],
                    },
                )
            )

        for volume in snapshot["volumes"]:
            self._append_node(
                nodes,
                known_node_ids,
                Node(
                    id=volume["id"],
                    type=NodeType.VOLUME,
                    label=volume["name"],
                    metadata={
                        "driver": volume["driver"],
                        **volume["metadata"],
                    },
                )
            )

        for container in snapshot["containers"]:
            self._append_node(
                nodes,
                known_node_ids,
                Node(
                    id=container["id"],
                    type=NodeType.CONTAINER,
                    label=container["name"],
                    metadata={
                        "image": container["image"],
                        "status": container["status"],
                        "ports": container["ports"],
                        **container["metadata"],
                    },
                )
            )

            for network_id in container["networks"]:
                if network_id not in known_node_ids:
                    continue

                edges.append(
                    Edge(
                        source=container["id"],
                        target=network_id,
                        relationship=RelationshipType.CONNECTED_TO,
                    )
                )

            for mount in container["mounts"]:
                if mount["volumeId"] not in known_node_ids:
                    continue

                edges.append(
                    Edge(
                        source=container["id"],
                        target=mount["volumeId"],
                        relationship=RelationshipType.MOUNTS,
                        metadata={
                            "destination": mount["destination"],
                            "rw": mount["rw"],
                        },
                    )
                )

        return GraphResponse(nodes=nodes, edges=edges)

    def _append_node(
        self,
        nodes: List[Node],
        known_node_ids: Set[str],
        node: Node,
    ) -> None:
        if node.id in known_node_ids:
            return

        nodes.append(node)
        known_node_ids.add(node.id)
