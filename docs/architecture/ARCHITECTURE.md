# DockerMap Architecture

DockerMap is a read-first local operational topology app. Docker and Docker Compose are
deep providers, not the boundary of the product. The runtime map must represent the full
self-hosted environment: Docker resources, systemd units, tmux-managed agents, package
ecosystems, native processes, reverse proxies, databases, DNS, storage, network edges,
external APIs, and AI workloads.

For the first full alpha, backend topology and security hardening remain the
priority, but substantial UI work has shipped alongside it: detail pages (#34),
responsive and accessibility coverage (#35), and the evidence-backed live-state
vocabulary (#61 epic). Future UI work is sequenced through the filed roadmap
epics rather than being deferred wholesale.

## Active Components

- `apps/web`: React/Vite interface for graph, inventory, and log views.
- `apps/api`: Express browser-facing API. It adapts browser requests to daemon endpoints and owns SSE heartbeat polling.
- `crates/dockermap-core`: Rust domain model and derivation logic. This is the canonical runtime model for Docker and host runtime resources.
- `crates/dockermap-daemon`: Rust HTTP daemon. It talks to Docker through `bollard`,
  but reaches the raw Docker socket only through the Docker Read Gateway. It reads host
  runtime signals with fixed read-only commands in the explicit full-host profile,
  caches snapshots, and can fall back to explicitly stamped mock data when configured.
- `crates/dockermap-docker-gateway`: Rust default-deny proxy. It is the only DockerMap
  component with the raw Docker socket and permits only the measured inventory and
  bounded-log Docker requests.
- `packages/contracts`: TypeScript API contracts consumed by the web and API workspaces.

## Source Of Truth

Runtime data flows from the Rust daemon outward:

```text
Docker Engine -> Docker Read Gateway -> dockermap-daemon -> apps/api -> apps/web
Compose and bounded host signals ------------------^
                                                     |
                                                     v
                                             dockermap-core
```

Rust owns daemon response models. Deterministic Schemars JSON Schema and generated
TypeScript declarations are committed under `packages/contracts`; the handwritten
TypeScript layer is limited to Node-owned envelopes and browser Demo Mode metadata.
Shared JSON examples remain readable regression fixtures and are validated against the
generated schemas rather than defining them. Route, request, and response associations
derive the OpenAPI 3.1.1 document. The ownership map, drift checks, and remaining #65
acceptance work are recorded in [`CONTRACT_AUTHORITY.md`](CONTRACT_AUTHORITY.md).

## Runtime Map

`GET /daemon/runtime/map` is the backend's provider-neutral JSON graph for visualization. `apps/api` proxies it as `GET /api/runtime/map`.

### Relationship evidence lifecycle

Each runtime edge has a required `evidenceRefs` array. The current Docker and
Systemd slices emit bounded, versioned records alongside the edge during
derivation; they are not reconstructed from labels in React:

```text
collector -> bounded RuntimeEvidenceRef -> RuntimeMapEdge -> daemon publication/redaction -> API contract validation -> Runtime inspector
```

Version one facts are Docker network membership, volume attachment, port
publication, and Docker-recorded Compose start-order declarations. They are
`observed`, carry the Docker collection timestamp and an opaque Docker
observation revision token (deliberately neither a timestamp nor the cache
model revision), and declare `fresh` only for that Docker observation.

Version two adds only Systemd `Requires`, `Wants`, and `PartOf` declarations.
Each fact is `declared`, is tied to the independently scheduled `systemd`
slot's opaque data revision and last successful collection timestamp, and can
be `fresh`, retained `stale`, or `timed_out`. It never claims successful start,
readiness, health, traffic, inverse dependency, or symmetric membership.
Restricted PID mode emits no Systemd edge evidence. An empty array is explicit
migration state for a relationship family that has not yet gained provenance;
it must not be silently presented as an observed fact.

The evidence representation is closed: provider, kind, assertion kind and
freshness are enums, and there is no free-form metadata/config/command-line
field. The daemon and browser publication boundaries redact display-hostile
or secret-like strings before response bytes reach the UI. Identity collisions
remain visible but non-routable; an edge inspector can still explain the
selected relationship without joining a collided target.

Current relationship-source matrix:

| Relationship family | Source | Assertion | Evidence status |
| --- | --- | --- | --- |
| Docker container -> network | Docker inventory membership | observed | emitted |
| Docker container -> volume | Docker volume attachment | observed | emitted |
| Docker container -> listener | Docker published port | observed | emitted |
| Docker container -> Docker container (`depends_on`) | Docker-recorded Compose start-order label | observed declaration, not health or traffic causality | emitted when both identities resolve uniquely |
| systemd service -> systemd service (`requires`, `wants`, `part_of`) | Systemd `Requires=`, `Wants=`, `PartOf=` declaration | declared relationship, not start/health/traffic evidence | emitted only with a valid dedicated Systemd-slot observation; retained facts state freshness explicitly |
| npm, tmux, proxy, DNS, process and cross-provider edges | bounded provider-specific collector facts | varies | explicit empty migration array; no invented provenance |

### Bounded findings

`GET /daemon/findings` and its authenticated browser aliases expose only a
cached projection of the same published runtime-map revision. The closed
`systemd.requires_target_not_active` rule emits one warning only when
there is exactly one fresh, declared Systemd `Requires` edge from a uniquely
identified active service to a uniquely identified inactive or failed service.
It is a dependency configuration condition—not proof of a failed start,
readiness, traffic, service health, or security impact. Stale, timed-out,
ambiguous, duplicate, non-Systemd, `Wants`, and `PartOf` evidence produces no
finding.

`docker.internal_network_member_publishes_port` emits an advisory only when
one uniquely identified Docker container has both one fresh, validated Docker
internal-network membership fact and one fresh Docker listener fact whose
already-sanitized port form proves a nonzero host-to-container publication.
Container-only ports, malformed or bind-address-like forms, stale evidence,
duplicate facts, and identity collisions produce no finding. This is not an
Internet-reachability, vulnerability, or security conclusion.

Each rule carries only its exact triggering evidence references. The API
validates the fixed vocabulary, static display text, and rule-specific evidence
shape before publication, and the browser displays findings only when their
nonempty model revision matches the current live model.

#### Current finding policy

`warning` is reserved for a fresh, directly recorded declaration whose current
service-state endpoints satisfy a closed, fail-closed condition. It does not
mean a service failed to start. `advisory` is reserved for a fresh combination
of directly observed Docker facts that merits a configuration review but does
not establish exposure, reachability, vulnerability, or impact. There is no
critical severity in the current pack. New rules require an explicit contract,
fixed evidence budget, deterministic positive and benign-negative fixtures,
and a review of their exact conclusion language.

The map is organized around a unified service concept. Docker containers, systemd
services, tmux sessions, npm applications, Python applications, and native processes
should all expose the same operational shape wherever the provider can safely populate
it:

- `name`
- `status`
- `dependencies`
- `dependents`
- `health`
- `logs`
- `events`
- `owner`
- `location`

The implementation detail still remains available through `provider`, `type`, `layer`,
and metadata, but the graph should answer "what depends on what?" before it asks users
to understand whether something is Docker, systemd, tmux, npm, Python, or a native Linux
service.

The map is read-only and currently contains:

- Docker containers, networks, volumes, images, Compose stacks, and exposed/listening
  ports.
- systemd services from fixed read-only `systemctl` calls when systemd is available,
  including dependency edges from `Requires=`, `Wants=`, and `PartOf=` where
  safe to collect.
- tmux sessions and tmux-managed agents where the session metadata exposes a bounded
  relationship.
- npm projects discovered from `package.json` and lockfiles under the configured project
  root, with scripts, framework hints, and dependency nodes. The contracts can represent
  package-update/advisory metadata, but no runtime registry or advisory lookup is enabled
  today. Update status is reported as "Not collected" until an opt-in advisory provider
  lands (#66/#70 territory).
- scheduled jobs from `/etc/crontab`, `/etc/cron.d/*`, and the current user's `crontab -l` when readable.
- PM2 apps from `pm2 jlist` when PM2 is installed.
- tmux sessions from `tmux list-sessions` when tmux is installed and reachable.
- listening sockets from `/proc/net/tcp` and `/proc/net/tcp6` on Linux.
- Tailscale peers from `tailscale status --json` when Tailscale is installed and authenticated.
- Headscale nodes from `headscale nodes list --output json` when Headscale is installed and readable.
- reverse proxy markers from common configs and Docker images/names, including nginx, Nginx Proxy Manager, Traefik, Caddy, HAProxy, Envoy, Apache httpd, Cloudflare Tunnel, and frp.
- local DNS markers from common configs and Docker images/names, including Pi-hole, AdGuard Home, dnsmasq, Unbound, CoreDNS, and Technitium DNS.

Optional providers fail softly with diagnostics instead of making the map endpoint fail.
Provider commands are fixed read-only invocations, not user-supplied shell commands.
Filesystem discovery must stay bounded by configured roots, skip dependency/build
directories, and avoid reading secrets such as `.env` values.

Python application and native-process providers plug into this same map as
read-only peers. The implementation plan in
[`docs/planning/PYTHON_AND_PROCESS_PROVIDERS.md`](../planning/PYTHON_AND_PROCESS_PROVIDERS.md)
defines safe sources, discovery bounds, omitted data, diagnostics, and follow-up
slices; the providers themselves shipped via #32/#38/#39 + #33. Remaining
enrichment (richer Python metadata, parser-level fixtures) is tracked in the
roadmap.

Kubernetes and other orchestrators should plug into this same model as additional providers, not replace the local Docker/host model. Kubernetes support should be opt-in because it needs kubeconfig or in-cluster credentials, namespace scoping, and RBAC permissions. A safe first Kubernetes provider should read namespaces, pods, services, deployments, ingress objects, persistent volume claims, and selected labels/owner references, then map them to `orchestrator_workload` nodes and edges.

## Runtime Layers

The backend should tag nodes with a stable layer so the UI can turn graph slices on and
off without changing provider behavior:

- Docker
- systemd
- tmux
- npm
- Python
- Storage
- Network
- External APIs
- DNS
- Reverse proxies
- AI agents

Layer toggles are presentation concerns; provider collection remains read-only and
diagnostic-driven.

## Cross-Technology Relationships

Cross-provider edges are the differentiator. The graph should make chains visible even
when each hop comes from a different collector:

```text
Cloudflare -> Caddy (systemd) -> Docker network -> Immich container -> Postgres container -> Storage volume
```

```text
Forge (npm) -> forge.service -> tmux session -> GPT worker
```

Relationship discovery should prefer explicit evidence first, such as systemd dependency
fields, Compose labels, process working directories, package manifests, lockfiles, known
reverse-proxy routes, and Docker network membership. Heuristics are allowed only when
metadata records why the edge exists. Future Python/native-process edges must include
evidence metadata such as `proc_cwd`, `project_manifest`, or `systemd_main_pid`.
Process-to-listener edges stay out of the first Python/native-process implementation unless
a later security review approves a safe source that does not read `/proc/<pid>/fd` targets.

## Docker Access

The daemon binds to loopback by default and only reads host and Docker state today.
Docker socket access is still powerful, so write endpoints should not be added until the
project has explicit authorization, dry-run previews, audit logging, and rollback
guidance.

The Node API can require `DOCKERMAP_API_TOKEN`. When the token is set, every
browser-facing route requires an `Authorization: Bearer` header. The API forwards
`DOCKERMAP_DAEMON_TOKEN` (or the API-token fallback) to every daemon request; when
configured, the daemon applies the same bearer check to every route, including health
and fallback responses.

## Compose Scanning

`crates/dockermap-core` owns the typed Compose scan model for services, mounts,
environment values, file origins, diagnostics, runtime mount checks, a derived path-map
graph, and dry-run edit plans. The daemon exposes this through
`GET /daemon/compose/scan`, `GET /daemon/compose/graph`, and
`GET /daemon/compose/edit-plan`; `apps/api` proxies them at `GET /api/compose/scan`,
`GET /api/compose/graph`, and `GET /api/compose/edit-plan`.

By default, scanning discovers standard Compose filenames plus adjacent override files
under `DOCKERMAP_PROJECT_ROOT` or the daemon working directory. Explicit `file` query
values are resolved only under that project root, parent traversal is rejected, and
symlinked paths are not followed during request validation. The endpoint is read-only and
reports diagnostics for unsupported syntax, unresolved variables, duplicate mount targets,
invalid container targets, missing bind sources, and symlink bind sources.

Runtime mount checks compare what Compose declares with what Docker is actually running.
Each check is marked `matched`, `missing`, or `extra`.

Edit planning is also read-only. It accepts a Compose file, service, mount index, and proposed source/target values, then returns diagnostics and a unified diff with `willWrite: false`.
