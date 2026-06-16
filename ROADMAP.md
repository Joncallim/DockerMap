# DockerMap Roadmap

## Vision

DockerMap helps developers understand and safely manage Docker environments by making
**networking the primary insight layer**. Unlike generic container monitors, DockerMap
focuses on the *relationships* between services — Docker networks, bind mounts, named
volumes, reverse-proxy domain routing, and VPN mesh (Tailscale/Headscale) connectivity
— and exposes all of this through a stable, versioned API that external dashboards
(Homepage, Grafana, custom scripts) can consume.

The three questions DockerMap should always answer clearly:

1. What host paths, container paths, named volumes, and Compose-file declarations exist,
   and how are they connected?
2. How do services communicate — which Docker networks, which domains, which Tailscale
   peers?
3. What will change if I edit a mount or routing rule, and is that change safe?

---

## Guiding Principles

- **Read first, edit second.** Every mutation requires a diff preview and explicit
  confirmation.
- **Networking is the USP.** Surface Docker network topology, reverse-proxy domains,
  Tailscale/Headscale peers, and reverse DNS — things other monitors ignore.
- **API-first.** Every insight available in the UI must be available via a versioned,
  documented REST endpoint for external dashboard integration.
- **Confidence before writes.** Validation, dry-run, backup, and rollback guidance must
  exist before any Compose file is modified.
- **Structured parsers, not string edits.** Use typed YAML and Compose parsers; never
  perform regex-based file edits.
- **Opt-in exposure.** The daemon binds loopback by default. External access is explicitly
  configured, requires an API token, and is documented as privileged.

---

## Current Status

### ✅ Phase 0 — Foundation (Done)

- Monorepo: React/Vite frontend (port 3233), Express BFF (port 4000), Rust Axum daemon
  (port 4100)
- Rust toolchain pinned at 1.88.0; `Cargo.lock` committed
- `dockermap-core` crate: domain model, mock snapshot, `derive_images`, `derive_graph`,
  `mock_logs`
- `dockermap-daemon`: bollard integration, mock fallback when Docker unavailable
- Seven React pages: Dashboard, Containers, ContainerDetail, Images, Networks, Volumes,
  Logs
- `@dockermap/contracts` TypeScript types mirroring Rust structs
- SSE heartbeat for live refresh; global search with 250 ms debounce
- CI template at `docs/ci/github-actions-ci.yml` (not yet published)
- Compose test fixtures at `tests/fixtures/compose/`
- Architecture docs: `ARCHITECTURE.md`, `PAGE_LOGIC.md`
- Vite 8, zero production audit vulnerabilities

### 🔄 Phase 1 — Partially Done

**Working:** Docker runtime inventory (containers, images, networks, volumes, logs), all
read-only API endpoints, React UI with routing, SSE live refresh, mock fallback, graph
derivation.

**Not yet done:** Compose file parsing, CLI commands, frontend component splitting
(all 709 lines in `App.tsx`), table sorting, advanced filters, clickable graph nodes,
container labels/ports, log level filter, live tail, contract generation.

---

## Roadmap

Work within each phase is split into **concurrent streams**. Streams within a phase are
independent and can be assigned to different developers or worked in parallel. Sequential
dependencies within a stream are noted explicitly.

---

### Phase 1 — Read-Only Map Completion

> **Goal:** Complete the read-only inventory experience and add Compose file awareness.

#### Stream A — Rust: Compose Parsing (sequential within stream)

**A1. Add Compose domain types to `dockermap-core`**
- `ComposeFile`, `ComposeService`, `ComposeMountDeclaration` (discriminated union of
  `BindMount`, `NamedVolume`, `AnonymousVolume`), `ComposeProject`, `ComposeDiagnostic`
- All types derive `Serialize/Deserialize` with `rename_all = "camelCase"`
- File: new `crates/dockermap-core/src/compose/mod.rs`

**A2. Implement YAML parser** _(depends on A1)_
- Parse `services.<name>.volumes[]` in both short form (`./src:/app:ro`) and long form
  (`type: bind`, `source:`, `target:`, `read_only:`)
- Parse top-level `volumes:` keys; `depends_on` in list and condition forms
- Emit `ComposeDiagnostic` for unrecognised fields rather than silently discarding
- Add `serde_yaml = "0.9"` to `Cargo.toml`
- Unit tests for every syntax form in `tests/fixtures/compose/path-mapping.compose.yaml`

**A3. Path resolution** _(depends on A2)_
- Resolve relative host paths against the Compose file's own directory
- Expand `${VAR:-default}` and `${VAR}` with env substitution; emit
  `ComposeDiagnostic(Warning)` for unresolved references
- Store both raw source value and resolved absolute path on each mount declaration

**A4. Compose file discovery** _(depends on A1)_
- Walk directories for `docker-compose.yml`, `docker-compose.yaml`, `compose.yml`,
  `compose.yaml` using the `walkdir` crate
- Detect override files; support explicit `-f` path argument
- Respect `.dockerignore` and `node_modules/` exclusions

**A5. Override file merging** _(depends on A2, A4)_
- Merge services per Compose spec: volumes append, environment maps merge, image replaces
- Test with `tests/fixtures/compose/override.compose.yaml`

**A6. Compose ↔ runtime correlation** _(depends on A2, existing bollard integration)_
- Match Compose service names to containers via `com.docker.compose.service` label
- Produce `MountCorrelation { declared_source, runtime_source, status }` for each mount
- Store on `ContainerRecord` or return from a dedicated endpoint

**A7. Daemon Compose endpoints** _(depends on A1–A5)_
- `GET /daemon/compose/files` — discovered files with parse status
- `GET /daemon/compose/mounts` — all resolved mount declarations
- `GET /daemon/compose/projects` — top-level project aggregates

**A8. Cursor-based log pagination** _(independent — do any time)_
- Accept `cursor` and `limit` query params in `GET /daemon/logs`
- Return opaque base64 cursor in `LogsResponse.nextCursor`

#### Stream B — Node/Express: Proxies & Contract Hardening

**B1. Proxy new Compose endpoints through `apps/api`** _(depends on A7)_
- Add `/api/compose/files`, `/api/compose/mounts`, `/api/compose/projects`
- Add mock fallback responses seeded from fixture data

**B2. Contract compatibility tests**
- Serialize Rust mock snapshot to JSON in a `#[test]`; write to
  `tests/fixtures/snapshots/mock-snapshot.json`
- Add a TypeScript test in `packages/contracts` that loads the JSON and validates it
  against each interface
- Prevents silent drift between Rust and TypeScript types

**B3. Add Compose types to `@dockermap/contracts`**
- Mirror `ComposeMountDeclaration`, `ComposeFile`, `ComposeProject`, `ComposeDiagnostic`

**B4. Individual resource detail endpoints**
- `GET /daemon/images/:imageRef` — full tag list, size, created date, using containers
- `GET /daemon/networks/:id` — IPAM config, subnet, gateway, attachability
- `GET /daemon/volumes/:name` — mountpoint, driver options, labels

**B5. Publish CI workflow**
- Copy `docs/ci/github-actions-ci.yml` → `.github/workflows/ci.yml`
- Trigger on every push and pull request

**B6. Remove Python legacy**
- Delete `legacy/python-prototype/`; update `ARCHITECTURE.md`

#### Stream C — Frontend: Component Decomposition (sequential within stream)

> Highest-urgency frontend task — blocks all of Stream D.

**C1–C5. Split `App.tsx` (709 lines) into separate files**
- Extract hooks → `apps/web/src/hooks/` (`useApiResource`, `useDaemonHeartbeat`,
  `useSearchParamState`)
- Extract utilities → `apps/web/src/utils/` (`api.ts`, `format.ts`)
- Extract primitives → `apps/web/src/components/` (`StatePanel`, `EmptyPanel`, `KpiCard`,
  `InfoCard`, `GraphNodeCard`)
- Extract pages → `apps/web/src/pages/` (one file per page)
- Reduce `App.tsx` to under 80 lines (imports + `AppShell` + `<Routes>`)
- Zero behaviour change; `npm run typecheck` must pass after each step

#### Stream D — Frontend: Feature Gaps (depends on C5; sub-tasks are parallel)

**D1. Table sorting** — `sort` + `dir` query params on all list pages (name, status,
image, age, count); add sort direction indicator.

**D2. Advanced filtering** — containers: network/image/stack pills; images: in-use/unused/
dangling; networks: driver, empty; volumes: attached/unattached.

**D3. Clickable graph nodes** — container nodes → `/containers/:name`; network nodes →
`/networks?network=id`; volume nodes → `/volumes?volume=name`.

**D4. Container detail enrichment** — labels key/value table, formatted port bindings,
volume section, restart policy.

**D5. Networks page: IPAM detail** — show subnet, gateway, and per-member container IPs.

**D6. Volumes page: driver & mountpoint** — show driver, mountpoint, scope; mark
unattached volumes as prune candidates.

**D7. Logs: level filter, live tail, pagination** — level dropdown, auto-scroll toggle,
"Load more" cursor button (requires B stream cursor pagination).

**D8. Compose UI** _(depends on B1)_ — new `/compose` page: discovered files, mount
table (host path → container path → service → file:line), named vs bind visual coding.

**D9. Dashboard: search-aware graph** — dim nodes that don't match `q`; highlight matches.

#### Phase 1 Verification

- [ ] `cargo test` passes, including new Compose parser unit tests
- [ ] `npm run typecheck` passes across all workspaces
- [ ] `App.tsx` under 100 lines
- [ ] `GET /api/compose/files` returns discovered files when daemon starts from repo root
- [ ] Containers, Images, Networks, Volumes pages have sort controls
- [ ] Graph nodes are clickable and navigate correctly
- [ ] CI workflow runs on every PR

---

### Phase 1.5 — Networking USP & External API

> **Goal:** Differentiate DockerMap from generic Docker monitors. Surface Docker network
> topology, reverse-proxy domain routing, and Tailscale/Headscale VPN connectivity.
> Expose everything via a versioned, documented REST API for external dashboard
> integration. Runs **concurrently with Phase 2**.

#### Stream A — External API Exposure

**A1. Configurable bind address & CORS**
- `DOCKERMAP_BIND_ADDR` env var (default `127.0.0.1:4100`; set `0.0.0.0:4100` for
  external)
- `DOCKERMAP_API_TOKEN` → Bearer token auth middleware on the Express BFF for all
  non-health endpoints
- `DOCKERMAP_CORS_ORIGINS` env var (comma-separated allowed origins)
- Add to `SECURITY.md`: risks of external binding, Docker socket privileges

**A2. OpenAPI documentation**
- Hand-crafted `docs/openapi.yaml` covering all v1 read-only endpoints (params, response
  schemas, error codes)
- Serve `GET /api/openapi.json` from the Express BFF
- Serve `GET /api/docs` using `swagger-ui-dist` for browser-accessible Swagger UI

**A3. API versioning**
- Prefix all routes with `/api/v1/` (keep unversioned `/api/` as alias)
- Add `X-DockerMap-Version` response header on every response
- Add `GET /api/v1/status` (no auth): `{ version, uptime_seconds, docker_reachable,
  compose_files_found, mode }`

**A4. Homepage-compatible widget endpoint**
- `GET /api/widgets/homepage` (no auth): `{ status, containers: { running, stopped,
  total }, networks: N, images: N, errors: N }`
- Document Homepage widget config in README (URL, title, icon)

**A5. Rate limiting**
- Add `express-rate-limit`: 120 req/min per IP on read endpoints; 10 req/min on future
  mutation endpoints

#### Stream B — Docker Network Deep Dive

**B1. IPAM enrichment in network records**
- Pull `Ipam.Config[].Subnet`, `Gateway`, `IPRange` from bollard network inspect
- Add `ipam: { subnet, gateway, ip_range }` to `NetworkRecord`
- Add `container_ip: string` to each container's network membership entry
- Networks page: show each member container with its IP inside that network

**B2. Cross-network gateway detection**
- Detect containers that span ≥ 2 networks → candidate gateway/proxy containers
- Infer `role: "gateway" | "service" | "database" | "cache"` from network membership
  + image name heuristics (`nginx`, `traefik`, `caddy`, `postgres`, `redis`, etc.)
- Dashboard graph: render gateway-role containers with a distinct visual treatment

**B3. Port exposure map**
- Extend `ContainerRecord.ports` to include `host_ip`, `host_port`, `container_port`,
  `protocol`, `publicly_exposed` (`host_ip == "0.0.0.0"` or `"::"`)
- `GET /daemon/ports` — all publicly exposed ports across all containers
- Dashboard: "Exposed Ports" summary table; add port-based search

**B4. Reverse proxy label parsing**
- Parse Traefik labels: `traefik.http.routers.<name>.rule=Host(\`domain\`)`,
  `traefik.http.services.<name>.loadbalancer.server.port`
- Parse Nginx Proxy Manager labels; parse Caddy labels
- New type `ProxyRoute { domain, container_name, port, tls, provider }`
- `GET /daemon/proxy-routes` endpoint
- New `/domains` page: domain → container → port table; TLS indicator
- Container detail: "Domains" section listing all routes pointing to that container

**B5. Reverse DNS resolution**
- For each container IP (from IPAM), perform PTR lookup via `trust-dns-resolver` or
  system resolver
- Cache with 5-minute TTL
- Show `resolved_hostname` alongside IP in Networks page and container detail

#### Stream C — Tailscale / Headscale Integration

**C1. Tailscale status detection**
- Attempt connection to Tailscale local API socket
  (`/var/run/tailscale/tailscaled.sock`)
- Parse peer list: `NodeKey`, `DNSName`, `TailscaleIPs`, `Online`, `Tags`
- Cache with 30-second TTL
- Graceful no-op when Tailscale not present

**C2. Container ↔ Tailscale peer correlation**
- Match peers to containers by label (`tailscale.hostname` / `tailscale.ip`), container
  name matching Tailscale DNS name, or presence of `TS_AUTHKEY` env var
- Produce `TailscaleRecord { peer_name, tailscale_ip, container_name, online, tags }`

**C3. Headscale support**
- Accept `DOCKERMAP_HEADSCALE_URL` and `DOCKERMAP_HEADSCALE_API_KEY` env vars
- Query `GET /api/v1/machine` on the Headscale server; same correlation logic as C2

**C4. Tailscale/Headscale daemon endpoints**
- `GET /daemon/tailscale/peers` — peers with container correlation
- `GET /daemon/tailscale/status` — overall connectivity, exit node, online count

**C5. Tailscale UI**
- Dashboard: "VPN-accessible containers" section (hidden when Tailscale not detected)
- Container detail: Tailscale badge + Tailscale IP when peer is correlated
- New `/tailscale` page: peer list, online status, ACL tags, container links
- Graceful "Tailscale not detected" empty state

#### Stream D — Network Visualization Upgrade

**D1. Graph view selector**
- Dashboard: toggle between "Docker Topology", "Network View", "Domain View",
  "VPN/Tailscale View"
- Docker Topology: existing container/network/volume graph
- Network View: containers grouped by Docker network; IPs shown; gateway containers
  highlighted
- Domain View: reverse-proxy routes as nodes; domain → container → port flow
- VPN View: Tailscale/Headscale peers mapped to containers (shown only when VPN detected)

**D2. Replace CSS-grid graph with force-directed layout**
- Install `d3-force` or `@xyflow/react`
- Render nodes at computed positions with SVG edges
- Container nodes: colour by status; network nodes: teal; volume nodes: amber; domain
  nodes: purple; VPN nodes: green
- Zoom/pan; click to navigate; hover tooltip with status summary

#### Phase 1.5 Verification

- [ ] `GET /api/v1/status` returns 200 from a different host when bind addr is `0.0.0.0`
- [ ] `GET /api/widgets/homepage` returns expected structure; documented in README
- [ ] `GET /api/docs` renders Swagger UI covering all read-only endpoints
- [ ] Networks page shows per-member container IPs
- [ ] Gateway-role containers are visually distinct in the graph
- [ ] Traefik label parser correctly extracts domains from test fixtures
- [ ] `/domains` page renders detected proxy routes
- [ ] If Tailscale present: `/tailscale` page and container badges work
- [ ] If Tailscale absent: no errors; graceful empty state shown

---

### Phase 2 — Validation & Diagnostics

> **Goal:** Make DockerMap a trusted audit tool.
> **Prerequisite:** Phase 1 Compose parsing (A1–A3) complete.
> Streams run concurrently.

#### Stream A — Rust Validation Engine

**A1. `ValidationRule` trait in `dockermap-core`**
- `fn check(&self, project: &ComposeProject) -> Vec<ComposeDiagnostic>`
- One concrete struct per rule; independently testable

**A2. Validation rules** (each can be a separate PR)
- `MissingHostPath` — `fs::metadata(host_path)` check → `Error`
- `DuplicateContainerTarget` — two mounts same `target` per service → `Error`
- `AmbiguousRelativePath` — `../..` traversal above project root → `Warning`
- `ReadWriteMismatch` — declared `read_only: false` but host path unwritable → `Warning`
- `PathTraversal` — escapes configured `projectRoot` policy → `Error`
- `UnresolvedEnvVar` — `${VAR}` with no default and not in env → `Error`

**A3. Severity model & machine-readable output**
- `Severity` enum: `Info | Warning | Error | Blocked`
- `GET /daemon/compose/validate` → `{ rules, diagnostics, summary: { errors, warnings,
  info } }`

**A4. Malformed fixture tests**
- Add `tests/fixtures/compose/invalid/` with: missing path, duplicate target, unresolved
  var, path traversal
- `#[test]` for each asserting expected severity and kind

#### Stream B — API & UI for Diagnostics

**B1.** Proxy `GET /api/compose/validate`; add mock response.

**B2.** Add `/diagnostics` page: severity-grouped table, filter by severity/file/rule.

**B3.** Severity count badges on nav items; error outline on graph nodes with issues.

**B4.** Fifth KPI card on Dashboard: total errors and warnings from validation.

**B5.** `GET /api/diagnostics?format=json` for CI consumption; "Export JSON" button in UI.

#### Stream C — Security & Docs

**C1. `SECURITY.md`** — threat model: host path exposure, symlink traversal, Docker
socket risk, edit permissions, external API exposure risks.

#### Phase 2 Verification

- [ ] Each validation rule has a passing and a failing test
- [ ] `GET /api/compose/validate` returns structured JSON matching contracts type
- [ ] Diagnostics page renders and groups by severity
- [ ] `Blocked` severity prevents editing (enforced in Phase 3)

---

### Phase 3 — Editing Workflow

> **Goal:** Safe, reversible Compose file editing with diff preview.
> **Prerequisite:** Phase 2 complete. `Blocked` diagnostics must gate all writes.
> **Security:** Mutation endpoints require `DOCKERMAP_EDITS_ENABLED=true` flag and API
> token auth.

#### Stream A — Rust Edit Engine (sequential within stream)

**A1. YAML round-trip parsing**
- Parse with `serde_yaml::Value` (generic, preserves structure) rather than typed structs
- Round-trip test: parse → re-serialize → must match input byte-for-byte (ignoring
  trailing whitespace)
- Use `similar` crate for unified diff generation

**A2. Dry-run edit plan**
- `EditRequest { file, service, mount_index, new_source?, new_target?, new_mode? }`
- Run all Phase 2 validation checks on the proposed state
- Return 400 if any `Blocked` diagnostic; otherwise return `EditPlan { diff_lines,
  validation_result }`

**A3. Write with backup**
- Copy original to `<filename>.dockermap.bak` in same directory
- Write new content to temp file; atomic rename
- Git-aware warning: if file has uncommitted changes, add `Warning` to `EditPlan`
- Return `EditResult { backup_path, rollback_command, applied_at }`

#### Stream B — Mutation API

**B1. `POST /daemon/compose/plan-edit`** — requires feature flag; returns `EditPlan`

**B2. `POST /daemon/compose/apply-edit`** — body `{ plan_id, confirm: true }`; returns
`EditResult`; max 1 concurrent write (mutex)

**B3. BFF proxy** — proxy mutation routes; log each apply to an audit log file with
timestamp and summary

#### Stream C — Frontend Edit UI

**C1. Edit action on mount rows** — "Change path" opens diff preview modal

**C2. Diff viewer component** — colour-coded `+`/`-` lines; no third-party renderer
needed

**C3. Confirmation flow** — "Apply" sends apply-edit; toast on success/failure; shows
backup path

#### Phase 3 Verification

- [ ] Dry-run returns valid unified diff for all mount types in fixture
- [ ] Write creates `.dockermap.bak`; original is correctly modified
- [ ] Editing endpoints return 403 without feature flag
- [ ] `Blocked` diagnostics prevent apply
- [ ] No write occurs without explicit "Apply" click after diff review

---

### Phase 4 — Visual & UX Polish

> **Goal:** Delightful, demo-ready interface with E2E test coverage.
> **Can begin concurrently with Phase 3.**

**Theme toggle** — dark/light; persisted to `localStorage`; CSS custom property override.

**Keyboard shortcuts** — `g/c/i/n/v/l` for nav; `/` to focus search; `?` for cheatsheet.

**Force-directed graph** — replace CSS-grid with D3 or React Flow spatial layout (can
reuse work from Phase 1.5 Stream D2).

**Accessibility** — `aria-label` and `role` on all interactive elements; axe-core audit.

**Playwright E2E tests**
- Install `@playwright/test`; target mock stack
- Smoke tests: dashboard KPIs, containers filter, detail navigation, logs filter
- Navigation cross-page tests per `PAGE_LOGIC.md` cross-page rules
- Add Playwright job to CI workflow

#### Phase 4 Verification

- [ ] Theme toggle persists across reload
- [ ] Graph renders with spatial layout and SVG edges
- [ ] All interactive elements have accessible labels
- [ ] Playwright suite passes in CI

---

### Phase 5 — Runtime Enrichment

> **Goal:** Live metrics and drift detection.
> **Prerequisite:** Phase 1 complete (specifically bind mount field on `ContainerRecord`
> and Compose ↔ runtime correlation).

#### Stream A — Container Metrics

**A1.** Background task polling bollard `stats()` every 5 seconds per running container;
store `ContainerMetrics { cpu_percent, memory_mb, memory_limit_mb }` in cache.

**A2.** `GET /daemon/containers/:name/metrics` endpoint.

**A3.** CPU and memory bars in ContainerDetail UI; `sort=cpu`/`sort=memory` on Containers
page.

#### Stream B — Drift Detection

**B1.** Compare `ContainerRecord.bind_mounts` (actual bollard data) against
`ComposeMountDeclaration` per service → `DriftReport { matched, only_in_compose,
only_in_runtime }`.

**B2.** `GET /daemon/compose/drift` endpoint.

**B3.** Drift badge on ContainerDetail; Drift section on Diagnostics page.

#### Phase 5 Verification

- [ ] Metrics render in ContainerDetail and update on heartbeat
- [ ] Drift report correctly identifies a mount declared but not mounted
- [ ] Drift badge appears on affected containers

---

### Phase 6 — Collaboration & Release

> **Prerequisite:** Phases 1–5 largely complete.

**CLI package** — add `crates/dockermap-cli` with `clap`: `scan`, `validate`, `export`,
`report` subcommands.

**Saved reports** — `GET /api/v1/report?format=json|html` for CI artifact consumption;
fail CI if any `Error` severity diagnostic.

**Release workflow** — `.github/workflows/release.yml` triggered on `v*` tags; build
daemon + CLI binaries for linux-x86_64, linux-aarch64, macos-aarch64; publish as GitHub
Release assets.

**Changelog** — `CHANGELOG.md` in Keep a Changelog format; document every breaking API
change.

**npm publish for contracts** — add `publishConfig.access: public` to
`packages/contracts`; publish on release.

---

## Backlog / Stretch Goals

Ordered by expected value. No hard phase gate unless noted.

| Priority | Item | Notes |
|---|---|---|
| High | Contract generation | Replace manual TypeScript mirror with `typeshare` or `schemars` + TS emit; add CI diff check |
| High | `.env` interpolation | Load `.env`, substitute `${VAR}` in Compose before parsing; warn on missing vars |
| High | Compose override merging UI | Show merged service view with per-field source annotations |
| Medium | Dockerfile path extraction | Parse `WORKDIR`, `COPY`, `VOLUME` from Dockerfiles; correlate with Compose `build:` context |
| Medium | Export to Mermaid / Graphviz | `GET /api/v1/graph?format=mermaid|dot`; useful for README/wiki embedding |
| Medium | Integration tests with live Docker | `DOCKERMAP_INTEGRATION_TESTS=true` job; spin up fixture Compose project, assert on output |
| Medium | Policy file for allowed host roots | `.dockermap.policy.yaml`: `allowedHostRoots: [...]`; `PathTraversal` rule checks against it |
| Low | Path normalization (Windows/WSL/macOS) | `C:\Users\...` → `/mnt/c/...` in WSL; macOS Docker Desktop path translation |
| Low | Named volume lifecycle hints | Detect compose-declared volumes never created; Docker volumes not referenced in any file |
| Low | "Explain this mount" AI command | `POST /api/v1/explain`; plain-English explanation of a mount/volume; Claude API integration |
| Low | Multi-project view | Scan multiple project directories; detect cross-project volume sharing |
| Low | Desktop wrapper (Tauri) | Only after core product is stable; native tray, auto-start |
| Low | AdGuard / Pi-hole DNS awareness | Query local DNS server for container hostname records; surface in network view |
| Low | WireGuard peer mapping | Similar to Tailscale but via `wg show` output parsing |

---

## Dependency Graph

```
Phase 0 (done)
  │
  ▼
Phase 1 ──────────────── concurrent ─────────────── Phase 1.5
  Stream A (Rust compose parsing)                    Stream A (external API)
  Stream B (Node proxies + contracts)                Stream B (network deep dive)
  Stream C (App.tsx decomposition)                   Stream C (Tailscale/Headscale)
  Stream D (frontend features)        ◄─────────── Stream D (graph upgrade)
  │
  ▼
Phase 2 (validation)  ────────── concurrent ─────── Phase 4 (polish + E2E)
  Stream A (Rust rules)                              Theme, keyboard, Playwright
  Stream B (diagnostics UI)
  Stream C (security docs)
  │
  ▼
Phase 3 (editing)  ─────────── concurrent ──────── Phase 5 (metrics + drift)
  Stream A (Rust edit engine)                       Stream A (bollard stats)
  Stream B (mutation API)                           Stream B (drift detection)
  Stream C (diff preview UI)
  │
  ▼
Phase 6 (CLI + release)
```

**Critical path within Phase 1:**
`C1→C2→C3→C4→C5` (App.tsx decomposition) must complete before Stream D. Stream A
(Compose parsing) is the foundation for Phases 2, 3, and 5 — start it in parallel with
Stream C.

**Highest-leverage first actions today:**
1. Split `App.tsx` (unblocks all frontend feature work)
2. Add Compose domain types to `dockermap-core` (unblocks everything downstream)
3. Publish CI workflow to `.github/workflows/` (gives automated verification on every PR)

---

## Security & Reliability Priorities

- Do not write to Compose files without showing a diff and requiring explicit confirmation.
- External API binding (`0.0.0.0`) requires explicit env var opt-in and an API token.
- Docker socket access is privileged; document the risk before each release.
- Never silently ignore unsupported Compose syntax; emit structured diagnostics.
- Do not follow symlinks for path validation unless behaviour is explicitly specified.
- Validate path edits against project root policy when configured.
- Rate-limit external API access; treat every unauthenticated request as untrusted.
- Add regression fixtures for every supported Compose syntax form.

---

## MVP Definition of Done

A user can:

1. Run DockerMap against a Compose project and see all detected bind mounts, named
   volumes, and exposed ports in the UI.
2. See which domains (Traefik/NPM labels) route to which containers.
3. See container IPs within each Docker network.
4. Get validation diagnostics for missing host paths and duplicate container targets.
5. Hit `GET /api/v1/status` and `GET /api/widgets/homepage` from another machine (with
   `DOCKERMAP_BIND_ADDR=0.0.0.0` set) and embed the data in a Homepage dashboard.
6. Preview a Compose path change as a unified diff before applying it.
7. Export diagnostics as JSON for CI integration.

The project has CI, fixture tests, documented setup, and no edit command writes changes
without a dry-run preview.
