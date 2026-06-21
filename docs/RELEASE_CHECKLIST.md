# DockerMap Release Checklist

This checklist is the release gate for the first private review release. DockerMap is
still read-first, so release readiness is judged by whether it can inspect a host without
changing files, containers, services, or Docker state.

## Minimum Tasks For First Private Release

These tasks must be complete before tagging `v0.1.0-alpha`.

- [x] Normalize local check commands in `package.json`.
- [x] Run JavaScript typecheck, build, and workspace tests from CI.
- [x] Run Rust format, lint, and full workspace tests from CI.
- [x] Add API security tests for bearer auth, CORS, query limits, startup config, and error detail exposure.
- [x] Add fixture-driven Compose validation tests for malformed files and blocked edit plans.
- [x] Add non-live Playwright smoke coverage for the primary GUI pages.
- [x] Add Playwright smoke coverage to CI.
- [x] Run `npm run test:live-docker` on a Docker-capable Linux host and record the result.
- [ ] Run `npm run build:deploy` on the release target or a clean Linux build host.
- [ ] Deploy behind the documented reverse proxy with viewer authentication enabled.
- [ ] Run `scripts/smoke-deploy.sh` against `http://127.0.0.1:4000` on the host.
- [ ] Run `scripts/smoke-deploy.sh` against the public review URL through the reverse proxy.
- [ ] Confirm direct remote access to `127.0.0.1:4100` is impossible from another machine.
- [ ] Confirm `/api/snapshot` returns `401` without a bearer token when bypassing the proxy.
- [ ] Confirm `/api/health`, `/api/snapshot`, `/api/runtime/map`, `/api/compose/scan`, and `/api/events/stream` work through the proxy.
- [ ] Update `README.md`, `docs/DEPLOYMENT.md`, `docs/REVERSE_PROXY.md`, `docs/TESTING_PLAN.md`, and `docs/THREAT_MODEL.md` for any release-time behavior changes.
- [ ] Create release notes with known limitations and the exact commit SHA.

## Second Round Before Wider Beta

These tasks are not required for the first private review release, but should be closed
before a broader beta.

- [ ] Generate TypeScript API contracts from Rust models or add a CI drift check that fails when fixtures and types diverge.
- [ ] Add reverse-proxy integration tests for bearer-token injection and SSE streaming.
- [ ] Add OpenAPI or equivalent machine-readable route documentation for read-only endpoints.
- [ ] Split `crates/dockermap-daemon/src/main.rs` into route, config, Docker collector, host-provider, and CLI modules.
- [ ] Add parser-level tests for systemd, cron, PM2, tmux, Tailscale, Headscale, reverse-proxy, DNS, and listener provider output fixtures.
- [ ] Add browser tests for error states, token/proxy behavior, logs filtering, Compose edit-plan display, and responsive navigation.
- [ ] Add a clean-host install test for systemd units and Nginx/Caddy proxy config.
- [ ] Add release automation for tagged builds and checksums.
- [ ] Add a documented support policy for Linux distro, Node, Rust, Docker, and browser versions.
- [ ] Add write-mode design gates before any endpoint can mutate files or Docker state.

## Release Evidence To Capture

Store this evidence in release notes or the release PR.

- Commit SHA.
- `npm run check` result.
- `npm run test:e2e` result.
- `npm run test:live-docker` result, including Docker and Compose versions.
- `npm run build:deploy` result.
- Host OS and kernel.
- Node, npm, Rust, Cargo, Docker, and browser versions.
- Reverse-proxy smoke result.
- Known limitations and skipped tests.
