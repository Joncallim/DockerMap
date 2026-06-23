# DockerMap Implementation Plan

> Detailed sub-tasks and file-level guidance for each phase of the roadmap.
> For the high-level vision and dependency graph, see [`ROADMAP.md`](ROADMAP.md).

Each phase is split into **concurrent streams** that can be assigned to different
developers. Dependencies within a stream are noted inline; streams within a phase are
otherwise independent.

## Current Product Direction

DockerMap is no longer just a Docker-and-Compose map. Docker is one subsystem inside a
larger operational topology. The first full-alpha push should prioritize backend model,
collector, contract, and security work for:

- Docker containers, networks, volumes, images, and Compose stacks.
- systemd services, dependencies, restart metadata, uptime, and bounded logs.
- tmux sessions and tmux-managed workers.
- npm projects, Node.js services, package dependencies, and lockfiles.
- Python applications and native Linux processes as follow-on provider peers.
- Reverse proxies, DNS providers, external APIs, storage pools, databases, and AI agents.

Do not develop the GUI in this phase. The GUI will be handed off separately once the
runtime model and contracts are stable.

---

## Current Status

### Done (Phase 0)
- Monorepo: React/Vite (3233), Express API (4000), Rust Axum daemon (4100)
- Rust toolchain pinned, `Cargo.lock` committed
- CI workflow published at `.github/workflows/ci.yml`
- Compose test fixtures at `tests/fixtures/compose/`
- Architecture + `docs/architecture/PAGE_LOGIC.md` documentation; Vite 8, 0 audit vulnerabilities

### In Progress (Phase 1)
- Docker runtime inventory via bollard is working: containers, images, networks, volumes,
  logs, and mounts.
- The runtime map also reads PM2 apps, systemd services, cron jobs, tmux sessions, npm
  projects, listening sockets, Tailscale/Headscale nodes, reverse-proxy markers, and
  local DNS markers when those tools are available on the host.
- A first provider-neutral service entity model is in place, along with bounded systemd
  dependency enrichment, bounded npm project/package discovery, and an expanded
  cross-technology runtime-map contract fixture.
- All current read-only API endpoints are exposed.
- React UI has pages for dashboard, containers, container detail, images, networks,
  volumes, logs, and Compose.
- Frontend component split, Compose scan/graph/edit-plan endpoints, CLI
  scan/validate/export, Compose/runtime correlation, override merge semantics, and
  contract compatibility tests are done.
- Still to build before full alpha: provider-specific redaction fixtures for new
  collectors, richer package/update/advisory behavior, Python/native-process provider
  peers, table sorting, advanced filters, clickable graph nodes, log level filter, live
  tail, and log pagination UI.
- Immediately after the next implementation commit lands, execute the follow-up queue in
  [`docs/release/RELEASE_CHECKLIST.md`](../release/RELEASE_CHECKLIST.md): provider redaction fixtures,
  package advisory/network opt-in docs, live-Docker/reverse-proxy release-host evidence,
  and Python/native-process provider planning.
- Testing plan: see [`docs/testing/TESTING_PLAN.md`](../testing/TESTING_PLAN.md).

---

## Phase 1 — Read-Only Map Completion

> Current state: component decomposition, Compose parsing/resolution/discovery,
> scan/graph/edit-plan endpoints, contract types, CLI commands, and the first Compose UI
> route are in place. Compose scans also compare declared mounts with runtime mounts.
> Remaining Phase 1 work is mostly list UX, log UX, and deeper resource detail pages.

### Stream A — Rust: Compose Parsing _(sequential within stream)_

**A1. Compose File Discovery**
- Scan for `docker-compose.yml`, `docker-compose.yaml`, `compose.yml`, `compose.yaml`
- Support explicit `-f`/`--file` arg; detect override files
- Return file list with metadata (size, last modified)
- New file: `crates/dockermap-core/src/compose/discovery.rs`

**A2. Compose File Parser** _(depends on A1)_
- Add `serde_yaml = "0.9"` to `Cargo.toml`
- Types: `ComposeFile`, `ComposeService`, `ServiceVolume`, `ServiceMount`
- Parse both short-form (`./data:/app/data:ro`) and long-form (`type: bind/volume/tmpfs`)
- Handle named volumes (`source: my_vol`), anonymous volumes (no source), `tmpfs`
- Preserve source file path and line numbers on each declaration
- New file: `crates/dockermap-core/src/compose/parser.rs`
- Unit tests for every syntax form in `tests/fixtures/compose/path-mapping.compose.yaml`

**A3. Path Resolution** _(depends on A2)_
- Resolve relative host paths against the Compose file's own directory
- Normalize `..` / `.` components
- Expand `${VAR:-default}` / `${VAR}` — emit `ComposeDiagnostic(Warning)` for unresolved
- Produce `ResolvedMount { host_path (absolute), container_path, mode, source_file, source_line }`
- New file: `crates/dockermap-core/src/compose/resolver.rs`

**A4. Compose to Runtime Correlation** Done
- Match Compose service names to containers via `com.docker.compose.service` label
- Produce `MountCorrelation { declared_source, runtime_source, status: matched|missing|extra }`
- Implemented in the active core scan model in `crates/dockermap-core/src/lib.rs`

**A5. Override File Merging** Done
- Merge `docker-compose.override.yml` per Compose spec (volumes append, env maps merge,
  image replaces)
- Test with `tests/fixtures/compose/override.compose.yaml`

**A6. Daemon Compose Endpoints** Done
- Delivered: `GET /daemon/compose/scan`, `GET /daemon/compose/graph`,
  `GET /daemon/compose/edit-plan`
- Optional later split endpoints: files, services, mounts, and project aggregates if the
  UI needs narrower payloads
- File: `crates/dockermap-daemon/src/main.rs`

**A7. Log Pagination** _(independent — do any time)_
- Add `cursor` and `limit` query params to `GET /daemon/logs`
- Return opaque base64 cursor in `LogsResponse.nextCursor`
- File: `crates/dockermap-daemon/src/main.rs`

---

### Stream B — Node/Express: Proxies & Contract Hardening

**B1. Proxy Compose endpoints** Done
- Delivered `/api/compose/scan`, `/api/compose/graph`, and `/api/compose/edit-plan` in
  `apps/api/src/index.ts`
- Mock fallback returns safe empty Compose responses when the daemon is unavailable

**B2. Contract compatibility tests** Done
- Shared JSON examples live in `tests/fixtures/contracts`
- Rust deserializes the fixtures in `dockermap-core` tests
- TypeScript imports the same fixtures in `packages/contracts/src/compatibility.test.ts`
- Prevents silent drift between Rust renames and TypeScript consumers

**B3. Add Compose types to `@dockermap/contracts`** Done
- Mirrors the active scan, graph, diagnostics, mount, service, and edit-plan response
  shapes consumed by the API and web app

**B4. Individual resource detail endpoints**
- `GET /daemon/images/:imageRef` — full tag list, size, created date, using containers
- `GET /daemon/networks/:id` — IPAM config, subnet, gateway, attachability
- `GET /daemon/volumes/:name` — mountpoint, driver options, labels

**B5. Keep CI workflow healthy**
- Source of truth: `.github/workflows/ci.yml`
- Trigger: `push` (all branches) + `pull_request`
- Keep local scripts and CI steps aligned for TypeScript, Rust format/lint, and tests

**B6. Python legacy removed**
- Keep README and architecture docs pointed at the React + Node.js + Rust stack only

---

### Stream C — Frontend: Component Decomposition Done

> Complete; Stream D feature work is unblocked.

**C1. Extract hooks** → `apps/web/src/hooks/`
- `useApiResource.ts`, `useDaemonHeartbeat.ts`, `useSearchParamState.ts`

**C2. Extract utilities** → `apps/web/src/utils/`
- `api.ts` (`API_BASE`, `apiUrl`, `fetchJson`), `format.ts` (`formatTime`)

**C3. Extract UI primitives** → `apps/web/src/components/`
- `StatePanel.tsx`, `EmptyPanel.tsx`, `KpiCard.tsx`, `InfoCard.tsx`, `GraphNodeCard.tsx`

**C4. Extract pages** → `apps/web/src/pages/`
- One file per page: `DashboardPage`, `ContainersPage`, `ContainerDetailPage`,
  `ImagesPage`, `NetworksPage`, `VolumesPage`, `LogsPage`, `NotFoundPage`

**C5. Slim `App.tsx`**
- After C1–C4: `App.tsx` = imports + `AppShell` component + `<Routes>` — target ≤ 80 lines

---

### Stream D — Frontend: Feature Gaps _(depends on C5; sub-tasks are parallel)_

**D1. Table sorting** — `sort` + `dir` query params on all list pages; shared
`useSortState` hook; default name ascending; sort direction indicator.

**D2. Advanced filtering** — containers: network/image/stack pills; images: in-use/
unused/dangling; networks: driver, empty; volumes: attached/unattached; logs: level.

**D3. Clickable graph nodes** — containers → `/containers/:name`; networks →
`/networks?network=id`; volumes → `/volumes?volume=name`; hover tooltip.

**D4. Container detail enrichment** — labels key/value table, formatted port bindings
(`host:port → container:port/proto`), volume attachment section, restart policy.

**D5. Networks page: IPAM** — subnet, gateway, per-member container IPs.

**D6. Volumes page** — driver, mountpoint, scope; mark unattached as prune candidates.

**D7. Logs improvements** — level filter dropdown, message search, live-tail toggle with
auto-scroll, "Load more" cursor button (requires A7).

**D8. Compose UI** _(depends on B1)_ — new `/compose` page: discovered files, mount
table (host path → container path → service → file:line), named vs bind visual coding.

**D9. Dashboard: search-aware graph** — dim non-matching nodes; highlight matches.

---

### Stream E — Infrastructure _(independent of all other streams)_

**E1. Add Vitest** Done
- `@dockermap/web` and `@dockermap/contracts` both have test scripts.
- `npm test` runs workspace tests.
- The contracts package includes an active compatibility test against shared fixtures.

**E2. TypeScript strict audit** Done
- `strict: true` is enabled through the shared TypeScript config and workspace builds.

**E3. Runtime mount capture** Done
- `ContainerRecord.mounts` captures runtime mounts, including bind mounts, and seeds
  Compose/runtime drift detection.

**E4. Testing plan** Done
- `docs/testing/TESTING_PLAN.md` explains automated checks, local smoke tests, token-auth checks,
  reverse-proxy review checks, and current test gaps.

---

### Phase 1 Verification

Covered now:

- `cargo test -p dockermap-core` covers Compose parser tests, override merging,
  runtime correlation, edit planning, and shared contract fixtures.
- `npm run typecheck`, `npm run build`, and `npm test` cover TypeScript workspaces and
  shared contract compatibility.
- `App.tsx` is under 100 lines.
- `GET /api/compose/scan` returns discovered files and resolved mount paths.
- `GET /api/compose/graph` returns service, source, and target path nodes.
- CI runs on push and pull request.

Remaining:

- All list pages need sort controls.
- Graph nodes need click navigation.
- Browser end-to-end tests are not wired yet.

---

## Phase 1.5 — Runtime Map, Networking, And External API

> Runs **concurrently with Phase 2**. Makes DockerMap more than a container list by
> mapping PM2 apps, systemd services, cron jobs, tmux sessions, listening ports,
> Tailscale/Headscale, reverse proxies, local DNS, and Docker network topology. Also
> enables embedding in external dashboards such as Homepage, Grafana, and scripts.

### Stream A — External API Exposure

**A1. Configurable exposure & auth** Done
- `DOCKERMAP_DAEMON_HOST` and `DOCKERMAP_DAEMON_PORT` control daemon binding; non-loopback
  daemon binding also requires `DOCKERMAP_ALLOW_REMOTE_DAEMON=true`
- `DOCKERMAP_API_TOKEN` — Bearer token middleware on the Express Node API for all non-health
  endpoints
- `DOCKERMAP_ALLOWED_ORIGINS` — comma-separated allowed origins for the Express Node API
- Document risks in `docs/security/THREAT_MODEL.md` and `docs/deployment/REVERSE_PROXY.md`

**A1.5. VPS-hosted review UI**
- Build `apps/web` with `VITE_API_BASE_URL` pointing at the public Node API origin.
- Serve `apps/web/dist` behind HTTPS on the VPS reverse proxy.
- Expose only the Express Node API publicly; keep the Rust daemon loopback/private unless
  remote daemon access is explicitly required.
- Require `DOCKERMAP_API_TOKEN` for all non-health Node API routes before opening firewall or
  proxy access to the internet.
- Set CORS to the review UI origin only; no wildcard origins.
- Purpose: interface/dashboard review, comments, and read-only inspection. Compose writes
  remain unavailable until the Phase 3 edit confirmation flow exists.

**A2. OpenAPI documentation**
- `docs/openapi.yaml` covering all v1 read-only endpoints (params, schemas, error codes)
- `GET /api/openapi.json` from Express Node API
- `GET /api/docs` serving Swagger UI via `swagger-ui-dist`

**A3. API versioning**
- Prefix all routes `/api/v1/` (keep `/api/` as alias)
- `X-DockerMap-Version` response header on every response
- `GET /api/v1/status` (no auth): `{ version, uptime_seconds, docker_reachable,
  compose_files_found, mode }`

**A4. Homepage widget endpoint**
- `GET /api/widgets/homepage` (no auth): `{ status, containers: { running, stopped,
  total }, networks: N, images: N, errors: N }`
- Document Homepage widget config in README (URL, title, icon)

**A5. Rate limiting**
- `express-rate-limit`: 120 req/min per IP on read endpoints; 10 req/min on future
  write endpoints

### Stream A.5 — Current Runtime Map Providers

**A.5.1. Host runtime provider pass** Done
- `GET /daemon/runtime/map` now includes read-only providers for systemd, cron, PM2,
  tmux, listening sockets, Tailscale, Headscale, reverse-proxy markers, local DNS
  markers, and Docker-derived graph nodes.
- `GET /api/runtime/map` proxies that provider-neutral graph to the browser.
- Provider commands are fixed read-only invocations and return diagnostics instead of
  failing the whole map when a tool is absent.

### Stream A.6 — Unified Service Entity And Application Ecosystems

**A.6.1. Core model expansion**
- File: `crates/dockermap-core/src/lib.rs`
- Add a provider-neutral service entity shape with common fields:
  `name`, `status`, `dependencies`, `dependents`, `health`, `logs`, `events`, `owner`,
  and `location`.
- Preserve current `RuntimeMap` compatibility while enriching nodes with `layer`,
  service metadata, and evidence/source metadata.
- Expand node and relationship enums for npm projects, Python projects, Node.js services,
  AI agents, package dependencies, hosts, storage pools, external APIs, DNS providers,
  reverse proxies, systemd dependencies, package dependencies, and runtime hosts.

**A.6.2. systemd dependency provider**
- File: `crates/dockermap-daemon/src/main.rs`
- Use fixed read-only calls only: `systemctl list-units`, `systemctl show`, and bounded
  journal snippets only after redaction rules exist.
- Capture service name, active/sub state, enabled state, unit file path, restart policy,
  restart count, uptime fields, and dependencies.
- Add graph edges for `After=`, `Requires=`, `Wants=`, and `PartOf=` when the referenced
  unit is also present or can be represented as a placeholder systemd node.
- Add parser-level tests for representative `systemctl` output.

**A.6.3. npm project provider**
- Files: `crates/dockermap-daemon/src/main.rs`, optionally a later provider module split.
- Discover `package.json`, `package-lock.json`, `pnpm-lock.yaml`, and `yarn.lock` under
  `DOCKERMAP_PROJECT_ROOT`.
- Skip `node_modules`, `.git`, `dist`, `build`, `target`, coverage, and cache
  directories.
- Parse project name, version, scripts, framework hints, dependency names, lockfile type,
  and location.
- Add npm project nodes plus package dependency edges.
- Do not read `.env` values or registry auth files.

**A.6.4. Contracts and fixtures**
- Files: `packages/contracts/src/index.ts`, `tests/fixtures/contracts/runtime-map.json`
- Keep TypeScript runtime-map contracts in sync with Rust.
- Add fixture examples for:
  `Cloudflare -> Caddy (systemd) -> Docker network -> Immich container -> Postgres container -> Storage volume`.
- Add fixture examples for:
  `Forge (npm) -> forge.service -> tmux session -> GPT worker`.

**A.6.5. Security and alpha evidence**
- Files: `apps/api/test/security.test.ts`, `docs/security/THREAT_MODEL.md`,
  `docs/testing/TESTING_PLAN.md`, `docs/release/RELEASE_CHECKLIST.md`
- Add tests that do not require Docker/systemd availability.
- Verify auth, CORS, daemon URL restrictions, bounded query handling, hidden daemon error
  details, runtime-map fallback safety, and startup rejection for unsafe configuration.
- Add alpha gates for bounded filesystem scans, fixed read-only commands, no secret/env
  leakage, and documented opt-in package advisory/network behavior.
- After the current commit is completed, create the concrete follow-up issues/tasks named
  in the release checklist's "Execute After Next Commit" section.

---

### Stream B — Docker Network Deep Dive

**B1. IPAM enrichment**
- Pull `Ipam.Config[].Subnet`, `Gateway`, `IPRange` from bollard network inspect
- Add `ipam: { subnet, gateway, ip_range }` to `NetworkRecord`
- Add `container_ip: string` to each container's network membership entry
- Networks page: show each member container with its IP

**B2. Gateway detection**
- Detect containers spanning ≥ 2 networks → candidate gateway containers
- Infer `role: "gateway" | "service" | "database" | "cache"` from network membership +
  image name heuristics (`nginx`, `traefik`, `caddy`, `postgres`, `redis`, etc.)
- Dashboard graph: gateway-role containers rendered distinctly

**B3. Port exposure map**
- Extend `ContainerRecord.ports`: add `host_ip`, `host_port`, `container_port`,
  `protocol`, `publicly_exposed` (`host_ip == "0.0.0.0"` or `"::"`)
- `GET /daemon/ports` — all publicly exposed ports across all containers
- Dashboard: "Exposed Ports" summary table; port-based search

**B4. Reverse proxy label parsing**
- Parse Traefik labels: `traefik.http.routers.<name>.rule=Host(\`domain\`)`,
  `traefik.http.services.<name>.loadbalancer.server.port`
- Parse Nginx Proxy Manager labels; parse Caddy labels
- Type: `ProxyRoute { domain, container_name, port, tls, provider }`
- `GET /daemon/proxy-routes`
- New `/domains` page: domain → container → port table; TLS indicator
- Container detail: "Domains" section

**B5. Reverse DNS**
- PTR lookup for each container IP; cache with 5-minute TTL
- Add `resolved_hostname?: string` to network membership in `ContainerRecord`
- Show hostnames alongside IPs in Networks page and container detail

---

### Stream C — Tailscale / Headscale Integration

**C1. Base Tailscale and Headscale discovery** Done
- `GET /daemon/runtime/map` reads `tailscale status --json` when Tailscale is available.
- `GET /daemon/runtime/map` reads `headscale nodes list --output json` when Headscale is
  available.
- Missing tools produce diagnostics instead of failing the whole runtime map.

**C1.5. Tailnet provider enrichment**
- Optionally switch to `/var/run/tailscale/tailscaled.sock` for richer Tailscale metadata.
- Parse peer list details such as `NodeKey`, `DNSName`, `TailscaleIPs`, `Online`, and
  `Tags`.
- Cache with a 30-second TTL.

**C2. Container ↔ peer correlation**
- Match by: container label `tailscale.hostname`/`tailscale.ip`, container name matching
  Tailscale DNS name, or `TS_AUTHKEY` env var presence
- Type: `TailscaleRecord { peer_name, tailscale_ip, container_name, online, tags }`

**C3. Headscale API enrichment**
- `DOCKERMAP_HEADSCALE_URL` + `DOCKERMAP_HEADSCALE_API_KEY` env vars
- Query `GET /api/v1/machine`; same correlation logic as C2

**C4. Daemon endpoints**
- `GET /daemon/tailscale/peers` — peers with container correlation
- `GET /daemon/tailscale/status` — overall connectivity, exit node, online count

**C5. Tailscale UI**
- Dashboard: "VPN-accessible containers" (hidden when absent)
- Container detail: Tailscale badge + IP when correlated
- New `/tailscale` page: peer list, online status, ACL tags, container links
- Graceful "Tailscale not detected" empty state

---

### Stream D — Network Visualization Upgrade

**D1. Graph view selector**
- Dashboard toggle: "Docker Topology" | "Network View" | "Domain View" | "VPN View"
- Network View: containers grouped by Docker network with IPs, gateway containers
  highlighted
- Domain View: reverse-proxy routes as nodes; domain → container → port flow
- VPN View: Tailscale/Headscale peers mapped to containers (shown only when VPN detected)

**D2. Force-directed layout**
- Replace CSS-grid graph with D3 force layout or `@xyflow/react`
- SVG edges between nodes; zoom/pan; click to navigate
- Container nodes colour by status; network: teal; volume: amber; domain: purple; VPN: green

---

### Phase 1.5 Verification

- [ ] `GET /api/runtime/map` returns Docker nodes and either provider nodes or clear
  diagnostics for PM2, systemd, cron, tmux, Tailscale/Headscale, proxy, DNS, and ports
- [ ] `GET /api/v1/status` returns 200 through an authenticated reverse proxy
- [ ] `GET /api/widgets/homepage` returns expected JSON; documented in README
- [ ] `GET /api/docs` renders Swagger UI covering all read-only endpoints
- [ ] Networks page shows per-member container IPs
- [ ] Gateway-role containers visually distinct in graph
- [ ] Traefik label parser extracts domains from test fixtures
- [ ] `/domains` page renders detected proxy routes
- [ ] Tailscale: `/tailscale` page and container badges work when running; graceful empty state when absent

---

## Phase 2 — Validation & Diagnostics

> **Prerequisite:** Phase 1 Compose parsing (A1–A3) complete.

### Stream A — Rust Validation Engine

**A1. `ValidationRule` trait** — `fn check(&self, project: &ComposeProject) ->
Vec<ComposeDiagnostic>`; one concrete struct per rule.

**A2. Validation rules** _(each can be a separate PR)_
- `MissingHostPath` — `fs::metadata(host_path)` check → `Error`
- `DuplicateContainerTarget` — two mounts same target per service → `Error`
- `AmbiguousRelativePath` — `../..` above project root → `Warning`
- `ReadWriteMismatch` — declared `read_only: false` but host path unwritable → `Warning`
- `PathTraversal` — escapes configured `projectRoot` policy → `Error`
- `UnresolvedEnvVar` — `${VAR}` with no default and absent from env → `Error`
- File: new `crates/dockermap-core/src/validation/` module

**A3. Severity model + machine-readable output**
- `Severity` enum: `Info | Warning | Error | Blocked`
- `GET /daemon/compose/validate` → `{ rules, diagnostics, summary: { errors, warnings, info } }`

**A4. Malformed fixture tests**
- New `tests/fixtures/compose/invalid/` with: missing path, duplicate target, unresolved
  var, path traversal
- `#[test]` for each asserting expected severity and kind

---

### Stream B — API & Diagnostics UI

**B1.** Proxy `GET /api/compose/validate`; add mock response; add `ComposeDiagnostic` to
`@dockermap/contracts`.

**B2.** New `/diagnostics` page — severity-grouped table, filter by severity/file/rule.

**B3.** Severity badges on nav items; error outline on graph nodes with issues.

**B4.** Fifth KPI card on Dashboard: total errors + warnings.

**B5.** `GET /api/diagnostics?format=json` for CI; "Export JSON" button in UI.

---

### Stream C — Security Docs

**C1. Security docs** — keep `docs/security/THREAT_MODEL.md` and `docs/deployment/REVERSE_PROXY.md` current
for host path exposure, symlink traversal, Docker socket risk, and external API risks.

---

### Phase 2 Verification

- [ ] Each validation rule has passing and failing tests
- [ ] `GET /api/compose/validate` returns structured JSON matching contracts
- [ ] Diagnostics page renders and groups by severity
- [ ] `Blocked` severity will gate edits in Phase 3

---

## Phase 3 — Editing Workflow

> **Prerequisite:** Phase 2 complete. `Blocked` diagnostics must gate writes.
> Write endpoints require `DOCKERMAP_EDITS_ENABLED=true` flag + API token.

### Stream A — Rust Edit Engine _(sequential within stream)_

**A1. YAML round-trip parsing**
- Parse with `serde_yaml::Value` (generic, preserves structure)
- Round-trip test: parse → re-serialize → must match input byte-for-byte
- Add `similar` crate for unified diff generation
- New file: `crates/dockermap-core/src/compose/yaml_roundtrip.rs`

**A2. Dry-run edit plan** _(depends on A1)_
- `EditRequest { file, service, mount_index, new_source?, new_target?, new_mode? }`
- Run all Phase 2 validation on proposed state; return 400 if any `Blocked`
- Return `EditPlan { original_yaml_excerpt, proposed_yaml_excerpt, diff_lines }`
- New file: `crates/dockermap-core/src/editing/planner.rs`

**A3. Unified diff** _(depends on A2)_
- Standard unified diff (`--- a/file.yml` / `+++ b/file.yml`) via `similar` crate
- New file: `crates/dockermap-core/src/editing/diff.rs`

**A4. Backup & apply** _(depends on A1–A3)_
- Copy original to `<filename>.dockermap.bak` in same directory
- Write to temp file; atomic rename
- Git-aware warning: uncommitted changes → add `Warning` to `EditPlan`
- New file: `crates/dockermap-core/src/editing/writer.rs`

---

### Stream B — Write API

**B1.** `POST /daemon/compose/edit/preview` (feature-flagged) → `EditPlan` with diff

**B2.** `POST /daemon/compose/edit/apply` body `{ plan_id, confirm: true }` →
`ApplyResult { backup_path, applied_at, rollback_command }`; max 1 concurrent write

**B3.** Node API proxy for write routes; append each apply to `apps/api/src/audit.log`

---

### Stream C — Frontend Edit UI

**C1. Diff preview modal** — "Change path" on mount row → modal with colour-coded
`+`/`-` diff lines and validation summary; "Cancel" / "Apply" buttons.

**C2. Edit form** — inline host-path and mode inputs; client-side validation; submits to
preview endpoint.

**C3. Confirmation flow** — "Apply" sends apply-edit; success/failure toast; shows backup
path.

---

### Phase 3 Verification

- [ ] Dry-run returns valid unified diff for all mount types in fixture
- [ ] Write creates `.dockermap.bak`; original correctly modified
- [ ] Endpoints return 403 without `DOCKERMAP_EDITS_ENABLED`
- [ ] `Blocked` diagnostics prevent apply
- [ ] No write without explicit "Apply" after diff review

---

## Phase 4 — Visual & UX Polish

> Can begin concurrently with Phase 3.

**Theme toggle** — dark/light; `localStorage`; CSS custom property override.

**Keyboard shortcuts** — `g/c/i/n/v/l` for nav; `/` focus search; `?` cheatsheet;
`Escape` clear search.

**Accessibility** — `aria-label` and `role` on all interactive elements; axe-core audit.

**Empty states** — contextual message on every page when no data; onboarding prompt when
Docker is unreachable.

**Playwright E2E tests**
- Install `@playwright/test`; target mock stack
- Smoke: dashboard KPIs, containers filter, detail navigation, logs filter
- Navigation: all cross-page links from `docs/architecture/PAGE_LOGIC.md`
- Add Playwright job to CI workflow
- New directory: `tests/e2e/`

---

## Phase 5 — Runtime Enrichment

> **Prerequisite:** Phase 1 complete (runtime mount capture + correlation).

### Stream A — Container Metrics

**A1.** Background task polling bollard `stats()` every 5 seconds; store
`ContainerMetrics { cpu_percent, memory_mb, memory_limit_mb }` with per-container cache.

**A2.** `GET /daemon/containers/:name/metrics`

**A3.** CPU/memory bars in ContainerDetail; `sort=cpu`/`sort=memory` on Containers page.
New file: `crates/dockermap-daemon/src/metrics.rs`

---

### Stream B — Drift Detection

**B1.** Compare `ContainerRecord.mounts` (bollard runtime data) vs
`ComposeMountDeclaration` per service → `DriftReport { matched, only_in_compose,
only_in_runtime }`.

**B2.** `GET /daemon/compose/drift`

**B3.** Drift badge on ContainerDetail; Drift section on Diagnostics page.

---

## Phase 6 — Collaboration & Release

> **Prerequisite:** Phases 1–5 largely complete.

**CLI package** — `crates/dockermap-cli` with `clap`; commands: `scan`, `validate`,
`export`, `report`, `edit --dry-run`; ship as binary via GitHub Releases.

**Saved reports** — `GET /api/v1/report?format=json|html`; fail CI if any `Error`
diagnostic.

**Release workflow** — `.github/workflows/release.yml` on `v*` tags; build daemon + CLI
for linux-x86_64, linux-aarch64, macos-aarch64; publish as Release assets with checksums.

**Changelog** — `CHANGELOG.md` in Keep a Changelog format.

**npm publish for contracts** — `publishConfig.access: public`; publish on release.

---

## Stretch Goals

| Priority | Goal | Notes |
|---|---|---|
| High | Contract generation | `typeshare` or `schemars` + TS emit; CI diff check to catch drift |
| High | `.env` interpolation | Load `.env`, substitute `${VAR}` before parsing; warn on missing |
| High | Compose override merging UI | Show merged service view with per-field source annotations |
| Medium | Dockerfile path extraction | `WORKDIR`, `COPY`, `VOLUME` from Dockerfiles; link to `build:` context |
| Medium | Mermaid / Graphviz export | `GET /api/v1/graph?format=mermaid|dot` |
| Medium | Integration tests with live Docker | Spin up fixture project; assert on output; opt-in via env var |
| Medium | Policy file for allowed paths | `.dockermap.policy.yaml`; `PathTraversal` rule checks it |
| Low | Path normalization (Windows/WSL/macOS) | `C:\Users\...` → `/mnt/c/...`; Docker Desktop path translation |
| Low | Named volume lifecycle hints | Volumes in Docker not in any Compose file (prune candidates) |
| Low | "Explain this mount" AI command | `POST /api/v1/explain`; Claude API integration |
| Low | AdGuard / Pi-hole DNS awareness | Query local DNS for container hostname records |
| Low | WireGuard peer mapping | `wg show` output parsing; similar to Tailscale integration |
| Low | Multi-project view | Multiple directories; cross-project volume sharing detection |
| Low | Desktop wrapper (Tauri) | Only after core product is stable; native tray, auto-start |

---

## Key Files at a Glance

| Phase | File | Change |
|-------|------|--------|
| 1-A | `crates/dockermap-core/src/compose/` | New module: discovery, parser, resolver, correlation |
| 1-A | `crates/dockermap-daemon/src/main.rs` | Add compose routes |
| 1-B | `apps/api/src/index.ts` | Proxy compose endpoints; add v1 prefix |
| 1-B | `packages/contracts/src/index.ts` | Add compose types |
| 1-C | `apps/web/src/` | Componentized hooks/, utils/, components/, pages/ |
| 1-E | `.github/workflows/ci.yml` | Keep CI workflow aligned with local scripts |
| 1.5-A | `apps/api/src/index.ts` | Auth middleware, CORS, rate limiting, versioned routes |
| 1.5-A | `docs/openapi.yaml` | OpenAPI spec |
| 1.5-B | `crates/dockermap-core/src/` | Add network enrichment, proxy route parsing |
| 1.5-C | `crates/dockermap-daemon/src/tailscale.rs` | Tailscale/Headscale integration (new) |
| 2-A | `crates/dockermap-core/src/validation/` | New module: rules, severity, diagnostic output |
| 2-B | `apps/web/src/pages/DiagnosticsPage.tsx` | New page |
| 3-A | `crates/dockermap-core/src/editing/` | New module: planner, diff, writer |
| 3-B | `crates/dockermap-daemon/src/main.rs` | Add write routes (feature-flagged) |
| 5-A | `crates/dockermap-daemon/src/metrics.rs` | New: bollard stats polling |
| 6 | `crates/dockermap-cli/` | New crate |
