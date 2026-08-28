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
- [x] Keep provider commands fixed and read-only for systemd, tmux, package, Python/native-process, reverse-proxy, DNS, and external-API collectors.
  Python/native-process collectors shipped via #32/#38/#39 + #33; provider commands
  remain fixed read-only invocations (see `docs/security/THREAT_MODEL.md`).
- [x] Bound provider filesystem scanning to documented paths, explicit request targets, and hard caps.
- [x] Make package advisory, registry, or other external-network behavior opt-in or document it explicitly in release notes and deployment docs.
  Current runtime docs state that package registry/advisory, DNS-provider API,
  Cloudflare API, and generic external-API lookups are disabled or not implemented.
  Tailscale/Headscale delegated CLI behavior and Google-hosted browser fonts are
  documented as release decisions.
- [x] Verify package, service, process, unit, proxy, and DNS inspection does not leak env vars, secrets, credentials, or inline auth URLs.
  Fixture evidence (`npm run test:rust:daemon`) covers current provider outputs
  including Python/native-process-shaped sentinels; config-content collectors
  (reverse-proxy/DNS raw config parsing) remain future work.
- [x] Keep provider security checks runnable without GUI availability or host-specific daemons beyond the test fixture or stub daemon.
- [x] Run `npm run test:live-docker` on a Docker-capable Linux host and record the result.
  Recorded on Hearth for DockerMap `fb30b374d86102f8420a1815ba0c30b0b1e4c012`;
  the labelled fixture now runs through the filtered Docker Read Gateway and
  uses inspected, distinct IPAM subnets. Host/tool versions are in
  [the alpha baseline](ALPHA_BASELINE.md).
- [x] Run `npm run build:deploy` on the release target or a clean Linux build host.
  Recorded on Hearth for the authority-isolated deployment baseline; see
  [the alpha baseline](ALPHA_BASELINE.md).
- [x] Deploy behind the documented reverse proxy with viewer authentication enabled.
  Live `dockermap.jo-nas.com` runs behind Caddy + Authentik forward-auth; public
  unauthenticated requests 302 to Authentik.
- [ ] Run `scripts/smoke-deploy.sh` against `http://127.0.0.1:4000` on the host.
  (Local-loopback smoke not yet recorded this release track.)
- [ ] Run `scripts/smoke-deploy.sh` against the public review URL through the reverse proxy.
  Not yet run as the script this track; equivalent live checks were recorded on the
  deployed build (public 302 to Authentik, daemon 401 unauthenticated, snapshot serves
  with trusted header, web 200) — running the script itself remains open evidence.
- [ ] Confirm direct remote access to `127.0.0.1:4100` is impossible from another machine.
  (Daemon binds loopback; external-port confirmation not yet recorded this track.)
- [ ] Confirm `/api/snapshot` returns `401` without a bearer token when bypassing the proxy.
  Re-opened 2026-08-27: the prior check verified the DAEMON endpoint's
  bearer gate, which is a different auth contract than the Node API's. In
  forward-auth mode the Node `/api/snapshot` requires the trusted identity
  header; the daemon `/daemon/snapshot` requires its daemon bearer token.
  Record evidence against EACH endpoint separately: (a) Node API
  `/api/snapshot` without the trusted identity header → 401/403, and (b)
  daemon `/daemon/snapshot` without the daemon bearer token → 401.
- [ ] Confirm `/api/health`, `/api/snapshot`, `/api/runtime/map`, `/api/compose/scan`, and `/api/events/stream` work through the proxy.
  (Snapshot/health verified; full route matrix through Authentik not yet recorded.)
- [ ] Update `README.md`, `docs/deployment/DEPLOYMENT.md`, `docs/deployment/REVERSE_PROXY.md`, `docs/testing/TESTING_PLAN.md`, and `docs/security/THREAT_MODEL.md` for any release-time behavior changes.
- [ ] Create release notes with known limitations and the exact commit SHA.
  The non-tagging baseline and known limitations are recorded in
  [ALPHA_BASELINE.md](ALPHA_BASELINE.md). Final release notes must be refreshed
  for the exact tagged candidate after the remaining #16/#63 proxy gate.

## Execute After Next Commit

## Docker authority isolation (#62)

- [x] Docker-only deployment keeps the raw Docker socket exclusively in the
  Docker Read Gateway. The frontend and collector receive neither that socket
  nor a direct Docker endpoint; the collector uses only the filtered Unix
  socket.
- [x] The gateway's fixed read allowlist, bounded log query contract, and
  conditional label-filter contract are recorded in
  [`DOCKER_AUTHORITY_BOUNDARY.md`](../architecture/DOCKER_AUTHORITY_BOUNDARY.md)
  and covered by deny-before-upstream tests.
- [x] Hearth's DockerMap-only rollout records non-root identities, dropped
  capabilities, read-only filesystems, mount and network separation, source
  coherence, gateway denial, and service restart recovery in #62 resolution
  evidence. Interactive Authentik browser certification remains #16/#63 and
  is not evidence for this authority boundary.

After the next implementation commit is completed, open follow-up work items for these
tasks before starting new GUI work:

- [x] Add provider-specific redaction fixtures for systemd, tmux, npm/package metadata,
  native process inspection, reverse-proxy config, and DNS collectors.
  Current coverage is systemd, tmux, npm/package, native-process-shaped output,
  reverse-proxy marker, and DNS marker fixture coverage. Native process, reverse-proxy
  config-content, and DNS config-content collectors remain future implementation work.
- [x] Decide and document package advisory, registry, or other external-network behavior:
  keep it disabled/opt-in by default, and record the operator-facing setting in release
  notes and deployment docs.
  Documented current behavior: no runtime package registry/advisory/external-API lookup,
  build/release tooling may contact registries, Tailscale/Headscale use installed CLI
  configuration, and the browser loads Google-hosted fonts unless packaged locally.
- [ ] Capture live-Docker evidence on the release host with `npm run test:live-docker`,
  including Docker and Compose versions.
- [ ] Capture reverse-proxy smoke evidence on the release host, including bearer-token
  injection, SSE streaming, public review URL access, and direct daemon-port
  inaccessibility.
- [x] Plan Python and native-process providers as the next backend provider peers after
  the current Rust runtime model and contracts settle.
  The planning doc is `docs/planning/PYTHON_AND_PROCESS_PROVIDERS.md`. Both providers
  are implemented (#32/#38/#39 + #33); remaining enrichment is tracked in the roadmap.

## Second Round Before Wider Beta

These tasks are not required for the first private review release, but should be closed
before a broader beta.

- [ ] Generate TypeScript API contracts from Rust models or add a CI drift check that fails when fixtures and types diverge.
  Tracked as epic #65 (canonical contract/schema authority).
- [ ] Add reverse-proxy integration tests for bearer-token injection and SSE streaming.
  Tracked as part of epic #63 (v0.1 alpha certification).
- [x] Add OpenAPI or equivalent machine-readable route documentation for read-only endpoints.
  `/api/openapi.json` (OpenAPI 3.0.3) ships on the read-only API surface; see commit `5fcadd3`.
- [ ] Split `crates/dockermap-daemon/src/main.rs` into route, config, Docker collector, host-provider, and CLI modules.
  Tracked as epic #64 (backend decomposition).
- [ ] Add parser-level tests for systemd, cron, PM2, tmux, Tailscale, Headscale, reverse-proxy, DNS, and listener provider output fixtures.
  Tracked in the roadmap (Runtime Providers).
- [ ] Add provider-fixture redaction tests for npm/package metadata, Python apps, native processes, and service/unit inspection before enabling those routes by default.
  Python/native-process routes are enabled with redaction fixtures shipped; remaining
  config-content collector work is tracked in the roadmap.
- [ ] Add browser tests for error states, token/proxy behavior, logs filtering, Compose edit-plan display, and responsive navigation.
  Tracked as part of epic #63 (v0.1 alpha certification).
- [ ] Add a clean-host install test for systemd units and Nginx/Caddy proxy config.
- [ ] Add release automation for tagged builds and checksums.
- [ ] Add a documented support policy for Linux distro, Node, Rust, Docker, and browser versions.
- [ ] Add write-mode design gates before any endpoint can mutate files or Docker state.
  Design gates are documented in the roadmap (Safe Write Mode section).

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
- Provider-network behavior note stating whether any package/advisory or other external API calls were enabled.
  Current docs record no runtime package registry/advisory/external-API lookup; note the
  Tailscale/Headscale delegated CLI caveat and Google Fonts browser egress in release notes.
- Provider-redaction evidence for any new systemd, tmux, package, Python/native-process, reverse-proxy, DNS, or external-API routes shipped in the release.
  Current fixture evidence is `npm run test:rust:daemon`, covering fake systemd, tmux,
  npm/package, native-process-shaped, reverse-proxy marker, DNS marker, diagnostic, and
  edge-metadata secret sentinels without live host services.
- Known limitations and skipped tests.
