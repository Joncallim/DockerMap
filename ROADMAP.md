# DockerMap Roadmap

## Product Vision

DockerMap helps developers understand and safely navigate Docker infrastructure — not just containers and volumes, but the **full network topology**: which services talk to which, what domains route to what, which containers are reachable over VPN, and how everything connects.

The product answers four questions clearly:

1. What containers, networks, volumes, and host paths exist and how are they connected?
2. Which host paths, bind mounts, and named volumes are declared in Compose files — and are they correct?
3. How is traffic actually routed to containers (reverse proxy domains, Tailscale VPN, exposed ports)?
4. What will change if a path or configuration is edited?

**USP over generic Docker monitors:** DockerMap's differentiator is the **networking layer** — Docker internal topology, reverse-proxy domain mapping (Traefik, NGINX Proxy Manager, Caddy), Tailscale/Headscale VPN peer correlation, and reverse DNS resolution. Most Docker monitors show you containers; DockerMap shows you the full network map of how those containers connect to the world.

DockerMap also exposes a stable, documented external API so its data can feed into other dashboards (e.g., [Homepage](https://gethomepage.dev/)), monitoring stacks, and scripts — without needing a separate Docker monitoring tool.

---

## Target Users

- Developers maintaining Docker Compose environments who need to understand service dependencies and path mappings.
- Homelab operators running Traefik/NPM reverse proxies and Tailscale VPNs who want a single map of everything.
- Teams standardizing Compose files across services who need validation before editing.
- External dashboards (Homepage, Grafana, custom scripts) that want a lightweight Docker inventory API.

---

## Guiding Principles

- **Read first, edit second.** Every mutation requires a diff preview and explicit confirmation.
- **Networking is the map.** IPs, subnets, hostnames, domains, and VPN peers are first-class data — not footnotes.
- **Open API.** The daemon and BFF expose versioned, documented, token-authenticated endpoints consumable by third-party dashboards.
- **Preserve user formatting** when editing YAML. Isolate formatting changes when not feasible.
- **Treat path edits as potentially destructive.** Always back up, always show a diff.

---

## Architecture

```
Docker Engine ──────────────────────────────┐
                                            ▼
Tailscale Daemon (optional) ──── Rust Daemon (Axum, bollard) [4100]
                                            │
                                            ▼
                                 Node/Express BFF [4000]
                                 (proxy, SSE, auth, CORS)
                                            │
                               ┌────────────┴────────────┐
                               ▼                         ▼
                        React Web UI [3233]     External Consumers
                                             (Homepage, scripts, etc.)
```

- `crates/dockermap-core` — domain model, Compose parser, graph derivation, validation rules, edit planner
- `crates/dockermap-daemon` — Axum HTTP server, bollard Docker integration, Tailscale detection, caching
- `apps/api` — Express BFF: proxies daemon, adds SSE heartbeat, handles CORS/auth for browser + external access
- `apps/web` — React/Vite UI: graph, inventory, diagnostics, diff preview
- `packages/contracts` — TypeScript types mirroring Rust contracts

---

## Current Status

### ✅ Phase 0: Foundation (Complete)

- React/Vite frontend (port 3233), Express BFF (port 4000), Rust Axum daemon (port 4100)
- Rust toolchain pinned at 1.88.0, `Cargo.lock` committed
- `dockermap-core` with domain model, `derive_images`, `derive_graph`, `mock_logs`, mock snapshot
- `dockermap-daemon` using bollard with mock fallback when Docker is unavailable
- Seven React pages: Dashboard, Containers, ContainerDetail, Images, Networks, Volumes, Logs
- `@dockermap/contracts` TypeScript types
- SSE heartbeat via `/api/events/stream`, global search, live refresh
- CI template at `docs/ci/github-actions-ci.yml`
- Vite 8 upgrade, zero production audit vulnerabilities
- Docker Compose fixtures at `tests/fixtures/compose/`
- Architecture docs: `ARCHITECTURE.md`, `PAGE_LOGIC.md`

### 🔄 Phase 1: In Progress

Working:
- Docker runtime inventory (containers, images, networks, volumes, logs) via bollard ✅
- All read-only API endpoints ✅
- Graph derivation (nodes + edges) ✅
- Mock data fallback ✅

Not yet done:
- Compose file parsing and path resolution ❌
- Frontend component splitting (all 709 lines in `App.tsx`) ❌
- Table sorting and advanced filtering ❌
- Clickable graph nodes ❌
- CI published to `.github/workflows/` ❌
- Contract compatibility tests ❌
- Python legacy prototype removal ❌

---

## Phase 1: Read-Only Map Completion

> The four streams below can run fully concurrently.

### Stream A — Rust: Compose Parsing

**A1. Define Compose domain types in `dockermap-core`**
- `ComposeFile`, `ComposeService`, `ComposeMountDeclaration` (bind/named/anonymous/tmpfs discriminated union)
- `ComposeProject` top-level aggregate, `ComposeDiagnostic` with severity enum
- All types `Serialize/Deserialize` with `serde(rename_all = "camelCase")`

**A2. Implement Compose YAML parser**
- Add `serde_yaml` and `walkdir` dependencies
- Parse `services.<name>.volumes[]` in both short-form (`./src:/app:ro`) and long-form (`type: bind, source:, target:, read_only:`)
- Parse top-level `volumes:` for named volume declarations
- Parse `depends_on` (list and long-form with `condition:`)
- File: `crates/dockermap-core/src/compose/parser.rs`

**A3. Relative path resolution**
- Resolve `./src` against the Compose file's directory (not CWD)
- Handle `../` traversal, tracking for validation later
- Expand `${VAR:-default}` and `${VAR}` — substitute known env vars, emit `ComposeDiagnostic(Warning)` for unresolved ones
- Store raw source value and resolved absolute path in `ComposeMountDeclaration`
- File: `crates/dockermap-core/src/compose/resolver.rs`

**A4. Compose file discovery**
- Scan for `docker-compose.yml`, `docker-compose.yaml`, `compose.yml`, `compose.yaml`
- Accept explicit file path list or root directory
- Respect `node_modules/` exclusions via `walkdir` filters
- File: `crates/dockermap-core/src/compose/discovery.rs`

**A5. Override file merging**
- Merge `docker-compose.override.yml` alongside base file per Compose spec (volumes lists append, maps merge)
- Test against `tests/fixtures/compose/override.compose.yaml`

**A6. Runtime correlation**
- Match `ComposeMountDeclaration` to `ContainerRecord` instances by `com.docker.compose.service` label
- Track matched vs missing vs extra mounts (seeds Phase 5 drift detection)
- File: `crates/dockermap-core/src/compose/correlation.rs`

**A7. Compose daemon endpoints**
- `GET /daemon/compose/files` — discovered files with parse status
- `GET /daemon/compose/mounts` — all resolved mounts across all files
- `GET /daemon/compose/projects` — top-level aggregates

**A8. Extend `ContainerRecord` with bind mounts**
- bollard currently only extracts named volume names from `container.mounts`
- Also capture bind mounts: `mount.typ == MountTypeEnum::BIND` with host path + container path
- Add `bind_mounts: Vec<BindMount>` to `ContainerRecord`

**A9. BFF proxy + contract extension**
- Proxy new compose endpoints through `apps/api`
- Add `ComposeFile`, `ComposeService`, `ResolvedMount`, `ComposeDiagnostic` to `packages/contracts/src/index.ts`

---

### Stream B — Node/Express: API Hardening

**B1. Cursor-based log pagination**
- Accept `cursor` and `limit` query params on `GET /daemon/logs`
- Return `nextCursor` as opaque base64 token
- Update `LogsResponse` contract

**B2. Individual resource detail endpoints**
- `GET /daemon/images/:imageRef` — single image with full tag list, size, created date
- `GET /daemon/networks/:id` — network with IPAM, subnet, gateway, attachability
- `GET /daemon/volumes/:name` — volume with mountpoint, driver options, labels

**B3. Contract compatibility tests**
- Serialize mock snapshot in Rust `#[test]`, write to `tests/fixtures/snapshots/mock-snapshot.json`
- Add Vitest test in `packages/contracts` that parses the JSON and validates every TypeScript interface
- Catches Rust ↔ TypeScript drift automatically

**B4. Remove Python legacy**
- Delete `legacy/python-prototype/`
- Remove references from README and docs

---

### Stream C — Frontend: Component Decomposition

> This is the highest-priority frontend task — every other frontend feature is blocked until `App.tsx` is split.

**C1. Extract hooks** → `apps/web/src/hooks/`
- `useApiResource.ts`, `useDaemonHeartbeat.ts`, `useSearchParamState.ts`

**C2. Extract utilities** → `apps/web/src/utils/`
- `api.ts` (API_BASE, apiUrl, fetchJson), `format.ts` (formatTime)

**C3. Extract UI primitives** → `apps/web/src/components/`
- `StatePanel.tsx`, `EmptyPanel.tsx`, `KpiCard.tsx`, `InfoCard.tsx`, `GraphNodeCard.tsx`

**C4. Extract pages** → `apps/web/src/pages/`
- One file per page: Dashboard, Containers, ContainerDetail, Images, Networks, Volumes, Logs, NotFound

**C5. Reduce App.tsx to shell + routing**
- Target: under 80 lines — imports, `AppShell`, `<Routes>`, export

**C6. Verify** — `npm run typecheck` passes, all pages render correctly in both modes

---

### Stream D — Frontend: Feature Gaps (depends on C5)

Each sub-task is independent and can be parallelised across team members:

**D1. Table sorting** — sort by name/status/image/age on Containers; name/driver on Networks; name/attached on Volumes. Use `sort` and `dir` URL params.

**D2. Container page advanced filtering** — filter pills for network, image, stack (compose service label)

**D3. Image page filtering** — In use / Unused / Dangling filter pills

**D4. Network page filtering** — driver (bridge/overlay/host), internal/public, empty networks

**D5. Volume page filtering** — Attached / Unattached filter; mark unattached as prune candidates

**D6. Container detail: labels + formatted ports** — key/value table for labels; `host:port → container:port/proto` formatting

**D7. Network detail: IPAM data** — show subnet, gateway, container IPs within each network

**D8. Volume detail** — show mountpoint, driver, scope

**D9. Clickable graph nodes** — navigate to `/containers/:name`, `/networks?network=id`, `/volumes?volume=name` on click

**D10. Dashboard search integration** — dim graph nodes that don't match `q=` search param

**D11. Logs: level filter + live tail** — level dropdown (All/Info/Warn/Error); live tail toggle with auto-scroll

**D12. Logs: pagination UI** — "Load more" using `nextCursor` from B1

---

### Stream E — Infrastructure

**E1. Publish CI workflow** — copy `docs/ci/github-actions-ci.yml` to `.github/workflows/ci.yml`

**E2. Add Vitest** — add to `apps/web` and `packages/contracts`; wire `npm run test` into CI

**E3. Security documentation** — `docs/SECURITY.md`: Docker socket risk, loopback binding rationale, mutation prerequisites

---

### Phase 1 Verification

- [ ] `cargo test` passes including new Compose parser unit tests covering all four mount syntaxes from fixture
- [ ] `npm run typecheck` passes across all workspaces
- [ ] `App.tsx` is under 100 lines
- [ ] `GET /api/compose/mounts` returns resolved absolute paths for fixture files
- [ ] All graph nodes are clickable and navigate correctly
- [ ] Containers, Images, Networks, Volumes pages all have working sort controls
- [ ] CI runs on every push and passes

---

## Phase 1.5: Networking USP & External API

> This is a core differentiator phase. Runs concurrently with Phase 2.
> Goal: make DockerMap the best tool for understanding how containers connect to the world.

### Stream A — External API Exposure

**A1. Configurable bind address**
- Add `DOCKERMAP_DAEMON_BIND` env var (default `127.0.0.1:4100`, can be `0.0.0.0:4100`)
- Add `DOCKERMAP_API_TOKEN` to gate external access with `Authorization: Bearer <token>` middleware in the Express BFF
- Add `DOCKERMAP_CORS_ORIGINS` env var (comma-separated allowed origins) for browser-based external access
- Document all env vars in `README.md` and `SECURITY.md`

**A2. API versioning**
- Prefix all routes with `/api/v1/` (keep `/api/` aliases for backwards compat)
- Add `X-DockerMap-Version` response header
- Protects external integrations from silent breaking changes

**A3. OpenAPI specification**
- Add `utoipa` crate to generate OpenAPI 3.1 from Rust handler annotations, or handcraft `docs/openapi.yaml`
- Serve `GET /api/openapi.json` from the BFF
- Serve `GET /api/docs` with embedded Swagger UI (via `swagger-ui-dist` npm package)
- All read-only endpoints fully documented with request params, response schemas, error codes

**A4. Homepage-compatible widget endpoint**
- [Homepage](https://gethomepage.dev/) supports custom JSON API service widgets
- Add `GET /api/widgets/homepage` returning:
  ```json
  {
    "containers": { "running": 5, "stopped": 1, "total": 6 },
    "images": 8,
    "networks": 3,
    "volumes": 2,
    "status": "ok"
  }
  ```
- Document widget configuration in `README.md`

**A5. Rate limiting and uptime monitoring support**
- Add `express-rate-limit`: 100 req/min per IP on all read endpoints
- `GET /api/health` always returns 200 without auth (for uptime monitors like Uptime Kuma)
- Add `GET /api/v1/status` with `{ version, uptime_seconds, docker_reachable, compose_files_found, tailscale_detected }`

---

### Stream B — Docker Network Topology Enrichment

**B1. Container IPs per network**
- Pull IPAM data from bollard network inspect: subnet, gateway, IP range
- Add `container_ip: string` to each network membership in `ContainerRecord`
- Add `ipam: { subnet, gateway, ip_range }` to `NetworkRecord`
- Networks page: show each member container with its assigned IP

**B2. Gateway container detection**
- Detect containers that span multiple networks (multi-homed containers are usually reverse proxies or API gateways)
- Derive `role: "gateway" | "service" | "database" | "cache" | "proxy"` from: network membership count, image name patterns (`nginx`, `traefik`, `caddy`, `postgres`, `redis`, `mongo`)
- Surface gateway nodes differently in Dashboard graph (larger, different shape/color)

**B3. Port exposure map**
- Extend `ContainerRecord.ports` with `host_ip`, `host_port`, `container_port`, `protocol`, `publicly_exposed: bool`
- `publicly_exposed = true` when `host_ip == "0.0.0.0"` or `"::"`
- Add "Exposed to Host" section on Dashboard: table of all publicly exposed ports
- Add port search: `GET /api/containers?port=443` returns containers exposing that port

**B4. Reverse proxy label parsing**

Scan container labels for routing rules from common reverse proxies:

- **Traefik**: `traefik.http.routers.<name>.rule=Host(\`domain.com\`)` → extract domain
- **NGINX Proxy Manager**: `nginx-proxy=domain.com` / `VIRTUAL_HOST=domain.com`
- **Caddy**: `caddy=domain.com` label
- Produce `ProxyRoute { domain, container_name, container_port, tls: bool, provider: "traefik" | "npm" | "caddy" | "nginx-proxy" }`
- `GET /daemon/proxy-routes` endpoint returning all detected routes
- New `/domains` page: domain → container mapping table with TLS badge and provider icon
- Container detail: "Routes to this container" section listing detected domains

**B5. Reverse DNS for container IPs**
- For each container IP (from IPAM enrichment), perform PTR record lookup via `trust-dns-resolver` or system resolver
- Cache results with 5-minute TTL
- Add `resolved_hostname?: string` to network membership data
- Show in Networks page alongside IP; show in Container detail

---

### Stream C — Tailscale / Headscale Integration

**C1. Tailscale status detection**
- Check if `tailscaled` is running via the Tailscale local API socket (`/var/run/tailscale/tailscaled.sock`) or by spawning `tailscale status --json`
- Parse peer list: `{ NodeKey, DNSName, TailscaleIPs, Online, Tags, ExitNode }`
- Cache with 30s TTL
- Graceful no-op when Tailscale is not present (no errors, feature simply absent)

**C2. Container ↔ Tailscale peer correlation**
Match peers to containers by:
1. Container label `tailscale.hostname` or `tailscale.ip`
2. Container name matching Tailscale DNS name (e.g., `my-app` matches `my-app.tail12345.ts.net`)
3. Container using `tsnet` (has `TS_AUTHKEY` in environment)

Produce `TailscaleCorrelation { peer_name, tailscale_ips, magic_dns, container_name, online, tags }`

**C3. Headscale support**
- Accept `DOCKERMAP_HEADSCALE_URL` and `DOCKERMAP_HEADSCALE_API_KEY` env vars
- Query Headscale REST API `GET /api/v1/machine` for machine list
- Same correlation logic as C2

**C4. Tailscale API endpoints**
- `GET /daemon/tailscale/peers` — all peers with container correlation
- `GET /daemon/tailscale/status` — connectivity status, exit node, online count

**C5. Tailscale UI**
- Dashboard: "VPN Reachable" section listing Tailscale-accessible containers with their MagicDNS names
- Container detail: Tailscale badge showing Tailscale IP and MagicDNS hostname (if correlated)
- New `/tailscale` page (only rendered when Tailscale detected): peer list with container links, tags, online status, exit node indicator
- Networks page: show Tailscale IPs alongside Docker IPs

---

### Stream D — Network Visualization Upgrade

**D1. Graph view selector**
- Dashboard graph gains a view toggle: "Topology" | "Networks" | "VPN"
- **Topology**: existing container/network/volume graph
- **Networks**: containers arranged by network, IPs shown on nodes, gateway containers highlighted
- **VPN**: Tailscale network map (peers as nodes, containers correlated, online/offline state)

**D2. Force-directed graph layout**
- Replace the current CSS grid "graph" with a true spatial layout using `d3-force` or `@xyflow/react`
- Container nodes: color by status (running=green, stopped=grey, error=red)
- Network nodes: teal, volume nodes: amber
- SVG edges with arrowheads: solid for `connected_to`, dashed for `mounts`
- Zoom/pan support, reset button
- Click node → detail page

---

### Phase 1.5 Verification

- [ ] `GET /api/v1/status` accessible from another machine when `DOCKERMAP_DAEMON_BIND=0.0.0.0:4100`
- [ ] `GET /api/widgets/homepage` returns correct JSON structure for Homepage widget config
- [ ] `GET /api/docs` renders Swagger UI with all read-only endpoints documented
- [ ] Networks page shows container IPs per network (not just names)
- [ ] At least Traefik label parser extracts domain → container mappings from a test fixture
- [ ] `/domains` page lists detected proxy routes
- [ ] Tailscale: when detected, `/tailscale` page shows peers; container detail shows badge
- [ ] Tailscale: when absent, no errors emitted — graceful degraded state

---

## Phase 2: Validation & Diagnostics

> Depends on: Phase 1 Compose parsing (A1–A6). Runs concurrently with Phase 1.5.

### Stream A — Rust Validation Engine

Define a `ValidationRule` trait with `fn check(&self, project: &ComposeProject) -> Vec<ComposeDiagnostic>`. Implement as independent structs — one per rule, each independently testable.

**A1. `MissingHostPath`** — `fs::metadata(resolved_source)` check for bind mounts. Emit `Error`.

**A2. `DuplicateContainerTarget`** — detect two mounts in the same service sharing a container path. Emit `Error`.

**A3. `AmbiguousRelativePath`** — warn when resolved path traverses above the project directory. Emit `Warning`.

**A4. `ReadWriteMismatch`** — declared `read_only: false` but host path is not writable. Emit `Warning`.

**A5. `PathTraversal`** — resolved path escapes configured `projectRoot` policy. Emit `Error`.

**A6. `UnresolvedEnvVar`** — `${VAR}` with no default, not in env. Emit `Error`.

**A7. `ProxyRouteConflict`** — two containers claim the same domain in their reverse proxy labels. Emit `Error`.

**A8. Diagnostics endpoint**
- `GET /daemon/compose/validate` → `{ diagnostics: Diagnostic[], summary: { errors, warnings, info } }`
- Machine-readable: suitable for CI `fail-on-error` scripts

**A9. Malformed fixture tests**
- `tests/fixtures/compose/invalid/` with: missing-path.yml, duplicate-target.yml, traversal.yml, unresolved-var.yml
- `#[test]` for each rule asserting correct severity and kind

---

### Stream B — Diagnostics UI

**B1. Diagnostics page** — new `/diagnostics` route; table grouped by severity; filter by severity/file/rule

**B2. Inline badges** — severity count badge on nav items; error outline on graph nodes with diagnostics

**B3. Dashboard KPI card** — fifth KPI card: "N errors, M warnings" from validation

**B4. Export** — "Export JSON" button on diagnostics page; `GET /api/diagnostics?format=json` machine-readable output

---

### Stream C — Security & Docs

**C1. Threat model** — `docs/SECURITY.md`: host path exposure, symlink traversal, Docker socket risk, edit permissions, external API binding risks

---

### Phase 2 Verification

- [ ] Each validation rule has tests for passing and failing cases
- [ ] `/api/compose/validate` returns structured JSON matching contracts
- [ ] Diagnostics page renders, groups by severity, filters correctly
- [ ] `Blocked` diagnostic correctly gates the editing workflow in Phase 3
- [ ] `ProxyRouteConflict` detects duplicate domain in test fixture

---

## Phase 3: Editing Workflow

> Depends on: Phase 2 complete. Mutation endpoints are feature-flagged behind `DOCKERMAP_EDITS_ENABLED=true`.

### Stream A — Rust Edit Engine

**A1. `EditPlan` and `PlannedEdit` types**
- `PlannedEdit { file, line, old_value, new_value, description }`
- `EditPlan { edits, validation_passed, blocking_diagnostics, diff_unified }`
- `EditResult { applied, backup_path, rollback_command, error }`

**A2. YAML round-trip edit**
- Parse Compose file to `serde_yaml::Value` (not typed struct) to preserve comments and key ordering
- Navigate to target field, swap value, re-serialize
- Generate unified diff using `similar` crate
- Return `EditPlan` without touching the filesystem

**A3. Write with backup**
- Copy original to `<filename>.dockermap.bak` in same directory before any write
- Atomic write: write to temp file, rename to target
- Return `EditResult` with backup path and rollback command

**A4. Git-aware safety check**
- Before applying: `git status --porcelain <file>` — if uncommitted changes exist, add `Warning` to `EditPlan`
- Never block the edit on git state, only warn

**A5. Daemon edit endpoints (feature-flagged)**
- `POST /daemon/compose/plan-edit` body `{ file, service, mountIndex, newSource? }` → `EditPlan`
- `POST /daemon/compose/apply-edit` body `{ planId, confirm: true }` → `EditResult`
- Both return `403` if `DOCKERMAP_EDITS_ENABLED != "true"`

---

### Stream B — Mutation API

**B1. Proxy edit endpoints through BFF** — add auth middleware stub (Bearer token check)

**B2. Audit log** — append each apply to `apps/api/src/audit.log`: timestamp, file changed, what changed

---

### Stream C — Diff Preview UI

**C1. Diff viewer component** — parse unified diff string, render `+`/`-` lines color-coded (green/red). Keep simple — no third-party diff renderer needed.

**C2. Edit panel** — "Change path" action on mount rows in ContainerDetail and Diagnostics pages; opens modal with text input and "Preview" button

**C3. Confirmation flow** — show diff preview, "Apply" button calls `apply-edit`, success/failure toast, refetch data

---

### Phase 3 Verification

- [ ] Dry-run produces valid unified diff for every mount type in fixture
- [ ] Write creates `.dockermap.bak` and correctly modifies the original
- [ ] Edit endpoints return `403` when `DOCKERMAP_EDITS_ENABLED` is unset
- [ ] `Blocked` diagnostic prevents `apply-edit` from executing
- [ ] Diff viewer renders for single-line and multi-line changes

---

## Phase 4: Visual & UX Polish

> Can begin concurrently with Phase 2/3 on non-overlapping work.

### Stream A — Graph Upgrade (depends on Phase 1.5 D2)

**A1. Force-directed layout** — D3-force or React Flow replacing the CSS grid graph

**A2. Node type styling** — containers (status-color), networks (teal), volumes (amber), gateways (larger)

**A3. Edge styling** — `connected_to` solid, `mounts` dashed, arrowheads

**A4. Graph view selector** — Topology / Networks / VPN toggle from Phase 1.5 D1

**A5. Zoom/pan** — built-in from graph library + reset button

---

### Stream B — Theme & Accessibility

**B1. Theme toggle** — dark/light mode via `.theme-light` CSS class on `<html>`; persist to `localStorage`; respect `prefers-color-scheme` as default

**B2. Keyboard shortcuts** — `g/c/i/n/v/l` for pages, `/` for search, `Escape` to clear, `?` for cheatsheet

**B3. ARIA labels** — `aria-label` and `role` on all interactive elements; run axe-core check

---

### Stream C — E2E Tests

**C1. Add Playwright** — `@playwright/test` targeting `http://127.0.0.1:3233` with mock API active

**C2. Smoke tests** — Dashboard KPI cards; Containers search; graph node click → detail; Logs service filter

**C3. Cross-page navigation tests** — all "Cross-Page Rules" from `PAGE_LOGIC.md`

**C4. Wire into CI** — add Playwright job to `github-actions-ci.yml` running against mock stack

---

### Phase 4 Verification

- [ ] Graph renders spatially (not CSS grid) with SVG edges
- [ ] Theme toggle persists across reload
- [ ] All interactive elements have accessible labels
- [ ] Playwright smoke tests pass in CI against mock stack
- [ ] Keyboard shortcut `g` navigates to Dashboard, `l` to Logs

---

## Phase 5: Runtime Enrichment

> Depends on: Phase 1 (bind_mounts field, correlation). Can run concurrently with Phase 3.

### Stream A — Container Metrics

**A1. bollard stats polling** — background task calling `stats()` (one-shot, non-streaming) per running container every 5s; store in separate `metrics` cache

**A2. `ContainerMetrics` type** — `{ container_name, cpu_percent, memory_mb, memory_limit_mb, timestamp }`

**A3. Metrics endpoint** — `GET /daemon/containers/:name/metrics`

**A4. Metrics in ContainerDetail** — CPU bar + memory bar; auto-refresh on heartbeat tick

**A5. Sort by CPU/memory** — enable `sort=cpu` and `sort=memory` on Containers page

---

### Stream B — Drift Detection

**B1. Drift comparison** — compare `ContainerRecord.bind_mounts` (runtime) vs `ComposeMountDeclaration` (declared); produce `DriftReport { matched, only_in_compose, only_in_runtime }`

**B2. Drift endpoint** — `GET /daemon/compose/drift`

**B3. Drift indicators** — Drift badge on ContainerDetail; Drift section in Diagnostics page

---

### Phase 5 Verification

- [ ] CPU and memory render in ContainerDetail and update on refresh
- [ ] Drift report identifies a Compose-declared volume not mounted in running container
- [ ] Metrics endpoint returns `200` for running containers, `404` for non-existent

---

## Phase 6: Collaboration & Release

> Depends on: Phases 1–5 substantially complete.

**6.1. Saved reports** — `GET /api/v1/report?format=json|html` generating static report of all diagnostics + mounts + drift; fail CI if any `Error` severity diagnostic exists

**6.2. CLI package** — `crates/dockermap-cli` with `clap` subcommands: `scan`, `validate`, `export --format json`, `report --output report.html`, `edit --dry-run`

**6.3. Release workflow** — `.github/workflows/release.yml` on `v*` tags; build `dockermap-daemon` + `dockermap-cli` for linux-x86_64, linux-aarch64, macos-aarch64; publish as GitHub Release assets

**6.4. Changelog** — `CHANGELOG.md` following Keep a Changelog; `git-cliff` or manual process

---

## Stretch Goals

### High Priority

**S1. Contract generation** — replace manually mirrored `packages/contracts/src/index.ts` with generated code via `typeshare` or `schemars` + `typescript-type-def`. Add `cargo run -p generate-contracts` step to CI that fails if generated output differs from committed output.

**S2. Compose override merging UI** — show merged view of volumes per service, tooltip showing which file each declaration originates from

**S3. `.env` interpolation** — parse `.env` files, substitute into `${VAR}` references, warn on missing or unused variables

**S4. Dockerfile path extraction** — parse `WORKDIR`, `COPY`, and `VOLUME` from Dockerfiles referenced by `build.context`; correlate with Compose mount declarations

### Medium Priority

**S5. Export to Mermaid/Graphviz** — `GET /api/v1/graph?format=mermaid` and `?format=dot` for embedding in docs/wikis

**S6. Named volume lifecycle hints** — detect volumes in Docker not referenced in any Compose file (prune candidates); detect Compose-declared volumes never created

**S7. Webhook / push notifications** — `POST /api/v1/webhooks` to register a URL; push `{ event: "container_stopped", container_name }` events to external systems (e.g., Homepage refresh triggers)

**S8. Integration tests with temporary Docker project** — spin up fixture Compose project via `docker compose up -d`, run daemon against it, assert zero drift; opt-in via `DOCKERMAP_INTEGRATION_TESTS=true`

### Lower Priority

**S9. Path normalization for Windows/WSL** — `C:\Users\...` → `/mnt/c/...` conversion; `cfg(target_os)` branches in path resolver

**S10. Policy file** — `.dockermap.yml` defining `allowed_host_roots: ["/data"]`; `PathTraversal` rule checks against this list

**S11. "Explain this mount" command** — `POST /api/v1/explain` takes a mount declaration, returns plain-English explanation (natural integration point for Claude API via `claude-sonnet-4-6`)

**S12. Desktop wrapper (Tauri)** — native app wrapping the web UI; system tray, auto-start; only after core product is stable

**S13. Multi-project view** — scan multiple project directories; cross-project volume sharing detection; global host map

---

## Dependency Graph

```
Phase 0 (done)
  │
  ▼
Phase 1 (parallel: A Compose parsing, B API hardening, C frontend split, D features, E infra)
  │
  ├──► Phase 1.5 (parallel with Phase 2: networking USP + external API)
  │      Stream A: External API exposure
  │      Stream B: Docker network enrichment
  │      Stream C: Tailscale/Headscale
  │      Stream D: Graph visualization
  │
  ├──► Phase 2 (parallel with 1.5: validation + diagnostics)
  │      │
  │      ▼
  │    Phase 3 (editing workflow — gates on Phase 2)
  │
  ├──► Phase 4 (polish — gates on Phase 1 C5; otherwise parallel with 2/3)
  │
  ├──► Phase 5 (runtime enrichment — gates on Phase 1 A8/A6)
  │
  └──► Phase 6 (release — gates on Phases 1–5)
         │
         ▼
       Stretch Goals (most independent of phase gates)
```

**Critical paths within Phase 1:**

- `C1 → C2 → C3 → C4 → C5` (frontend decomposition) must complete before any Stream D work
- `A1 → A2 → A3` (Compose types → parser → resolver) before A4–A9
- Streams A, B, C, E are fully parallel with each other

**The two highest-leverage starting points:**
1. **Frontend: C1–C5** (App.tsx decomposition) — unblocks all frontend feature work
2. **Rust: A1–A3** (Compose domain types + parser + resolver) — unblocks all downstream phases

---

## MVP Definition of Done

A user can:
- Run DockerMap against a Docker Compose project and see all bind mounts and named volumes with resolved absolute paths
- See which containers are running, which networks they're connected to, and which domains (via reverse proxy labels) route to them
- See validation diagnostics for missing paths and duplicate targets
- Export the full inventory as JSON
- Access the API from an external dashboard (Homepage widget configured and working)
- Not trigger any file write without first seeing a diff preview

Supporting: CI passes, fixture tests pass, setup is documented, no production audit vulnerabilities.

---

## Security & Reliability Commitments

- Do not write to Compose files without showing a diff and requiring explicit confirmation
- Do not follow symlinks for path validation unless behavior is explicit
- Treat Docker socket access as privileged — document the risk clearly
- Keep daemon on loopback by default; external binding requires explicit opt-in and token auth
- Validate path edits against `projectRoot` before writing
- Never silently swallow parse errors — surface them as diagnostics
- Add regression fixtures for every supported Compose syntax
- Mutation endpoints (`DOCKERMAP_EDITS_ENABLED`) disabled by default

---

## Previous Review Notes

The codebase review identified these technical debts to address within Phase 1:

- Runtime contracts are duplicated between TypeScript and Rust — address with contract compatibility tests (Phase 1 B3) and eventually contract generation (Stretch S1)
- Python prototype at `legacy/python-prototype/` is retained only as migration reference — remove in Phase 1 B4
- CI template exists but is unpublished — publish in Phase 1 E1
- `App.tsx` at 709 lines is the largest maintenance risk in the frontend — decompose in Phase 1 C1–C5
- Docker socket access is currently read-only — maintain this until Phase 3 safety model is complete
