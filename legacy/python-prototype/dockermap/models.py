from __future__ import annotations

from enum import Enum
from typing import Any, Dict, List

from pydantic import BaseModel, Field


class NodeType(str, Enum):
    CONTAINER = "container"
    NETWORK = "network"
    VOLUME = "volume"


class RelationshipType(str, Enum):
    CONNECTED_TO = "connected_to"
    MOUNTS = "mounts"


class Node(BaseModel):
    id: str
    type: NodeType
    label: str
    metadata: Dict[str, Any] = Field(default_factory=dict)


class Edge(BaseModel):
    source: str
    target: str
    relationship: RelationshipType
    metadata: Dict[str, Any] = Field(default_factory=dict)


class GraphResponse(BaseModel):
    nodes: List[Node]
    edges: List[Edge]
    schema_version: str = "v1"
