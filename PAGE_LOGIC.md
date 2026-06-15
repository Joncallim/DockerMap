# DockerMap Page Logic Blueprint

## Shared Model

- Keep one canonical resource store derived from the Docker snapshot.
- Split the data flow into:
  1. raw Docker snapshot
  2. normalized resource store
  3. page selectors and filters
- Core store keys:
  - `containers.byId`
  - `containers.byName`
  - `images.byName`
  - `networks.byId`
  - `volumes.byId`
  - `logs.byContainerId`
  - `metrics.byContainerId`
  - derived edges for container-to-container, container-to-network, and container-to-volume

## Routes

- `/`
- `/containers`
- `/containers/{container_name}`
- `/images`
- `/networks`
- `/volumes`
- `/logs`

Use query params for page state:

- `/containers?q=api&status=running&network=network_app&sort=name`
- `/images?filter=in-use&sort=size`
- `/networks?network=network_data`
- `/volumes?filter=unused`
- `/logs?service=api&level=error`

## Shared UI State

- Global shell state:
  - `activePage`
  - `searchQuery`
  - `selectedEngine`
  - `viewportMode`
- Page state:
  - `filters`
  - `sortKey`
  - `sortDirection`
  - `selectedResource`
  - `expandedPanels`
  - `cursor`
- Live data state:
  - `snapshotTimestamp`
  - `graph`
  - `logs`
  - `health`

## Page Behavior

### Dashboard

- Graph is the primary interaction surface.
- Clicking a node should open container detail.
- KPI cards should derive from the current filtered state.
- Search should filter graph nodes, summary overlays, and KPI totals together.

### Containers

- Search by name, image, role, and label.
- Filter by status, network, image, and stack.
- Sort by name, cpu, memory, age, and status.
- `Inspect` routes to `/containers/{name}`.
- `Logs` routes to `/logs?service={name}`.

### Container Detail

- Resolve the URL slug to a canonical container record.
- Show dependencies, dependents, networks, volumes, ports, labels, metrics, and recent logs.
- Dependency chips route to sibling detail pages.
- Network chips route to filtered networks.
- Volume chips route to filtered volumes.
- Logs action routes to filtered logs.

### Images

- Group by repository:tag.
- Support search by repo, tag, image ID, and owning container.
- Filter by in-use, unused, dangling, local-only, and remote-available.
- Container chips route to container detail.
- Registry panel should eventually support pull, prune, inspect, and tag actions.

### Networks

- Show member containers, traffic, and network attributes.
- Support filter by driver, internal/public, and empty.
- Member chips route to container detail.
- Expanded view should eventually show IPAM, subnet, gateway, and attachability.

### Volumes

- Show attachment count, mountpoint, driver, and attachment safety.
- Support filter by attached/unattached, driver, and mount mode.
- Attached service chips route to container detail.
- Empty volumes should be clearly marked as prune candidates.

### Logs

- Query-param-driven service filter.
- Future filters:
  - severity
  - search within messages
  - live tail toggle
  - auto-scroll
- Service links route back to container detail.

## Cross-Page Rules

- Dashboard node -> container detail
- Dashboard image card -> images filtered to that image
- Dashboard network card -> networks filtered to that network
- Image container chip -> container detail
- Network member chip -> container detail
- Volume attached-service chip -> container detail
- Container detail logs action -> logs filtered to that container
- Logs service heading -> container detail

## Backend Endpoints To Add

- `GET /snapshot`
- `GET /containers`
- `GET /containers/{name}`
- `GET /containers/{name}/metrics`
- `GET /containers/{name}/logs`
- `GET /images`
- `GET /images/{imageRef}`
- `GET /networks`
- `GET /networks/{id}`
- `GET /volumes`
- `GET /volumes/{name}`
- `GET /logs?service=&cursor=`

Future mutation endpoints:

- `POST /containers/{name}/start`
- `POST /containers/{name}/stop`
- `POST /containers/{name}/restart`
- `POST /images/pull`
- `DELETE /images/{imageRef}`
- `POST /images/prune`
- `POST /networks`
- `DELETE /networks/{id}`
- `POST /networks/{id}/connect`
- `POST /networks/{id}/disconnect`
- `POST /volumes`
- `DELETE /volumes/{name}`
- `POST /volumes/prune`

## Recommended Build Order

1. Extract normalization out of `build_summary()`.
2. Add structured JSON endpoints per entity.
3. Add query-param parsing for filters and sorting.
4. Make graph nodes and summary chips route-aware and clickable.
5. Add real log filtering and streaming behavior.
6. Add mutations after read-only navigation and drill-down are stable.
