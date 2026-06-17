# DockerMap Architecture

DockerMap is a read-first Docker inventory and path-mapping app. The active implementation is the React + Node.js + Rust monorepo.

## Active Components

- `apps/web`: React/Vite interface for graph, inventory, and log views.
- `apps/api`: Express browser-facing API. It adapts browser requests to daemon endpoints and owns SSE heartbeat polling.
- `crates/dockermap-core`: Rust domain model and derivation logic. This is the canonical runtime model for Docker resources.
- `crates/dockermap-daemon`: Rust HTTP daemon. It talks to Docker through `bollard`, caches snapshots, and falls back to mock data when Docker is unavailable.
- `packages/contracts`: TypeScript API contracts consumed by the web and API workspaces.

## Source Of Truth

Runtime Docker data flows from the Rust daemon outward:

```text
Docker engine -> dockermap-daemon -> apps/api -> apps/web
                         |
                         v
                 dockermap-core
```

The Rust model is currently mirrored manually in `packages/contracts`. Before the API grows, the project should either generate TypeScript contracts from Rust schemas or add contract compatibility tests that compare serialized Rust fixtures with TypeScript expectations.

## Runtime Map

`GET /daemon/runtime/map` is the backend's provider-neutral JSON graph for visualization. `apps/api` proxies it as `GET /api/runtime/map`.

The map is read-only and currently contains:

- Docker containers, networks, volumes, and exposed/listening ports.
- systemd services from `systemctl list-units` when systemd is available.
- scheduled jobs from `/etc/crontab`, `/etc/cron.d/*`, and the current user's `crontab -l` when readable.
- PM2 apps from `pm2 jlist` when PM2 is installed.
- tmux sessions from `tmux list-sessions` when tmux is installed and reachable.
- listening sockets from `/proc/net/tcp` and `/proc/net/tcp6` on Linux.
- Tailscale peers from `tailscale status --json` when Tailscale is installed and authenticated.
- Headscale nodes from `headscale nodes list --output json` when Headscale is installed and readable.
- reverse proxy markers from common configs and Docker images/names, including nginx, Nginx Proxy Manager, Traefik, Caddy, HAProxy, Envoy, Apache httpd, Cloudflare Tunnel, and frp.
- local DNS markers from common configs and Docker images/names, including Pi-hole, AdGuard Home, dnsmasq, Unbound, CoreDNS, and Technitium DNS.

Optional providers fail softly with diagnostics instead of making the map endpoint fail. Provider commands are fixed read-only invocations, not user-supplied shell commands.

Kubernetes and other orchestrators should plug into this same model as additional providers, not replace the local Docker/host model. Kubernetes support should be opt-in because it needs kubeconfig or in-cluster credentials, namespace scoping, and RBAC permissions. A safe first Kubernetes provider should read namespaces, pods, services, deployments, ingress objects, persistent volume claims, and selected labels/owner references, then map them to `orchestrator_workload` nodes and edges.

## Docker Access

The daemon binds to loopback by default and only reads Docker state today. Docker socket access is still privileged, so mutation endpoints should not be added until the project has explicit authorization, dry-run previews, audit logging, and rollback guidance.

## Compose Scanning

`crates/dockermap-core` owns the typed Compose scan model for services, mounts, file origins, diagnostics, a derived path-map graph, and dry-run edit plans. The daemon exposes this through `GET /daemon/compose/scan`, `GET /daemon/compose/graph`, and `GET /daemon/compose/edit-plan`; `apps/api` proxies them at `GET /api/compose/scan`, `GET /api/compose/graph`, and `GET /api/compose/edit-plan`.

By default, scanning discovers standard Compose filenames under `DOCKERMAP_PROJECT_ROOT` or the daemon working directory. Explicit `file` query values are resolved only under that project root, parent traversal is rejected, and symlinked paths are not followed during request validation. The endpoint is read-only and reports diagnostics for unsupported syntax, unresolved variables, duplicate mount targets, invalid container targets, missing bind sources, and symlink bind sources.

Edit planning is also read-only. It accepts a Compose file, service, mount index, and proposed source/target values, then returns diagnostics and a unified diff with `willWrite: false`.
