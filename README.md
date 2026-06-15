# DockerMap

DockerMap now runs as a React + Node.js + Rust monorepo for a single-host, read/observe-first Docker graph experience.

## Monorepo Layout

```text
apps/
  web/        React + Vite frontend shell
  api/        Node.js + Express API
packages/
  contracts/  Shared TypeScript contracts
crates/
  dockermap-core/   Rust domain crate
  dockermap-daemon/ Rust Docker integration service
```

## Run The Stack

Install workspace dependencies:

```bash
npm install
```

Run everything together:

```bash
npm run dev:stack
```

Or run each service separately:

```bash
npm run dev:daemon
npm run dev:api
npm run dev:web -- --host 127.0.0.1
```

Default dev ports:

- web: `http://127.0.0.1:3233`
- api: `http://127.0.0.1:4000`
- daemon: `http://127.0.0.1:4100`

Key routes:

- web dashboard: `http://127.0.0.1:3233`
- node health: `http://127.0.0.1:4000/api/health`
- node snapshot: `http://127.0.0.1:4000/api/snapshot`
- rust daemon health: `http://127.0.0.1:4100/daemon/health`

Rust workspace commands:

```bash
npm run build:rust
npm run test:rust
```

## Current Status

- `apps/web` now renders stitched read-only product routes for dashboard, containers, images, networks, volumes, and logs.
- `apps/api` is now a browser-facing BFF that proxies the Rust daemon and exposes SSE heartbeat updates.
- `crates/dockermap-core` owns shared domain models, graph derivation, image derivation, and mock log generation.
- `crates/dockermap-daemon` now runs as an HTTP daemon with health, snapshot, graph, inventory, and logs endpoints.
- The daemon auto-detects Docker and falls back to mock mode when `docker.sock` is unavailable.
- The older Python prototype still exists in the repo as a migration reference and is no longer the active implementation path.
