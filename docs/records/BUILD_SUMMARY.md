# DockerMap Backend And Runtime Map Build Summary

## Executive Summary

DockerMap has been advanced through the backend-focused roadmap phases and now has a
working React UI, a Node/Express browser-facing API, and a Rust core/daemon as the source
of truth.

This build adds secure read-only Compose scanning, path-map graph derivation,
machine-readable diagnostics, dry-run edit planning, bearer-token API auth, and a
provider-based runtime map. No endpoint writes Compose files or changes running services.

## Backend Capabilities Added

- Compose file discovery for standard filenames under `DOCKERMAP_PROJECT_ROOT`.
- Explicit Compose file scanning under the project root with parent traversal and symlink path rejection.
- Compose service and volume parsing for bind mounts, named volumes, anonymous volumes, long syntax, short syntax, read-only flags, dependency lists, and source file origins.
- Relative host path resolution against the Compose file directory.
- Typed diagnostics with `info`, `warning`, `error`, and `blocked` severities.
- Typed Compose path-map graph nodes and edges.
- Dry-run bind mount edit plans with unified diffs and `willWrite: false`.
- Daemon endpoints:
  - `GET /daemon/compose/scan`
  - `GET /daemon/compose/graph`
  - `GET /daemon/compose/edit-plan`
- API proxy endpoints:
  - `GET /api/compose/scan`
  - `GET /api/compose/graph`
  - `GET /api/compose/edit-plan`
- Headless daemon subcommands:
  - `scan`
  - `validate`
  - `export --format json`
- Runtime map providers:
  - Docker containers, networks, volumes, and listening ports
  - PM2 apps
  - systemd services
  - cron and `/etc/cron.d` jobs
  - tmux sessions
  - Tailscale and Headscale nodes
  - reverse-proxy markers
  - local DNS markers

## Security Hardening

- Installed `cargo-audit` and scanned `crates/Cargo.lock`.
- Added `helmet` to the Node API while disabling local HTTP HSTS.
- Disabled Express fingerprinting with `x-powered-by`.
- Added explicit CORS allowlisting.
- Bound the Node API to `127.0.0.1`.
- Kept the Rust daemon loopback-bound.
- Restricted daemon upstream URLs to loopback by default.
- Added bounded query, file count, file size, and log line limits.
- Hidden daemon error details unless `DOCKERMAP_EXPOSE_ERROR_DETAILS=true`.
- Added JSON 404 responses in both API and daemon layers.
- Avoided holding daemon cache locks across Docker log reads.
- Limited Docker log reads to containers present in the current snapshot.
- Rejected Compose scan paths that contain parent traversal or symlink components.

## Roadmap Progress Review

### Phase 0: Foundation And Baseline Hardening

Complete. The active CI workflow is published at `.github/workflows/ci.yml`.

### Phase 1: Read-Only Map

Implemented the backend read-only map foundation: Compose scan, diagnostics, typed graph,
explicit file scanning, runtime-map providers, and HTTP JSON export. Dedicated CLI
packaging remains future work.

### Phase 2: Validation And Safety

Implemented machine-readable validation output and tests for malformed/edge-case Compose inputs. Threat model coverage now lives in `docs/security/THREAT_MODEL.md`.

### Phase 3: Editing Workflow

Started and constrained to safe dry-run edit planning. The system generates diffs but does not write files. Backup, rollback, confirmation UI, and write-mode mechanics remain intentionally deferred.

### Phase 3.5: Local Deployment And Reverse Proxy Hardening

Added roadmap coverage and baseline app hardening. Deployment guidance lives in `docs/deployment/REVERSE_PROXY.md`.

## Verification

The final verification suite run for this build:

- `cargo fmt --manifest-path crates/Cargo.toml --all --check`
- `cargo clippy --manifest-path crates/Cargo.toml --all-targets -- -D warnings`
- `cargo test --manifest-path crates/Cargo.toml`
- `cargo audit --file crates/Cargo.lock`
- `npm run typecheck`
- `npm run build`
- `npm audit`
- `npm test`

Smoke-tested endpoints against `tests/fixtures/compose`:

- daemon Compose graph
- API Compose scan
- API Compose graph
- traversal rejection
- overlong query rejection
- JSON 404 behavior

## Remaining Work

- Add a dedicated CLI package or binary alias named `dockermap`; the daemon binary already supports `scan`, `validate`, and `export --format json`.
- Implement round-trip YAML editing before any write endpoint is introduced.
- Add a browser page or dashboard section dedicated to PM2, systemd, cron, tmux,
  Tailscale/Headscale, proxy, DNS, and port signals.
- Add runtime mount mode capture for read-only/write mismatch diagnostics.
- Add proxied path-prefix smoke tests before documenting production exposure as supported.
