# DockerMap Testing Plan

DockerMap is still read-first, so the tests focus on one promise: a person should be
able to inspect Docker, Compose, and host runtime state without DockerMap changing files,
containers, or services.

## What The Automated Tests Cover

- TypeScript type checks for the web app, Node API, and shared contracts.
- Production builds for the TypeScript workspaces.
- Rust formatting and linting.
- Rust unit tests for the core Docker and Compose model.
- Runtime-map contracts for Docker and non-Docker provider signals.
- Shared contract examples in `tests/fixtures/contracts`, read by both Rust and
  TypeScript tests so the backend and browser-facing types do not drift apart.

## Run The Local Check Suite

Run these before merging or pushing a change that touches code, contracts, or API shapes:

```bash
npm ci
npm audit --omit=dev
npm run typecheck
npm run build
npm test
PATH="$HOME/.cargo/bin:$PATH" cargo fmt --manifest-path crates/Cargo.toml --all -- --check
PATH="$HOME/.cargo/bin:$PATH" cargo clippy --manifest-path crates/Cargo.toml --all-targets -- -D warnings
PATH="$HOME/.cargo/bin:$PATH" cargo test -p dockermap-core --manifest-path crates/Cargo.toml
```

`npm test` currently runs Vitest. The contracts package has an active compatibility test;
the web package is wired for tests and passes when no web tests exist yet.

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

- Add browser end-to-end tests with Playwright.
- Add live-Docker integration tests that spin up a fixture Compose project.
- Add reverse-proxy integration tests for bearer-token injection and SSE streaming.
- Add OpenAPI schema checks once the versioned API spec exists.
- Add write-mode tests only after backup, confirmation, and rollback behavior exists.
