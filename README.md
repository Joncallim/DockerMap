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
- node compose scan: `http://127.0.0.1:4000/api/compose/scan?file=compose.yaml`
- node compose graph: `http://127.0.0.1:4000/api/compose/graph?file=compose.yaml`
- node compose edit plan: `http://127.0.0.1:4000/api/compose/edit-plan?file=compose.yaml&service=api&mount=0&source=./app`
- rust daemon health: `http://127.0.0.1:4100/daemon/health`
- rust compose scan: `http://127.0.0.1:4100/daemon/compose/scan?file=compose.yaml`
- rust compose graph: `http://127.0.0.1:4100/daemon/compose/graph?file=compose.yaml`
- rust compose edit plan: `http://127.0.0.1:4100/daemon/compose/edit-plan?file=compose.yaml&service=api&mount=0&source=./app`

Rust workspace commands:

```bash
npm run fmt:rust
npm run lint:rust
npm run build:rust
npm run test:rust
```

Headless Compose commands:

```bash
cargo run -p dockermap-daemon --manifest-path crates/Cargo.toml -- scan --file tests/fixtures/compose/path-mapping.compose.yaml
cargo run -p dockermap-daemon --manifest-path crates/Cargo.toml -- validate --file tests/fixtures/compose/path-mapping.compose.yaml
cargo run -p dockermap-daemon --manifest-path crates/Cargo.toml -- export --format json --file tests/fixtures/compose/path-mapping.compose.yaml
```

The CI template in `docs/ci/github-actions-ci.yml` covers TypeScript audit/typecheck/build and Rust format/lint/test. Publishing it to `.github/workflows/` requires GitHub `workflow` scope. The Rust toolchain is pinned in `rust-toolchain.toml`.

Architecture notes live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
The current pre-GUI backend build report lives in [BUILD_SUMMARY.md](BUILD_SUMMARY.md).
Market research and persistent-runtime expansion notes live in [docs/MARKET_RESEARCH.md](docs/MARKET_RESEARCH.md).
The UI/UX design language lives in [DESIGN.md](DESIGN.md) and [docs/DESIGN_LANGUAGE.md](docs/DESIGN_LANGUAGE.md).

## Current Status

- `apps/web` now renders stitched read-only product routes for dashboard, containers, images, networks, volumes, and logs.
- `apps/api` is now a browser-facing BFF that proxies the Rust daemon and exposes SSE heartbeat updates.
- `crates/dockermap-core` owns shared domain models, graph derivation, image derivation, and mock log generation.
- `crates/dockermap-daemon` now runs as an HTTP daemon with health, snapshot, graph, inventory, and logs endpoints.
- The daemon exposes a read-only Compose scan endpoint for discovered Compose files or explicit files under `DOCKERMAP_PROJECT_ROOT`.
- The daemon and API expose a dry-run Compose edit-plan endpoint that returns a diff and never writes files.
- The Rust daemon binary also supports headless `scan`, `validate`, and `export --format json` commands.
- The daemon auto-detects Docker and falls back to mock mode when `docker.sock` is unavailable.
- The older Python prototype now lives under `legacy/python-prototype` as migration reference and is no longer the active implementation path.
- Compose path-mapping fixtures live under `tests/fixtures/compose`.
