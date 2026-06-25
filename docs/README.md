# DockerMap Wiki

This wiki is the short path through the DockerMap docs. Start here when you
want to run the app, understand the product direction, or find the right deeper
reference.

## What DockerMap Is

DockerMap is a local inspection app for one self-hosted machine. It reads Docker
and host runtime signals, then shows how services, ports, volumes, logs,
Compose files, and host processes relate to each other.

It is read-only today. It should help you understand the machine before you make
changes, not make changes for you.

## Start Here

- [Project README](../README.md): quick startup, basic troubleshooting, and the
  plain-language overview.
- [Docker setup](deployment/DOCKER.md): container build and Compose run details.
- [Host deployment](deployment/DEPLOYMENT.md): running DockerMap directly on a
  host.
- [Reverse proxy notes](deployment/REVERSE_PROXY.md): exposing the web/API
  safely for review.

## Current State

Working now:

- React web app on port `3233`.
- Node API on port `4000`.
- Rust daemon on port `4100`.
- Docker inventory for containers, images, networks, volumes, logs, and mounts.
- Compose scan, graph, and dry-run edit-plan endpoints.
- Runtime-map providers for systemd, cron, PM2, tmux, listening sockets,
  Tailscale, Headscale, reverse-proxy markers, local DNS markers, and Docker
  graph nodes when those tools are available.
- Shared Rust and TypeScript contract fixtures.
- API security tests and Playwright smoke tests.

Still in progress:

- Provider-specific redaction fixtures.
- Richer systemd and package metadata.
- Python and native-process providers.
- Better table sorting, filtering, graph navigation, and logs UI.
- OpenAPI docs and stable versioned API routes.
- Safe write mode with backups and rollback. This is not enabled today.

## Roadmap In One Page

Use [planning/ROADMAP.md](planning/ROADMAP.md) for the current short roadmap.
The practical direction is:

- Now: harden the read-only runtime map and security evidence.
- Next: improve Compose diagnostics, list filtering, logs, and graph navigation.
- Later: add safe edit mode only after validation, backups, confirmation, and
  rollback are designed and tested.

The older file-level task breakdown remains in
[planning/IMPLEMENTATION_PLAN.md](planning/IMPLEMENTATION_PLAN.md) for agents or
developers that need detailed implementation notes.

## Safety Rules

DockerMap should keep these promises until a future write-mode design changes
them:

- No service restarts, container changes, or file writes from normal inspection
  routes.
- Fixed read-only provider commands only.
- Bounded filesystem discovery.
- No unredacted secrets in API responses, fixtures, logs, screenshots, or docs.
- Loopback-only daemon by default.
- Bearer-token protection for non-health API routes when configured.
- Compose edit plans return diffs with `willWrite: false`.

Read [security/THREAT_MODEL.md](security/THREAT_MODEL.md) before changing API,
daemon, provider, auth, deployment, or write-mode behavior.

## Developer Map

- [architecture/ARCHITECTURE.md](architecture/ARCHITECTURE.md): system layout,
  data flow, runtime-map model, and provider rules.
- [architecture/PAGE_LOGIC.md](architecture/PAGE_LOGIC.md): intended UI routes,
  page behavior, and cross-page navigation.
- [testing/TESTING_PLAN.md](testing/TESTING_PLAN.md): local checks, security
  tests, browser smoke tests, live-Docker tests, and manual release smoke.
- [testing/SANDBOX_FIXTURE.md](testing/SANDBOX_FIXTURE.md): isolated labeled
  Docker and provider-stub topology for manual DockerMap testing.
- [release/RELEASE_CHECKLIST.md](release/RELEASE_CHECKLIST.md): private alpha
  release gate and evidence to capture.
- [design/DESIGN.md](design/DESIGN.md): UI direction.
- [design/DESIGN_LANGUAGE.md](design/DESIGN_LANGUAGE.md): visual tokens and
  design rules.

## Common Commands

Start everything locally:

```bash
npm run dev:stack
```

Run the normal local gate:

```bash
npm run check
```

Run focused checks:

```bash
npm run test:api
npm run test:contracts
npm run test:rust
npm run test:e2e
```

Run live-Docker tests on a Docker-capable host:

```bash
npm run test:live-docker
```

## Deep References

- [planning/MARKET_RESEARCH.md](planning/MARKET_RESEARCH.md): why DockerMap is
  focused on local-first runtime and persistence mapping.
- [records/README.md](records/README.md): machine-oriented build and audit
  records.
- [release/DOC_CONTROL.md](release/DOC_CONTROL.md): documentation control
  rules.
- `docs/screenshots/`: screenshots used by the README and design docs.
