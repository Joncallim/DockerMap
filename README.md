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
docs/
  ARCHITECTURE.md   Active stack and data-flow notes
  ci/               GitHub Actions template pending workflow-scope publish
legacy/
  python-prototype/ Earlier FastAPI prototype kept for reference
tests/
  fixtures/         Compose fixtures for path-mapping work
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
npm run fmt:rust
npm run lint:rust
npm run build:rust
npm run test:rust
```

The CI template in `docs/ci/github-actions-ci.yml` covers TypeScript audit/typecheck/build and Rust format/lint/test. Publishing it to `.github/workflows/` requires GitHub `workflow` scope. The Rust toolchain is pinned in `rust-toolchain.toml`.

Architecture notes live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Current Status

- `apps/web` now renders stitched read-only product routes for dashboard, containers, images, networks, volumes, and logs.
- `apps/api` is now a browser-facing BFF that proxies the Rust daemon and exposes SSE heartbeat updates.
- `crates/dockermap-core` owns shared domain models, graph derivation, image derivation, and mock log generation.
- `crates/dockermap-daemon` now runs as an HTTP daemon with health, snapshot, graph, inventory, and logs endpoints.
- The daemon auto-detects Docker and falls back to mock mode when `docker.sock` is unavailable.
- The older Python prototype now lives under `legacy/python-prototype` as migration reference and is no longer the active implementation path.
- Compose path-mapping fixtures live under `tests/fixtures/compose`.
