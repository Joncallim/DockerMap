# DockerMap Testing Plan

DockerMap is still read-first, so the tests focus on one promise: a person should be
able to inspect Docker, Compose, and host runtime state without DockerMap changing files,
containers, or services.

## What The Automated Tests Cover

- TypeScript type checks for the web app, Node API, and shared contracts.
- Production builds for the TypeScript workspaces.
- Workspace-level JavaScript tests via `npm run test:js`.
- Rust formatting and linting.
- Rust unit tests for the core Docker and Compose model plus daemon helpers.
- Runtime-map contracts for Docker and non-Docker provider signals.
- Rust-owned JSON Schema and generated TypeScript declarations, Node-owned
  envelope/request/SSE schemas, and readable contract fixtures. The contract
  check fails on stale generated output, invalid fixtures, incomplete
  route/schema associations, or malformed declared requests.
- API security tests for bearer auth, CORS, daemon URL restrictions, query limits,
  mock fallback, read-only verb enforcement, fixed daemon route shaping, and error
  detail exposure.
- Observed Docker inventory-history tests for post-sanitization delta derivation,
  a daemon-lifetime 64-row newest-first bound, source reset, mock-empty behavior,
  opaque/closed response shapes, authenticated API routing, and live-model revision
  coherence in the browser.
- Observed Docker event-stream tests for fixed gateway traversal, closed raw
  event parsing, raw-data exclusion, opaque IDs, 64-row retention,
  4,096-item replay dedupe, bounded replay timestamps, reconnect backoff,
  source-generation cancellation/reset, authenticated route/schema validation,
  coherent browser rendering, and the exact three-`container_died`-within-five-
  minutes temporal advisory contract.
- Playwright smoke tests for the GUI through `npm run test:e2e`, with live-Docker
  coverage opt-in through `npm run test:live-docker`.

## Run The Local Check Suite

Run these before merging or pushing a change that touches code, contracts, or API shapes:

```bash
npm ci
npm run check
```

Use the narrower aliases while developing:

```bash
npm run check:js
npm run check:rust
npm run test:js
npm run test:api
npm run test:web
npm run test:contracts
npm run test:rust
npm run test:rust:core
npm run test:rust:daemon
```

`npm test` is an alias for `npm run test:js`. The contracts package has an active
compatibility test, and the web package runs a growing vitest suite covering the
model layer, evidence vocabulary, state normalization, and screen wiring. The API
package has black-box security tests that start the real Express entry point
with controlled environment variables.

If your shell finds an older system Cargo first, prefix Rust-backed npm scripts with:

```bash
PATH="$HOME/.cargo/bin:$PATH" npm run check:rust
```

## Security Test Suite

Run the API security tests directly when changing `apps/api`, auth behavior, CORS,
query validation, daemon URL handling, mock fallback, or error reporting:

```bash
npm run test:api
```

The API tests cover:

- `/api/health` requiring a bearer token whenever `DOCKERMAP_API_TOKEN` is set,
  like every other protected route (the current route manifest marks it
  authenticated).
- Rejection of missing and incorrect bearer tokens.
- Explicit-origin CORS behavior, public preflight handling, and rejected wildcard startup config.
- Loopback-only daemon URL enforcement unless remote access is explicitly enabled.
- Query limits for Compose scan, edit-plan, and logs routes.
- Read-only route behavior, including authenticated write-verb rejection.
- Fixed daemon proxy paths and normalized query encoding for logs, Compose scan, and
  container detail requests.
- Authenticated `/api/history` and `/api/v1/history` routing, including schema rejection
  for malformed or incoherent daemon history responses and mock fallback that is empty
  rather than a fabricated live timeline.
- `/api/observed-events` and `/api/v1/observed-events` bearer enforcement when
  configured, including rejection of malformed stream-history and
  temporal-finding evidence before it reaches the browser.
- Hidden daemon error details by default, with opt-in detail exposure for JSON and SSE routes.

These tests run against the real Express entry point with mock fallback or a stub daemon.
They do not require Docker, systemd, tmux, reverse-proxy software, DNS services, or a GUI.

The Python/native-process provider plan now lives in
[`docs/planning/PYTHON_AND_PROCESS_PROVIDERS.md`](../planning/PYTHON_AND_PROCESS_PROVIDERS.md).
Keep the post-commit follow-up queue in
[`docs/release/RELEASE_CHECKLIST.md`](../release/RELEASE_CHECKLIST.md) current for remaining
release-host evidence and for implementation, fixture, API, and docs evidence when new
providers land.

## Alpha Security Gates For Expanded Providers

When adding systemd, tmux, npm/package, Python/native-process, reverse-proxy, DNS, or
external-API collection, the alpha bar is:

- Provider commands are fixed read-only invocations with no user-supplied shell.
- Filesystem inspection is bounded to documented paths, request parameters, or explicit caps.
- Registry, advisory, or other network lookups are opt-in or called out in release docs.
- Returned metadata excludes or redacts secrets from env vars, unit files, process args,
  package auth config, service definitions, and proxy credentials.
- Security tests for the provider can run locally without depending on Docker, systemd,
  tmux, or browser automation.

For provider-network behavior evidence, verify source and docs rather than running
external services with real credentials:

```bash
rg -n "advisory|registry|external|network|Tailscale|Headscale|token|auth" docs crates apps packages
rg -n "fetch\\(|Command::new|npm audit|npm view|registry|advisory" apps crates packages docs -g '!**/package-lock.json' -g '!**/Cargo.lock'
```

Expected current result: DockerMap runtime has no package registry, package advisory,
DNS-provider API, Cloudflare API, generic external-API lookup, or hosted-font request.
Tailscale and Headscale
are fixed delegated CLI calls when installed, inherit the daemon environment, and may use
the operator's configured control plane. The API talks to a loopback daemon unless remote
daemon access is explicitly enabled.

The daemon unit suite includes fake-only provider redaction fixtures for systemd, tmux,
npm/package metadata, native-process-shaped command output, reverse-proxy markers, DNS
markers, provider diagnostics, and provider edge metadata. These fixtures deliberately use
`DOCKERMAP_TEST_FAKE_*` sentinels and assert the returned runtime/provider JSON omits those
raw values.

Python and native-process collectors are implemented (shipped via #32/#38/#39 + #33) with
fixture-first tests for fake `/proc` trees, optional fixed `ps` output, Python manifests,
skipped directories, cap diagnostics, and redaction sentinels. These tests prove that env
values, raw secret arguments, private package-index URLs, cwd paths outside the configured
project root, and manifest credentials are omitted or redacted, and cover process
disappearance, unreadable proc fields, too many processes, too many Python projects, too
many dependencies, and oversized manifests without requiring Docker, systemd, tmux, real
Python services, or external network access.

Run the provider redaction fixture checks with:

```bash
npm run test:rust:daemon
```

Run GUI smoke tests before release candidates:

```bash
npm run test:e2e
```

Run live-Docker tests only on a Docker-capable Linux host:

```bash
npm run test:live-docker
```

The live-Docker harness labels its Compose resources, sets
`DOCKERMAP_DOCKER_LABEL_FILTER`, and creates an unlabeled control container to prove
DockerMap excludes unrelated Docker resources.

## Temporal Docker Event Evidence

The automated evidence is deliberately isolated: fake streams, a filtered Unix
gateway stub, and contract/browser fixtures prove the closed policy and
fail-closed publication behavior without reading a host's Docker history.

PR #215 initially recorded live evidence for commit `db9514d`: the targeted
opt-in temporal sequence and the full opt-in live-Docker suite both passed
(**2/2**). Its current head, `aeb5e86`, additionally pauses only the isolated
filtered gateway and proves the response becomes `mock`/`unavailable` with
null revisions and an empty event list, then returns to
`docker`/`collecting` after gateway recovery. The labelled fixture also
restarts only its `worker` three times, restarts the filtered gateway, observes
exactly three new opaque `container_died` rows, produces exactly one advisory,
checks a raw/unsafe event request is denied by the filtered gateway, and
completes cleanup. This is isolated test evidence, not a general host-history
claim, and it remains pending PR review and merge.

The sequence still does not cover daemon-restart empty-history behavior. Record
that separately before using the stream as complete release evidence for a
candidate.

## Sandbox Fixture

Use the one-command sandbox when you want to manually inspect a realistic isolated
topology:

```bash
scripts/dockermap-fixture-up.sh --verify
```

It starts a labeled Compose stack, temporary provider command stubs for host runtime
signals, and DockerMap itself on loopback random ports. Tear it down with:

```bash
scripts/dockermap-fixture-down.sh
```

Details and cleanup boundaries are in
[`docs/testing/SANDBOX_FIXTURE.md`](SANDBOX_FIXTURE.md).
The full step-by-step operator procedure is in
[`docs/testing/TESTBED_DOCKER_PROCEDURE.md`](TESTBED_DOCKER_PROCEDURE.md).

## Manual Smoke Test

Use this after larger changes or before a demo:

1. Start the full local stack:

   ```bash
   npm run dev:stack
   ```

2. Open `http://127.0.0.1:3233`.

3. Check the main pages: dashboard, containers, images, networks, volumes, logs, and
   Compose, plus the Runtime Map page.

4. Check these API routes:

   ```text
   GET http://127.0.0.1:4000/api/health
   GET http://127.0.0.1:4000/api/snapshot
   GET http://127.0.0.1:4000/api/runtime/map
   GET http://127.0.0.1:4000/api/compose/scan?file=tests/fixtures/compose/path-mapping.compose.yaml
   GET http://127.0.0.1:4000/api/compose/graph?file=tests/fixtures/compose/path-mapping.compose.yaml
   GET http://127.0.0.1:4000/api/compose/edit-plan?file=tests/fixtures/compose/path-mapping.compose.yaml&service=api&mount=0&source=./app
   ```

5. In the Compose page or scan response, confirm runtime mount checks can show
   `matched`, `missing`, and `extra`.

6. In `/api/runtime/map`, confirm Docker nodes appear and optional providers such as PM2,
   systemd, cron, tmux, Tailscale/Headscale, reverse proxy, and local DNS either return
   nodes or clear diagnostics when the tool is unavailable.

7. Confirm edit plans are still dry-run only and return `willWrite: false`.

## Bearer-Token Auth Smoke Test

When `DOCKERMAP_API_TOKEN` is set, every browser-facing route requires the token
except a CORS preflight request. If `DOCKERMAP_DAEMON_TOKEN` is set, it protects every
daemon route independently (and non-loopback daemon binding is refused without it).

```bash
DOCKERMAP_API_TOKEN="replace-with-a-long-random-value" npm run dev:api
```

Expected behavior:

- `GET /api/health` returns `401` without a token.
- `GET /api/snapshot` returns `401` without a token.
- Both routes work with
  `Authorization: Bearer replace-with-a-long-random-value`.

## Reverse-Proxy Review Smoke Test

For a review UI on another machine:

- Keep the Rust daemon private on `127.0.0.1:4100`.
- Expose only the Node API and built web app through HTTPS.
- Make the reverse proxy authenticate viewers before it injects the bearer token.
- Confirm `/api/snapshot`, `/api/compose/scan`, and `/api/events/stream` work through
  the proxy.

More detail is in [docs/deployment/REVERSE_PROXY.md](../deployment/REVERSE_PROXY.md).

For the local host-side API path, `scripts/smoke-deploy.sh` now checks `/api/health`,
the protected JSON routes, bearer-token `401` behavior when a token is supplied, and a
live `/api/events/stream` snapshot event.

## Gaps To Close

- Broaden browser end-to-end tests beyond the current smoke flows.
- Run and record live-Docker integration evidence on the release host.
- Add reverse-proxy integration tests for bearer-token injection and SSE streaming.
- [x] Add generated OpenAPI and contract-drift checks for the versioned API.
  `/api/openapi.json` is an OpenAPI 3.1.1 artifact derived from the route
  manifest, request declarations, and response-schema associations. Its
  structural validation and drift checks run through `npm run check:contracts`.
- Add fixture-driven provider redaction tests for any future reverse-proxy
  config-content, DNS config-content, package advisory, registry, or
  external-API collectors.
- Add write-mode tests only after backup, confirmation, and rollback behavior exists.
