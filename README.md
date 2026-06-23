# DockerMap

DockerMap is a local operational topology app for understanding one self-hosted machine.
Docker and Compose remain deep subsystems, but the product direction is broader: map the
whole environment across Docker, systemd, tmux, package ecosystems, native processes,
reverse proxies, databases, DNS, storage, network edges, and AI workloads.

It is read-first: today it can inspect files and show dry-run diffs, but it does not
write Compose files or change running services.

## Current Alpha Focus

The alpha focus is backend and security work, not GUI redesign:

- Treat every runtime as a provider-neutral service entity with name, status,
  dependencies, dependents, health, logs, events, owner, and location.
- Make systemd a first-class infrastructure layer with service status, enabled state,
  restart policy/count, uptime, dependencies, and recent-log metadata where safe.
- Discover npm and other application projects separately from containers so direct
  Node.js services, MCP servers, AI agents, and custom APIs appear on the same map.
- Represent cross-technology chains such as Cloudflare -> Caddy -> Docker network ->
  container -> database -> volume, or npm app -> systemd service -> tmux worker.
- Harden read-only collectors, bounded filesystem scans, API auth/CORS behavior, and
  release evidence before opening a full alpha.

The GUI has been rebuilt around understanding rather than container management. It is
organised into spaces — a Home command center (what needs attention), a Service Map
(dependencies and impact radius), a Change Center, and an explain-only Copilot — with
operational detail (networking, storage, images, logs, compose) and Docker internals
available on demand. A ⌘K command palette is a primary way to navigate and ask. The
GUI smoke test in `tests/e2e` encodes this information architecture. Some resource and
change-history surfaces are clearly labelled estimates until the matching read-only
collectors land in the daemon.

## Screenshots

Home command center — what needs attention, recent change, and a map preview:

![DockerMap command center](docs/screenshots/command-center.png)

Service Map — dependencies, health, and impact radius:

![DockerMap service map](docs/screenshots/service-map.png)

Service detail — overview, relationships, resources, logs, and configuration:

![DockerMap service detail](docs/screenshots/service-detail.png)

The design language behind these screens — the state system, spaces, progressive
disclosure, and component catalog — is documented in [DESIGN.md](DESIGN.md) (principles and
tokens) and [docs/DESIGN_LANGUAGE.md](docs/DESIGN_LANGUAGE.md) (applied, with screenshots of
the Change Center, Copilot, and command palette).

## What It Helps With

- See which containers, networks, volumes, and ports exist on a host.
- See which Compose services declare bind mounts and named volumes.
- Compare Compose-declared mounts with the mounts Docker is actually running.
- See non-Docker runtime signals from systemd, tmux, npm projects, PM2, cron,
  Tailscale/Headscale, reverse proxies, local DNS, and listening sockets.
- Follow service chains across implementation technologies without needing to know
  whether a workload is Docker, systemd, tmux, npm, Python, or a native Linux process.
- Spot common problems, such as missing host folders or duplicate container mount paths.
- Preview a Compose mount path change as a diff before any write feature exists.

## Project Layout

```text
apps/web          React + Vite browser app
apps/api          Node + Express browser-facing API
packages/contracts Shared TypeScript response types
crates/dockermap-core Rust models, Compose parsing, runtime graph logic
crates/dockermap-daemon Rust HTTP daemon that reads Docker, Compose, and host runtime signals
docs              Architecture, proxy, safety, and planning notes
tests/fixtures    Compose and API contract examples
```

## Run Locally

Install JavaScript dependencies:

```bash
npm install
```

Run the daemon, API, and web app together:

```bash
npm run dev:stack
```

Default local URLs:

- Web app: `http://127.0.0.1:3233`
- Node API: `http://127.0.0.1:4000`
- Rust daemon: `http://127.0.0.1:4100`

Useful API routes:

- `GET /api/health`
- `GET /api/snapshot`
- `GET /api/runtime/map`
- `GET /api/compose/scan?file=compose.yaml`
- `GET /api/compose/graph?file=compose.yaml`
- `GET /api/compose/edit-plan?file=compose.yaml&service=api&mount=0&source=./app`

Headless Compose commands:

```bash
cargo run -p dockermap-daemon --manifest-path crates/Cargo.toml -- scan --file tests/fixtures/compose/path-mapping.compose.yaml
cargo run -p dockermap-daemon --manifest-path crates/Cargo.toml -- validate --file tests/fixtures/compose/path-mapping.compose.yaml
cargo run -p dockermap-daemon --manifest-path crates/Cargo.toml -- export --format json --file tests/fixtures/compose/path-mapping.compose.yaml
```

## Local Rust Toolchain

The repo pins Rust `1.88.0` in `rust-toolchain.toml`. The checked-in lockfile requires a
new enough Cargo, so use rustup or make sure your shell uses the pinned toolchain.

In this workspace, Rust 1.88.0 is available under `~/.cargo/bin`. If your shell still
finds an older system Cargo first, run commands like this:

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo test -p dockermap-core --manifest-path crates/Cargo.toml
```

## Checks

These are the core automated checks. The full testing plan, including manual smoke tests
for the UI, bearer-token auth, and reverse-proxy review setup, is in
[docs/TESTING_PLAN.md](docs/TESTING_PLAN.md).

```bash
npm ci
npm run check
npm run test:e2e
# On a Docker-capable Linux host:
npm run test:live-docker
```

## Optional API Token

For local development, the Node API does not require a token unless
`DOCKERMAP_API_TOKEN` is set.

When the API is exposed through a reverse proxy, set a token:

```bash
DOCKERMAP_API_TOKEN="replace-with-a-long-random-value"
```

Then every route except `/health` and `/api/health` requires:

```text
Authorization: Bearer replace-with-a-long-random-value
```

For a review UI, prefer a reverse proxy that keeps the token server-side and injects the
header when it forwards `/api/*` requests to `127.0.0.1:4000`. See
[docs/REVERSE_PROXY.md](docs/REVERSE_PROXY.md).

## Current Status

- The web app has pages for dashboard, containers, images, networks, volumes, logs, and Compose.
- The daemon reads Docker when available and falls back to mock data when Docker is unavailable.
- The runtime map also reads PM2, systemd, cron, tmux, npm projects, listening sockets,
  Tailscale/Headscale, reverse-proxy markers, and local DNS markers when those tools are
  present on the host.
- systemd discovery includes bounded dependency enrichment, and npm discovery creates
  project and package-dependency nodes under the configured project root.
- Compose scanning discovers base files plus adjacent override files.
- Compose scans now include runtime mount checks: matched, missing, and extra.
- Rust and TypeScript share API contract fixtures under `tests/fixtures/contracts`,
  including an expanded cross-technology runtime-map fixture.
- CI runs TypeScript audit/typecheck/build/tests, Rust format/lint/tests, and Playwright smoke tests.

More background:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- [docs/TESTING_PLAN.md](docs/TESTING_PLAN.md)
- [docs/REVERSE_PROXY.md](docs/REVERSE_PROXY.md)
- [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)
- [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md)
- [docs/DOC_CONTROL.md](docs/DOC_CONTROL.md)
- [ROADMAP.md](ROADMAP.md)
