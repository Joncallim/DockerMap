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

## Docker Access

The daemon binds to loopback by default and only reads Docker state today. Docker socket access is still privileged, so mutation endpoints should not be added until the project has explicit authorization, dry-run previews, audit logging, and rollback guidance.

## Compose Scanning

`crates/dockermap-core` owns the typed Compose scan model for services, mounts, file origins, diagnostics, a derived path-map graph, and dry-run edit plans. The daemon exposes this through `GET /daemon/compose/scan`, `GET /daemon/compose/graph`, and `GET /daemon/compose/edit-plan`; `apps/api` proxies them at `GET /api/compose/scan`, `GET /api/compose/graph`, and `GET /api/compose/edit-plan`.

By default, scanning discovers standard Compose filenames under `DOCKERMAP_PROJECT_ROOT` or the daemon working directory. Explicit `file` query values are resolved only under that project root, parent traversal is rejected, and symlinked paths are not followed during request validation. The endpoint is read-only and reports diagnostics for unsupported syntax, unresolved variables, duplicate mount targets, invalid container targets, missing bind sources, and symlink bind sources.

Edit planning is also read-only. It accepts a Compose file, service, mount index, and proposed source/target values, then returns diagnostics and a unified diff with `willWrite: false`.
