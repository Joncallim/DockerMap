import os
from typing import Optional

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse

from dockermap.models import GraphResponse
from dockermap.mockup import build_summary, render_page_html
from dockermap.providers import MockDockerDataProvider
from dockermap.service import GraphService
from dockermap.store import build_page_summary, get_container, get_logs, normalize_snapshot

app = FastAPI(title="DockerMap API", version="0.1.0")

provider = MockDockerDataProvider()
graph_service = GraphService(provider=provider)
DEFAULT_HOST = os.getenv("DOCKERMAP_HOST", "0.0.0.0")
DEFAULT_PORT = int(os.getenv("DOCKERMAP_PORT", "3233"))


def get_snapshot() -> dict:
    return provider.get_snapshot()


def get_store() -> dict:
    return normalize_snapshot(get_snapshot())


def get_filtered_summary(**filters: object) -> dict:
    return build_page_summary(get_store(), **filters)


@app.get("/", response_class=HTMLResponse)
def index(q: Optional[str] = None) -> HTMLResponse:
    summary = get_filtered_summary(q=q)
    return HTMLResponse(render_page_html(summary, "dashboard"))


@app.get("/containers", response_class=HTMLResponse)
def containers(
    q: Optional[str] = None,
    status: Optional[str] = None,
    network: Optional[str] = None,
    image: Optional[str] = None,
    sort: Optional[str] = None,
) -> HTMLResponse:
    summary = get_filtered_summary(
        q=q,
        status=status,
        network=network,
        image=image,
        sort=sort,
    )
    return HTMLResponse(render_page_html(summary, "containers"))


@app.get("/containers/{container_name}", response_class=HTMLResponse)
def container_detail(container_name: str) -> HTMLResponse:
    store = get_store()
    container = get_container(store, container_name)
    if container is None:
        raise HTTPException(status_code=404, detail="Container not found")
    summary = build_page_summary(store)
    return HTMLResponse(
        render_page_html(summary, "container_detail", container_name=container_name)
    )


@app.get("/images", response_class=HTMLResponse)
def images(
    q: Optional[str] = None,
    image: Optional[str] = None,
    filter: Optional[str] = None,
    sort: Optional[str] = None,
) -> HTMLResponse:
    summary = get_filtered_summary(q=q, image=image, filter_value=filter, sort=sort)
    return HTMLResponse(render_page_html(summary, "images"))


@app.get("/networks", response_class=HTMLResponse)
def networks(
    q: Optional[str] = None,
    network: Optional[str] = None,
    filter: Optional[str] = None,
    sort: Optional[str] = None,
) -> HTMLResponse:
    summary = get_filtered_summary(q=q, network=network, filter_value=filter, sort=sort)
    return HTMLResponse(render_page_html(summary, "networks"))


@app.get("/volumes", response_class=HTMLResponse)
def volumes(
    q: Optional[str] = None,
    volume: Optional[str] = None,
    filter: Optional[str] = None,
    sort: Optional[str] = None,
) -> HTMLResponse:
    summary = get_filtered_summary(q=q, volume=volume, filter_value=filter, sort=sort)
    return HTMLResponse(render_page_html(summary, "volumes"))


@app.get("/logs", response_class=HTMLResponse)
def logs(service: Optional[str] = None, q: Optional[str] = None) -> HTMLResponse:
    summary = get_filtered_summary(service=service, q=q)
    return HTMLResponse(render_page_html(summary, "logs", service_filter=service))


@app.get("/api/snapshot")
def api_snapshot() -> dict:
    return get_store()


@app.get("/api/containers")
def api_containers(
    q: Optional[str] = None,
    status: Optional[str] = None,
    network: Optional[str] = None,
    image: Optional[str] = None,
    sort: Optional[str] = None,
) -> dict:
    summary = get_filtered_summary(q=q, status=status, network=network, image=image, sort=sort)
    return {
        "filters": summary["filters"],
        "stats": summary["stats"],
        "containers": summary["containers"],
    }


@app.get("/api/containers/{container_name}")
def api_container_detail(container_name: str) -> dict:
    container = get_container(get_store(), container_name)
    if container is None:
        raise HTTPException(status_code=404, detail="Container not found")
    return container


@app.get("/api/images")
def api_images(
    q: Optional[str] = None,
    image: Optional[str] = None,
    filter: Optional[str] = None,
    sort: Optional[str] = None,
) -> dict:
    summary = get_filtered_summary(q=q, image=image, filter_value=filter, sort=sort)
    return {
        "filters": summary["filters"],
        "stats": summary["stats"],
        "images": summary["images"],
        "registry": summary["registry"],
    }


@app.get("/api/networks")
def api_networks(
    q: Optional[str] = None,
    network: Optional[str] = None,
    filter: Optional[str] = None,
    sort: Optional[str] = None,
) -> dict:
    summary = get_filtered_summary(q=q, network=network, filter_value=filter, sort=sort)
    return {
        "filters": summary["filters"],
        "stats": summary["stats"],
        "networks": summary["networks"],
    }


@app.get("/api/volumes")
def api_volumes(
    q: Optional[str] = None,
    volume: Optional[str] = None,
    filter: Optional[str] = None,
    sort: Optional[str] = None,
) -> dict:
    summary = get_filtered_summary(q=q, volume=volume, filter_value=filter, sort=sort)
    return {
        "filters": summary["filters"],
        "stats": summary["stats"],
        "volumes": summary["volumes"],
    }


@app.get("/api/logs")
def api_logs(service: Optional[str] = None) -> dict:
    return {"service": service, "entries": get_logs(get_store(), service)}


@app.get("/graph", response_model=GraphResponse)
def get_graph() -> GraphResponse:
    return graph_service.get_graph()


@app.get("/summary")
def get_summary() -> dict:
    return build_summary(get_snapshot())


@app.get("/health")
def healthcheck() -> dict[str, str]:
    return {"status": "ok"}


if __name__ == "__main__":
    uvicorn.run("main:app", host=DEFAULT_HOST, port=DEFAULT_PORT, reload=False)
