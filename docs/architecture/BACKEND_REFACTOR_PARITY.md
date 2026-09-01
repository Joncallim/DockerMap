# Backend Refactor Parity Baseline

This record is the no-behavior-change baseline for epic #64. Refactor slices
must preserve these externally observable contracts unless a separate issue
explicitly changes them.

## Baseline

- Original baseline: `d2fca150e1dafa7189a80d53fc9c7761b4193fe3`
- Current ledger commit: `5aec7bc69f9fc5b12c88475e991c448fdaf30acf`
- Canonical checks: `npm run check`, `npm run test:e2e`,
  `npm run test:live-docker`, `npm run build:deploy`, and production-image E2E.
- Route/contract authority: `apps/api/src/routes.ts` and the shared contract
  fixtures. Route-registration completeness is a tested invariant.
- Publication and redaction boundaries: `apps/api/src/publication.ts` and the
  daemon's publication helpers. Refactors must not move raw provider data past
  either boundary.

## Current authority and dependency direction

```text
browser -> nginx + Node API -> token-protected Rust daemon -> filtered Docker gateway
                                  |                         -> bounded host providers
                                  -> shared contracts/web payloads
```

- The Node API is the only browser-facing server and its manifest is the sole
  browser-route declaration. It owns browser auth/session handling, CORS,
  browser rate limits, daemon proxying, mock fallback policy, SSE, and OpenAPI.
- The daemon owns Docker collection, Compose inspection, fixed provider commands,
  cache refresh, CLI output, and daemon-route auth. It defaults to loopback;
  a non-loopback bind requires both explicit opt-in and a non-empty token.
- The daemon uses only the filtered Docker gateway socket. The collector must
  never recover by using a raw Docker socket.
- `dockermap-core` owns public models, Compose logic, graph derivation, mock
  fixtures, and log pagination. API and daemon may depend on core; core must
  not depend on either server.

Within the daemon, dependencies flow inward from the entrypoint to focused
boundaries, then to `dockermap-core` and fixed system/Docker interfaces:

```text
main.rs (bootstrap and CLI dispatch)
  -> auth / config / docker_config / pid_namespace
  -> cache_refresh / daemon_api / docker_collector / runtime_collection / compose_api
       -> provider_contract
       -> providers/* / process_runner
       -> publication
       -> dockermap-core
```

`publication` is a terminal publishing boundary: collectors and request
handlers call it before data becomes a public response, but it does not call
providers, routes, or Docker. `runtime_collection`
coordinates provider order and bounded execution; individual provider modules
own their fixed commands, parsers, and provider-specific bounds. `main.rs`
owns server bootstrap and CLI dispatch. `cache_refresh` owns daemon cache
lifecycle, filtered Docker-collector reuse, mock fallback, and periodic
snapshot/runtime refresh; its gateway client is invalidated after a Docker
interaction failure without attempting a direct-socket alternative.
`daemon_api` owns Axum router construction, cached read publication routes,
and bounded log-query parsing, while delegating Compose request handling to
`compose_api`. This is the current module map, not a claim that the entrypoint
has been fully decomposed.

`provider_contract` is an internal, short-lived collection boundary, not a
plugin API. It owns the accumulated provider nodes, edges, and diagnostics for
one runtime refresh. Only `runtime_collection` converts those observations to
a public `RuntimeMap`; diagnostic insertion goes through the existing
redaction-before-storage publication helper. Providers remain statically
linked, fixed read-only collectors and do not acquire route, cache, or
publication authority.

## Route parity

The daemon exposes thirteen `GET` routes below `/daemon/`, all behind its
bearer middleware when a token is configured: health, snapshot, graph,
runtime map, containers (list/detail), images, networks, volumes, logs, and
Compose scan/graph/edit-plan. Its fallback remains a sanitized `404`.

The browser API manifest has twenty-two entries. It includes current and
`/api/v1` aliases for read routes, two public-in-bearer session-login aliases,
authenticated logout aliases, and the version descriptor. Refactor work must
keep the manifest/registration bidirectional-completeness test passing; it
must not add an untracked response-capable Express layer.

## Configuration parity

The documented environment contract in `docs/deployment/DOCKER.md` is public
behavior. In particular, preserve:

- token precedence (`DOCKERMAP_DAEMON_TOKEN`, then API token fallback);
- empty configured tokens failing closed at startup;
- loopback daemon default and remote opt-in + token requirement;
- explicit gateway socket and label-filter validation;
- bounded project-root canonicalization;
- mock mode being explicitly source-stamped rather than Docker evidence.

## Module extraction rules

1. Move a coherent boundary with its focused tests; do not change defaults,
   response shape, source stamps, error text, or provider command behavior.
2. Keep security boundaries dependency-light: config/auth/publication code must
   not import providers, routing registration, or Docker collection.
3. Preserve black-box tests while adding focused module tests. A focused test is
   not a replacement for route, browser, Docker-gateway, or production-image
   coverage.
4. Each slice records moved responsibilities and runs the narrowest relevant
   tests before the full CI gate.

## Refactor progress map

At the original baseline, `crates/dockermap-daemon/src/main.rs` contained
bootstrap, daemon auth/routes/cache, Docker collection, Compose handling,
provider execution/parsers, publication, CLI, and tests. Through merged PR
#142, Docker collection, Compose request handling, runtime orchestration,
publication, daemon read HTTP handling, cache refresh, and every then-existing
host provider have moved to named daemon modules. The entrypoint retains
bootstrap, CLI dispatch, and tests; cache refresh remains an
authority-sensitive boundary described above.

`crates/dockermap-core/src/lib.rs` re-exports models, Compose operations,
snapshot/runtime derivations, graphs, logs, and fixtures from focused modules.
`apps/api/src/index.ts` owns the browser-facing server flow (configuration,
auth/session, daemon client, mock responses, SSE, startup, and explicit route
registration). Its daemon-backed read responders, bounded query builders,
version descriptor, OpenAPI document, and status classification live in
`readHandlers`; its route manifest and publication boundary remain separate
modules.

PR #175 completed the provider-collection extraction without changing the
browser route manifest, daemon route set, provider order, PID-namespace
suppression, source stamps, or publication path. It moved the mutable
per-refresh provider vectors behind `provider_contract`, moved shared provider
classification helpers to `providers`, and moved character-bounded display
truncation to `publication`. This is behavior parity, not a new provider
extension point.

## Completed extraction ledger

| Boundary | Module | Focused evidence |
| --- | --- | --- |
| Daemon startup configuration | `crates/dockermap-daemon/src/config.rs` | daemon config tests + Rust gate |
| Daemon bearer boundary | `crates/dockermap-daemon/src/auth.rs` | router-level 401/exact-token regression |
| Docker collector configuration | `crates/dockermap-daemon/src/docker_config.rs` | raw-socket rejection + label tests |
| PID namespace boundary | `crates/dockermap-daemon/src/pid_namespace.rs` | fail-closed ambiguity and unreadable-cgroup regressions |
| Browser API configuration | `apps/api/src/config.ts` | startup-security suite |
| Browser API daemon client | `apps/api/src/daemonClient.ts` | daemon-token, 401 no-fallback, and timeout regressions |
| Core log utilities | `crates/dockermap-core/src/logs.rs` | core pagination, cursor, timestamp, and stable-fixture tests |
| Core topology identity | `crates/dockermap-core/src/identity.rs` | collision-resistant runtime/Compose identity regression |
| Provider command execution | `crates/dockermap-daemon/src/process_runner.rs` | timeout, descendant cleanup, null-stdin, and bounded-output regressions |
| Core public domain models | `crates/dockermap-core/src/models.rs` | core serialization, contract, and crate-root re-export tests |
| Docker inventory and bounded logs | `crates/dockermap-daemon/src/docker_collector.rs` | Docker collector unit tests, gateway/config regressions, and live-Docker coverage |
| systemd provider | `crates/dockermap-daemon/src/providers/systemd.rs` | fixed-command parsing and provider diagnostic regressions |
| overlay-network providers | `crates/dockermap-daemon/src/providers/overlay_network.rs` | bounded provider parsing and diagnostic regressions |
| cron provider | `crates/dockermap-daemon/src/providers/cron.rs` | bounded cron discovery, malformed input, and diagnostic regressions |
| PM2 provider | `crates/dockermap-daemon/src/providers/pm2.rs` | fixed-command parsing and provider diagnostic regressions |
| tmux provider | `crates/dockermap-daemon/src/providers/tmux.rs` | fixed-command parsing and provider diagnostic regressions |
| network listener provider | `crates/dockermap-daemon/src/providers/listeners.rs` | listener parsing and provider diagnostic regressions |
| network infrastructure provider | `crates/dockermap-daemon/src/providers/network_infrastructure.rs` | bounded infrastructure collection, correlation, and diagnostic regressions |
| Python and native process providers | `crates/dockermap-daemon/src/providers/processes.rs` | process parsing, caps, PID-namespace suppression, and diagnostic regressions |
| npm project provider | `crates/dockermap-daemon/src/providers/npm.rs` | bounded project discovery, manifest no-follow/openat, FIFO, and redaction regressions |
| Daemon publication and normalization | `crates/dockermap-daemon/src/publication.rs` | redaction, Unicode/collision, stable-order, and public-model regressions |
| Compose HTTP/CLI request boundary | `crates/dockermap-daemon/src/compose_api.rs` | root confinement, symlink denial, request validation, and dry-run regressions |
| Runtime-map collection orchestration | `crates/dockermap-daemon/src/runtime_collection.rs` | PID-restricted omissions, single-flight/timeout fallback, provider-order, and runtime-redaction regressions |
| Core Docker snapshot/runtime derivation | `crates/dockermap-core/src/snapshot_runtime.rs` | core derivation tests plus daemon runtime-map coverage |
| Daemon cached read HTTP boundary | `crates/dockermap-daemon/src/daemon_api.rs` | daemon route, bearer, bounded log-query, source-stamp, and sanitized-404 regressions |
| Browser API daemon-backed read handlers | `apps/api/src/readHandlers.ts` | focused query/status tests plus API route-manifest coverage |
| Core Compose operations | `crates/dockermap-core/src/compose.rs` | core Compose fixture and dry-run tests plus daemon Compose coverage |
| Daemon cache refresh and gateway-client lifecycle | `crates/dockermap-daemon/src/cache_refresh.rs` | daemon cache-refresh, mock-fallback, gateway-invalidation, and runtime-refresh regressions |
| Core deterministic mock fixtures | `crates/dockermap-core/src/fixtures.rs` | core sample snapshot/log shape, stable mock-log cursor, and crate-root re-export tests |
| Internal runtime-provider collection | `crates/dockermap-daemon/src/provider_contract.rs` | provider diagnostic redaction regression, restricted-PID omission regression, daemon route/runtime-map coverage, and production-image E2E |

The PID namespace slice also corrected a discovered security defect rather
than silently preserving it: `auto` and invalid namespace configuration are
restricted, and only the documented explicit `host` mode enables full-host
providers. This is a security tightening, not a response or provider contract
change.

The ledger is cumulative: later #64 slices must add their boundary and
focused evidence here before the epic's final parity certification.

Completed work followed the authority-sensitive sequence: configuration and
auth; core domains and process execution; Docker collection; individual
providers; publication; Compose request handling; runtime orchestration; core
snapshot/runtime derivation; daemon HTTP reads; browser API reads; and core
Compose operations; daemon cache refresh; and core deterministic fixtures.
Future #64 slices must update this record from the merged code rather than
assuming the original extraction order remains a plan. The refactor remains a
module-boundary effort: it must not introduce a plugin system or silently
change behavior.

## Representative parity evidence at the current ledger commit

- Contract fixtures remain Rust-owned and schema-validated in both runtimes:
  snapshot, graph, runtime-map, diagnostics, Compose scan/graph, health, and
  status fixtures are checked by `packages/contracts` against committed
  generated schemas. The negative fixture regressions reject undeclared
  response fields, invalid timestamps/integers, and invalid source stamps.
- The browser route manifest remains the only declaration for browser-facing
  routes. API tests prove OpenAPI operations and registered response-capable
  Express layers are bidirectionally complete with that manifest, including
  aliases and auth/rate-limit policy.
- The new provider collection has a direct regression proving a secret-like
  provider diagnostic is redacted before its collection can expose it. The
  runtime collection regressions continue to prove restricted PID namespaces
  omit host-scoped collectors while reporting diagnostics, rather than
  relabelling container-local observations as host evidence.
- The public authority direction is unchanged: browser responses pass through
  the Node API publication boundary; daemon runtime output is derived after
  collection and then redacted by `publication`; the collector still reaches
  Docker only through the filtered gateway.

## Validation record

The current ledger commit is `5aec7bc69f9fc5b12c88475e991c448fdaf30acf`.
The final implementation ancestors, PR #175
(`34861861b583dd667a465e090979179c33c0f0a4`) and PR #176
(`801669f`), each completed their GitHub Actions matrix successfully. The
matrix executed the following commands with success: `npm run check:version`,
`npm audit --omit=dev`, `npm run check:contracts`, `npm run typecheck`,
`npm run build`, `npm run test:version`, `npm run test:js`, `cargo fmt
--manifest-path crates/Cargo.toml --all -- --check`, `cargo clippy
--manifest-path crates/Cargo.toml --all-targets -- -D warnings`, `cargo test
--manifest-path crates/Cargo.toml`, `npm run test:e2e`, `npm run build:deploy`,
and the production-image browser and Docker-image smoke commands defined in
`.github/workflows/ci.yml`. The current commit additionally has a local
focused daemon verification:

- `npm run test:rust:daemon` — 125 passed, 0 failed.

The canonical final parity gate remains `npm run check`, `npm run test:e2e`,
`npm run test:live-docker`, and `npm run build:deploy`. This ledger records
what was verified for the merged refactor; it does not claim a fresh live-host
or deployment certification from a docs-only update.
