# DockerMap Roadmap

DockerMap's direction is intentionally narrow: help someone understand one
self-hosted machine before they touch it.

The product should answer four questions:

1. What is running here?
2. What depends on what?
3. Where do ports, paths, volumes, logs, and config files connect?
4. What would change if I edited a Compose mount or routing rule?

DockerMap is read-only today. Safe write mode belongs later, after validation,
diff preview, backups, confirmation, audit logging, and rollback behavior are
implemented.

## Current Status

Working:

- React/Vite web app on `3233`.
- Express API on `4000`.
- Rust daemon on `4100`.
- Docker inventory for containers, images, networks, volumes, mounts, and logs.
- Compose scan, graph, and dry-run edit-plan endpoints.
- Runtime map for Docker plus optional host signals such as systemd, cron, PM2,
  tmux, listening sockets, Tailscale, Headscale, reverse-proxy markers, local
  DNS markers, Python applications, and native processes.
- Shared Rust and TypeScript contract fixtures, including an OpenAPI route
  document (`/api/openapi.json`).
- API security tests, Rust tests, TypeScript checks, Playwright smoke tests,
  and a live-Docker GUI fixture suite.
- Evidence-backed live-state vocabulary across the UI (#61 epic): every claim
  carries an observed/derived/inferred/demo/unavailable kind, with exact
  mode/provenance authority gating.
- Live-Docker test evidence has been recorded for the current release track.

Not finished:

- Richer metadata for systemd and npm/package providers.
- Safe write mode.
- The filed roadmap epics below.

## Guiding Rules

- Read first, edit later.
- Prefer explicit evidence over guesses.
- Use structured parsers, not string edits.
- Keep provider commands fixed and read-only.
- Keep filesystem discovery bounded.
- Redact secrets before data reaches API responses, fixtures, logs, screenshots,
  or docs.
- Keep the daemon private by default.
- Make every insight available through API contracts, not only the UI.

## Now: Roadmap Epics #61-#70

The active roadmap is filed as GitHub issues #61-#70 (each `epic`+`enhancement`),
sequenced in each epic body. They are the source of truth for what comes next;
this document stays a summary, not a second roadmap.

- **#61 Evidence-backed live state** — implemented through child issues #71-#76;
  the remaining #77 documentation reconciliation is this roadmap update.
  Closure evidence is posted; maintainer closure remains pending.
- **#62 Docker authority isolation** — implemented and deployed: only the Docker
  Read Gateway holds the raw socket. Closure evidence is posted; maintainer
  closure remains pending.
- **#63 v0.1 alpha certification** — `v0.1.0-alpha.1` is a published prerelease.
  #15 live-Docker and #16 reverse-proxy boundary evidence are recorded. Clean-host
  installation and host-reboot recovery remain the open alpha evidence.
- **#64 Backend decomposition** — split the daemon's monolithic `main.rs`.
- **#65 Canonical contract/schema authority** — generate contracts from Rust
  or add a CI drift check.
- **#66 Provider scheduler/freshness**.
- **#67 Hearth Design System** — source-boundary audit is complete; product UI
  adoption remains planned work.
- **#68 Evidence provenance**.
- **#69 Deterministic Findings**.
- **#70 Change history/telemetry**.

## Next: Read-Only Product Completion

These items improve the product without changing host state.

### Compose And Diagnostics

- [x] Add cursor-based log pagination to daemon and API routes.
  Daemon and API accept `cursor` + `limit`; Docker path streams real
  timestamps and pages strictly older entries; mock path matches.
- [x] Add Compose validation rules for missing host paths, duplicate mount targets,
  unresolved variables, path traversal, and unsafe source values.
  Missing host paths, duplicate targets, unresolved variables, and parent
  traversal were already covered; unsafe bind sources (Docker socket, daemon
  state, credential directories, sensitive system roots) were added with
  `compose_unsafe_bind_source` diagnostics.
- [x] Add a diagnostics page and JSON export once validation routes exist.
  Shipped with commit `f2d631b` (diagnostics page + JSON export).
- Keep edit plans dry-run only with `willWrite: false`.

### Runtime Providers

- Enrich systemd provider output with restart policy, uptime, and dependency
  evidence where safe.
- Enrich npm provider output with scripts, framework hints, dependency nodes,
  and bounded package metadata.
- [x] Implement Python and native-process providers from the documented read-only plan in
  [`PYTHON_AND_PROCESS_PROVIDERS.md`](PYTHON_AND_PROCESS_PROVIDERS.md).
  Shipped via #32/#38/#39 + #33.
- Add parser-level fixtures for systemd, cron, PM2, tmux, Tailscale, Headscale,
  reverse proxy, DNS, and listener output.

### UI And Navigation

- [x] Add sorting and filters to list pages.
  Shipped with commit `16c8b80` (list sorting/filters on Images, Runtime, and Storage).
- [x] Make graph nodes and chips route to the relevant detail pages.
  Shipped with commit `16c8b80` (runtime node detail routing).
- [x] Improve container, network, volume, and image detail pages.
  Shipped via #34 (detail pages, merged `b62436b`).
- [x] Add log level filtering, message search, live-tail controls, and pagination.
  Shipped with commit `8321b0c` (Logs screen level filter, search, live tail, load-older).
- [x] Improve responsive and accessibility coverage for the primary pages.
  Shipped via #35 (responsive/a11y, merged `e4a4f63`).

### API And Integrations

- [x] Add versioned API routes while keeping current aliases.
  Shipped with commit `5fcadd3` (`/api/v1/*` alias surface).
- [x] Add OpenAPI or equivalent machine-readable route documentation.
  Shipped with commit `5fcadd3` (`/api/openapi.json`).
- [x] Add a small status/widget endpoint for external dashboards such as Homepage
  or Grafana-style panels.
  Shipped with commit `5fcadd3` (`/api/status`).

## Later: Safe Write Mode

Write mode is intentionally not part of the current product surface.

Before DockerMap can write Compose files or change runtime state, it needs:

- A validation engine with blocking diagnostics.
- YAML round-trip handling that preserves file structure.
- Dry-run diff preview.
- Explicit feature flag.
- API token protection.
- Human confirmation.
- Backup file creation.
- Audit logging.
- Rollback instructions.
- Tests proving no write occurs before confirmation.

Only after that should DockerMap add Compose apply routes or UI controls that
change files.

## Later: Runtime Enrichment

Potential later work:

- Container CPU and memory metrics.
- Compose/runtime drift reports.
- Reverse-proxy route pages.
- Tailscale and Headscale peer pages.
- Cross-technology chains such as:
  `Cloudflare -> Caddy -> Docker network -> container -> database -> volume`.
- Packaged CLI and versioned release artifacts.

## Reference Docs

- [../README.md](../README.md): docs wiki and navigation.
- [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md): older detailed file-level
  task breakdown for developers and agents.
- [MARKET_RESEARCH.md](MARKET_RESEARCH.md): demand signals and product
  positioning.
- [../release/RELEASE_CHECKLIST.md](../release/RELEASE_CHECKLIST.md): release
  gate and evidence.
- [../testing/TESTING_PLAN.md](../testing/TESTING_PLAN.md): local and CI checks.
- [../security/THREAT_MODEL.md](../security/THREAT_MODEL.md): safety model.
