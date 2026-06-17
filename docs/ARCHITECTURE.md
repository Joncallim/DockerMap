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
