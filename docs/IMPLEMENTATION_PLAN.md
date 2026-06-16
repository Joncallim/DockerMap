# DockerMap Implementation Plan

> Detailed sub-tasks and file-level guidance for each phase of the roadmap.
> For the high-level vision and dependency graph, see [`ROADMAP.md`](../ROADMAP.md).

Each phase is split into **concurrent streams** that can be assigned to different
developers. Dependencies within a stream are noted inline; streams within a phase are
otherwise independent.

---

## Current Status

### ✅ Done (Phase 0)
- Monorepo: React/Vite (3233), Express API (4000), Rust Axum daemon (4100)
- Rust toolchain pinned, `Cargo.lock` committed
- CI template at `docs/ci/github-actions-ci.yml` (not yet published)
- Compose test fixtures at `tests/fixtures/compose/`
- Architecture + PAGE_LOGIC documentation; Vite 8, 0 audit vulnerabilities

### 🔄 In Progress (Phase 1)
- Docker runtime inventory (containers, images, networks, volumes, logs) via bollard ✅
- All read-only API endpoints exposed ✅
- React UI: 7 pages with SSE live refresh, global search, graph derivation ✅
- Compose file parsing ❌ · CLI commands ❌ · Frontend component splitting ❌
- Table sorting ❌ · Advanced filters ❌ · Clickable graph nodes ❌
- Log level filter / live tail ❌ · Log pagination UI ❌
- Contract compatibility tests ❌ · Python legacy prototype not removed ❌

---

## Phase 1 — Read-Only Map Completion

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

**A4. Compose ↔ Runtime Correlation** _(depends on A2, A3 + existing bollard integration)_
- Match Compose service names to containers via `com.docker.compose.service` label
- Produce `MountCorrelation { declared_source, runtime_source, status: matched|missing|extra }`
- New file: `crates/dockermap-core/src/compose/correlation.rs`

**A5. Override File Merging** _(depends on A2, A4)_
- Merge `docker-compose.override.yml` per Compose spec (volumes append, env maps merge,
  image replaces)
- Test with `tests/fixtures/compose/override.compose.yaml`

**A6. Daemon Compose Endpoints** _(depends on A1–A5)_
- `GET /daemon/compose/files` — discovered files with parse status
- `GET /daemon/compose/services` — parsed services with resolved mounts
- `GET /daemon/compose/mounts` — all mounts (bind + named volume)
- `GET /daemon/compose/projects` — top-level project aggregates
- File: `crates/dockermap-daemon/src/main.rs` (add routes)

**A7. Log Pagination** _(independent — do any time)_
- Add `cursor` and `limit` query params to `GET /daemon/logs`
- Return opaque base64 cursor in `LogsResponse.nextCursor`
- File: `crates/dockermap-daemon/src/main.rs`

---

### Stream B — Node/Express: Proxies & Contract Hardening

**B1. Proxy Compose endpoints** _(depends on A6)_
- Add `/api/compose/files`, `/api/compose/mounts`, `/api/compose/projects` to
  `apps/api/src/index.ts`
- Add mock fallback responses seeded from fixture data

**B2. Contract compatibility tests**
- In `crates/dockermap-core`, serialize mock snapshot to JSON in a `#[test]`; write to
  `tests/fixtures/snapshots/mock-snapshot.json`
- In `packages/contracts`, load JSON and validate against each TypeScript interface
- New file: `packages/contracts/src/compatibility.test.ts`
- Prevents silent drift between Rust renames and TypeScript consumers

**B3. Add Compose types to `@dockermap/contracts`**
- Mirror `ComposeMountDeclaration`, `ComposeFile`, `ComposeProject`, `ComposeDiagnostic`

**B4. Individual resource detail endpoints**
- `GET /daemon/images/:imageRef` — full tag list, size, created date, using containers
- `GET /daemon/networks/:id` — IPAM config, subnet, gateway, attachability
- `GET /daemon/volumes/:name` — mountpoint, driver options, labels

**B5. Publish CI workflow**
- Copy `docs/ci/github-actions-ci.yml` → `.github/workflows/ci.yml`
- Trigger: `push` (all branches) + `pull_request`

**B6. Remove Python legacy**
- Delete `legacy/python-prototype/`; update `ARCHITECTURE.md`

---

### Stream C — Frontend: Component Decomposition _(sequential — highest urgency)_

> Must complete before Stream D. Zero behaviour change; `npm run typecheck` must pass
> after every step.

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

**E1. Add Vitest** to `@dockermap/web` and `@dockermap/contracts`; wire `npm run test`.

**E2. TypeScript strict audit** — ensure `strict: true` in all `tsconfig.json`s; fix
`any` casts in `apps/api/src/index.ts`.

**E3. Extend `ContainerRecord` with bind mounts field** — in bollard collection, capture
`mount.typ == BIND` entries as `bind_mounts: Vec<BindMount>` on `ContainerRecord`; seeds
drift detection in Phase 5.

---

### Phase 1 Verification

- [ ] `cargo test` passes including new Compose parser unit tests
- [ ] `npm run typecheck` passes across all workspaces
- [ ] `App.tsx` under 100 lines
- [ ] `GET /api/compose/files` returns discovered files when daemon starts from repo root
- [ ] `GET /api/compose/mounts` returns resolved absolute host paths
- [ ] All list pages have sort controls
- [ ] Graph nodes are clickable and navigate correctly
- [ ] CI runs on every PR

---

## Phase 1.5 — Networking USP & External API

> Runs **concurrently with Phase 2**. Differentiates DockerMap from generic container
> monitors and enables embedding in external dashboards (Homepage, Grafana, scripts).

### Stream A — External API Exposure

**A1. Configurable bind address & auth**
- `DOCKERMAP_BIND_ADDR` env var — default `127.0.0.1:4100`; set `0.0.0.0:4100` for
  external exposure
- `DOCKERMAP_API_TOKEN` — Bearer token middleware on Express BFF for all non-health
  endpoints
- `DOCKERMAP_CORS_ORIGINS` — comma-separated allowed origins
- Document risks in `docs/SECURITY.md`

**A2. OpenAPI documentation**
- `docs/openapi.yaml` covering all v1 read-only endpoints (params, schemas, error codes)
- `GET /api/openapi.json` from Express BFF
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
  mutation endpoints

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

**C1. Tailscale status detection**
- Connect to `/var/run/tailscale/tailscaled.sock` (Tailscale local API)
- Parse peer list: `NodeKey`, `DNSName`, `TailscaleIPs`, `Online`, `Tags`
- Cache 30-second TTL; graceful no-op when Tailscale absent

**C2. Container ↔ peer correlation**
- Match by: container label `tailscale.hostname`/`tailscale.ip`, container name matching
  Tailscale DNS name, or `TS_AUTHKEY` env var presence
- Type: `TailscaleRecord { peer_name, tailscale_ip, container_name, online, tags }`

**C3. Headscale support**
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

- [ ] `GET /api/v1/status` returns 200 from a different host with `DOCKERMAP_BIND_ADDR=0.0.0.0`
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

**C1. `docs/SECURITY.md`** — threat model: host path exposure, symlink traversal, Docker
socket risk, external API risks.

---

### Phase 2 Verification

- [ ] Each validation rule has passing and failing tests
- [ ] `GET /api/compose/validate` returns structured JSON matching contracts
- [ ] Diagnostics page renders and groups by severity
- [ ] `Blocked` severity will gate edits in Phase 3

---

## Phase 3 — Editing Workflow

> **Prerequisite:** Phase 2 complete. `Blocked` diagnostics must gate writes.
> Mutation endpoints require `DOCKERMAP_EDITS_ENABLED=true` flag + API token.

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

### Stream B — Mutation API

**B1.** `POST /daemon/compose/edit/preview` (feature-flagged) → `EditPlan` with diff

**B2.** `POST /daemon/compose/edit/apply` body `{ plan_id, confirm: true }` →
`ApplyResult { backup_path, applied_at, rollback_command }`; max 1 concurrent write

**B3.** BFF proxy for mutation routes; append each apply to `apps/api/src/audit.log`

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
- Navigation: all cross-page links from `PAGE_LOGIC.md`
- Add Playwright job to CI workflow
- New directory: `tests/e2e/`

---

## Phase 5 — Runtime Enrichment

> **Prerequisite:** Phase 1 complete (bind mount field + correlation).

### Stream A — Container Metrics

**A1.** Background task polling bollard `stats()` every 5 seconds; store
`ContainerMetrics { cpu_percent, memory_mb, memory_limit_mb }` with per-container cache.

**A2.** `GET /daemon/containers/:name/metrics`

**A3.** CPU/memory bars in ContainerDetail; `sort=cpu`/`sort=memory` on Containers page.
New file: `crates/dockermap-daemon/src/metrics.rs`

---

### Stream B — Drift Detection

**B1.** Compare `ContainerRecord.bind_mounts` (bollard) vs `ComposeMountDeclaration` per
service → `DriftReport { matched, only_in_compose, only_in_runtime }`.

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
| 1-C | `apps/web/src/App.tsx` | Split into hooks/, utils/, components/, pages/ |
| 1-E | `.github/workflows/ci.yml` | Publish CI workflow |
| 1.5-A | `apps/api/src/index.ts` | Auth middleware, CORS, rate limiting, versioned routes |
| 1.5-A | `docs/openapi.yaml` | OpenAPI spec |
| 1.5-B | `crates/dockermap-core/src/` | Add network enrichment, proxy route parsing |
| 1.5-C | `crates/dockermap-daemon/src/tailscale.rs` | Tailscale/Headscale integration (new) |
| 2-A | `crates/dockermap-core/src/validation/` | New module: rules, severity, diagnostic output |
| 2-B | `apps/web/src/pages/DiagnosticsPage.tsx` | New page |
| 3-A | `crates/dockermap-core/src/editing/` | New module: planner, diff, writer |
| 3-B | `crates/dockermap-daemon/src/main.rs` | Add mutation routes (feature-flagged) |
| 5-A | `crates/dockermap-daemon/src/metrics.rs` | New: bollard stats polling |
| 6 | `crates/dockermap-cli/` | New crate |
