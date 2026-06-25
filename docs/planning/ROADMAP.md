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
  tmux, listening sockets, Tailscale, Headscale, reverse-proxy markers, and
  local DNS markers.
- Shared Rust and TypeScript contract fixtures.
- API security tests, Rust tests, TypeScript checks, and Playwright smoke tests.
- Live-Docker test evidence has been recorded for the current release track.

Not finished:

- Richer metadata for systemd and npm/package providers.
- Python and native-process provider implementation.
- List sorting, advanced filters, clickable graph nodes, and richer logs UI.
- OpenAPI docs, route versioning, and dashboard/widget endpoints.
- Safe write mode.

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

## Now: Private Alpha Hardening

This is the active priority.

1. Add provider redaction fixtures.

   Cover systemd, tmux, npm/package metadata, native-process inspection,
   reverse-proxy config, DNS config, and any external API/provider output that
   could contain secrets.

2. Document package and advisory network behavior.

   Any registry, advisory, or external-network lookup must be disabled by
   default, opt-in, or explicitly documented in release notes and deployment
   docs.

3. Capture release-host evidence.

   Keep the release checklist current with `npm run check`, `npm run
   build:deploy`, `npm run test:e2e`, `npm run test:live-docker`,
   reverse-proxy smoke checks, API token behavior, daemon-port inaccessibility,
   and exact commit SHA.

4. Keep read-only API security tight.

   Continue covering bearer auth, CORS, daemon URL restrictions, query limits,
   read-only verb enforcement, fallback behavior, and hidden daemon error
   details.

## Next: Read-Only Product Completion

These items improve the product without changing host state.

### Compose And Diagnostics

- Add cursor-based log pagination to daemon and API routes.
- Add Compose validation rules for missing host paths, duplicate mount targets,
  unresolved variables, path traversal, and unsafe source values.
- Add a diagnostics page and JSON export once validation routes exist.
- Keep edit plans dry-run only with `willWrite: false`.

### Runtime Providers

- Enrich systemd provider output with restart policy, uptime, and dependency
  evidence where safe.
- Enrich npm provider output with scripts, framework hints, dependency nodes,
  and bounded package metadata.
- Implement Python and native-process providers from the documented read-only plan in
  [`PYTHON_AND_PROCESS_PROVIDERS.md`](PYTHON_AND_PROCESS_PROVIDERS.md).
- Add parser-level fixtures for systemd, cron, PM2, tmux, Tailscale, Headscale,
  reverse proxy, DNS, and listener output.

### UI And Navigation

- Add sorting and filters to list pages.
- Make graph nodes and chips route to the relevant detail pages.
- Improve container, network, volume, and image detail pages.
- Add log level filtering, message search, live-tail controls, and pagination.
- Improve responsive and accessibility coverage for the primary pages.

### API And Integrations

- Add versioned API routes while keeping current aliases.
- Add OpenAPI or equivalent machine-readable route documentation.
- Add a small status/widget endpoint for external dashboards such as Homepage
  or Grafana-style panels.

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
