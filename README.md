# DockerMap

DockerMap is a local web app that helps you understand what is running on one
self-hosted machine.

It shows Docker containers, Compose files, host services, ports, volumes, logs,
and related runtime signals in one place. The goal is simple: when something is
running on your server, DockerMap should help you answer what it is, what it
depends on, where its data lives, and what might break if you change it.

DockerMap is read-only today. It inspects your machine, but it does not restart
services, change containers, edit Compose files, or delete data.

## Quick Start

The fastest way to try DockerMap is Docker Compose:

```bash
docker compose up --build
```

Then open:

```text
http://127.0.0.1:3233
```

If you do not use Docker Compose, plain Docker works too:

```bash
docker build -t dockermap:local .
docker run --rm -p 127.0.0.1:3233:3233 \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  dockermap:local
```

The port is bound to loopback (127.0.0.1) because with no `DOCKERMAP_API_TOKEN`
set the API is unauthenticated read-only — do not expose it on the LAN. For
remote access, set `DOCKERMAP_API_TOKEN` (see `.env.example`) and publish the
port on the interface of your choice, e.g. `-p 3233:3233`.

That Docker socket mount is read-only. DockerMap needs it so it can inspect
containers, images, networks, volumes, and logs.

## Run From Source

Use this path if you are developing DockerMap or want the three local services
running directly on your machine.

Requirements:

- Node.js 22 or newer
- npm
- Rust, using the version pinned in [rust-toolchain.toml](rust-toolchain.toml)
- Docker, if you want live Docker data instead of fallback demo data

Install and start the local stack:

```bash
npm install
npm run dev:stack
```

This starts:

- Web app: `http://127.0.0.1:3233`
- Node API: `http://127.0.0.1:4000`
- Rust daemon: `http://127.0.0.1:4100`

## What You Can Do

- See containers, images, networks, volumes, and logs.
- See Compose files, declared mounts, named volumes, and dry-run edit plans.
- See a broader runtime map when host tools are available, including systemd,
  cron, PM2, tmux, listening sockets, Tailscale or Headscale, reverse-proxy
  markers, and local DNS markers.
- Use the Runtime Map workspace to inspect provider nodes, diagnostics, and
  cross-provider edges in one read-only view.
- Compare what Compose says should exist with what Docker is actually running.
- Use mock fallback data when Docker is not available.

DockerMap is for understanding a host, not controlling it. Write actions are
planned only after diff previews, backups, confirmations, and rollback behavior
exist.

## First Things To Check

If the app opens but looks empty:

1. Confirm Docker is running.
2. Confirm the Docker socket is mounted when using Docker:

   ```text
   /var/run/docker.sock:/var/run/docker.sock:ro
   ```

3. Check the API health endpoint:

   ```text
   http://127.0.0.1:4000/api/health
   ```

4. Check the daemon health endpoint:

   ```text
   http://127.0.0.1:4100/daemon/health
   ```

If Docker is not reachable, DockerMap should still start with safe fallback data
so the UI can be inspected.

## Status Widget

`GET /api/status` returns a compact, widget-friendly summary of the whole
host, intended for dashboards such as [Homepage](https://gethomepage.dev)
rather than the main UI. It is also available at the versioned alias
`/api/v1/status`.

```json
{
  "service": "dockermap",
  "status": "ok",
  "mode": "live",
  "dockerReachable": true,
  "containers": 12,
  "containersRunning": 11,
  "networks": 3,
  "volumes": 5,
  "images": 14,
  "healthy": 10,
  "attention": 1,
  "offline": 1,
  "version": "0.1.0"
}
```

Field meanings:

- `status` — `ok`, `degraded`, or `offline` (derived from Docker reachability
  and container state).
- `mode` — `live` (real Docker data) or `mock` (fallback demo data).
- `healthy` / `attention` / `offline` — container counts by state, where
  `containers = healthy + attention + offline`.

Like every non-health API route, `/api/status` requires a Bearer token when
`DOCKERMAP_API_TOKEN` is set (or equivalent reverse-proxy forward-auth).

Homepage custom-widget example (place under your Homepage `services.yaml`):

```yaml
- DockerMap:
    icon: docker
    href: http://127.0.0.1:3233
    widget:
      type: customapi
      url: http://127.0.0.1:4000/api/status
      headers:
        Authorization: Bearer ${DOCKERMAP_API_TOKEN}
      display: list
      mappings:
        - field: status
          label: Status
        - field: containersRunning
          label: Running
          format: number
        - field: containers
          label: Containers
          format: number
        - field: attention
          label: Needs attention
          format: number
```

## Safety Model

DockerMap treats host data as sensitive. Its current safety rules are:

- Bind to loopback by default.
- Keep daemon routes read-only.
- Use fixed provider commands, not user-supplied shell commands.
- Keep Compose edits as dry-run previews only.
- Require bearer-token auth for non-health API routes when
  `DOCKERMAP_API_TOKEN` is set.
- Redact or omit secrets from provider output where collectors may encounter
  service files, process args, package config, proxy config, logs, or env values.

More detail is in [docs/security/THREAT_MODEL.md](docs/security/THREAT_MODEL.md).

## Documentation

Start with the [DockerMap wiki](docs/README.md). It links to the short roadmap,
deployment notes, testing plan, architecture reference, and release checklist.

Useful entry points:

- [Docker setup](docs/deployment/DOCKER.md)
- [Host deployment](docs/deployment/DEPLOYMENT.md)
- [Reverse proxy notes](docs/deployment/REVERSE_PROXY.md)
- [Roadmap](docs/planning/ROADMAP.md)
- [Testing plan](docs/testing/TESTING_PLAN.md)
- [Architecture](docs/architecture/ARCHITECTURE.md)

## Developer Checks

Run the normal local gate before merging code:

```bash
npm run check
```

Useful narrower checks:

```bash
npm run typecheck
npm run build
npm run test:js
npm run test:api
npm run test:contracts
npm run test:rust
npm run test:e2e
```

Run live-Docker tests only on a host where Docker is available:

```bash
npm run test:live-docker
```

## Project Shape

- `apps/web`: React/Vite browser app.
- `apps/api`: Express API for the browser.
- `crates/dockermap-daemon`: Rust daemon that reads Docker and host runtime
  signals.
- `crates/dockermap-core`: Rust domain model, Compose parser, and graph logic.
- `packages/contracts`: TypeScript API contracts shared by the web and API.
- `tests`: shared fixtures and Playwright smoke tests.

DockerMap is built for people who run their own servers and want fewer blind
spots before they touch anything.
