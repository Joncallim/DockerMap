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
- Shared contract examples in `tests/fixtures/contracts`, read by both Rust and
  TypeScript tests so the backend and browser-facing types do not drift apart.
- API security tests for bearer auth, CORS, daemon URL restrictions, query limits,
  mock fallback, and error detail exposure.
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
compatibility test; the web package is wired for tests and passes when no web tests
exist yet. The API package has black-box security tests that start the real Express entry point
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

- `/api/health` staying public while protected routes require a bearer token.
- Rejection of missing and incorrect bearer tokens.
- Explicit-origin CORS behavior and rejected wildcard startup config.
- Loopback-only daemon URL enforcement unless remote access is explicitly enabled.
- Query limits for Compose scan and edit-plan routes.
- Hidden daemon error details by default, with opt-in detail exposure.

Run GUI smoke tests before release candidates:

```bash
npm run test:e2e
```

Run live-Docker tests only on a Docker-capable Linux host:

```bash
npm run test:live-docker
```

## Manual Smoke Test

Use this after larger changes or before a demo:

1. Start the full local stack:

   ```bash
   npm run dev:stack
   ```

2. Open `http://127.0.0.1:3233`.

3. Check the main pages: dashboard, containers, images, networks, volumes, logs, and
   Compose.

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

When `DOCKERMAP_API_TOKEN` is set, `/api/health` should stay open, but other API routes
should require the token.

```bash
DOCKERMAP_API_TOKEN="replace-with-a-long-random-value" npm run dev:api
```

Expected behavior:

- `GET /api/health` returns JSON without a token.
- `GET /api/snapshot` returns `401` without a token.
- `GET /api/snapshot` works with
  `Authorization: Bearer replace-with-a-long-random-value`.

## Reverse-Proxy Review Smoke Test

For a review UI on another machine:

- Keep the Rust daemon private on `127.0.0.1:4100`.
- Expose only the Node API and built web app through HTTPS.
- Make the reverse proxy authenticate viewers before it injects the bearer token.
- Confirm `/api/snapshot`, `/api/compose/scan`, and `/api/events/stream` work through
  the proxy.

More detail is in [docs/REVERSE_PROXY.md](REVERSE_PROXY.md).

## Gaps To Close

- Broaden browser end-to-end tests beyond the current smoke flows.
- Run and record live-Docker integration evidence on the release host.
- Add reverse-proxy integration tests for bearer-token injection and SSE streaming.
- Add OpenAPI schema checks once the versioned API spec exists.
- Add write-mode tests only after backup, confirmation, and rollback behavior exists.
