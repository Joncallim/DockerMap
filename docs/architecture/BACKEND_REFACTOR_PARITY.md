# Backend Refactor Parity Baseline

This record is the no-behavior-change baseline for epic #64. Refactor slices
must preserve these externally observable contracts unless a separate issue
explicitly changes them.

## Baseline

- Source commit: `d2fca150e1dafa7189a80d53fc9c7761b4193fe3`
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

## Initial concentration map

At this baseline, `crates/dockermap-daemon/src/main.rs` contains bootstrap,
daemon auth/routes/cache, Docker collection, Compose handling, provider
execution/parsers, publication, CLI, and tests. `crates/dockermap-core/src/lib.rs`
contains models, Compose, graphs, logs, and fixtures. `apps/api/src/index.ts`
contains configuration, auth/session, daemon client, mock responses, handlers,
SSE, and server startup; its route manifest and publication boundary are
already separate modules.

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

The PID namespace slice also corrected a discovered security defect rather
than silently preserving it: `auto` and invalid namespace configuration are
restricted, and only the documented explicit `host` mode enables full-host
providers. This is a security tightening, not a response or provider contract
change.

The ledger is cumulative: later #64 slices must add their boundary and
focused evidence here before the epic's final parity certification.

The intended extraction order is config/auth/publication and daemon transport;
then Docker/Compose; then individual providers; then core domains and API
handlers. This order keeps authority-sensitive seams reviewable first without
introducing a plugin system or behavior change.
