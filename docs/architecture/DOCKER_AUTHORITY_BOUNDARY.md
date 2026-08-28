# Docker authority boundary decision (#62)

Status: accepted; measured contract, gateway, Docker-only runtime split, and
native full-host identity separation are implemented. Deployment rollout and
final certification remain pending.

## Decision

DockerMap will use a small DockerMap-owned **Docker Read Gateway**. It is the
only workload with the raw Docker Unix socket. The browser-facing frontend
(nginx plus Node API) and the Rust collector will not mount or fall back to
the raw socket.

```text
Caddy / Authentik
        |
frontend: nginx + Node API          (no Docker socket)
        |
collector: Rust daemon              (gateway endpoint only)
        |
Docker Read Gateway                 (only raw-socket mount)
        |
Docker Engine
```

The gateway will be a deliberately narrow HTTP proxy in the existing Rust
workspace, built with established HTTP parsing/proxy primitives. It will have
no UI, no policy DSL, no user-configurable wildcard permissions, and no Docker
mutation implementation. It must reject requests before forwarding them to
Docker.

## Why this boundary

The current all-in-one image starts nginx, Node, and the Rust daemon in one
root container. The container mounts `/var/run/docker.sock`; `:ro` makes the
mount entry read-only but does not constrain Docker API methods. A browser/API
compromise can therefore open the socket without using DockerMap's routes.

Separating only a raw-socket collector would reduce exposure but would not
block a collector compromise from mutating Docker. A Docker daemon authorization
plugin would constrain more strongly, but changes daemon-wide behavior for
unrelated host workloads. The read gateway provides an application-independent,
testable mutation boundary without changing Caddy/Authentik or Docker daemon
policy.

## Measured current Bollard contract

The `bollard_wire_contract_for_current_docker_reads` test starts an isolated
Unix Docker stub and records the actual requests emitted by the current
collector (Bollard 0.19). It observes no version negotiation, `/_ping`, or
`/version` request. The raw request lines are:

### Unfiltered collector

| Purpose | Method | Raw target | Query contract |
| --- | --- | --- | --- |
| Container inventory | `GET` | `/containers/json` | `all=true`, `size=false` |
| Network inventory | `GET` | `/networks` | Empty query only (Bollard emits trailing `?`) |
| Volume inventory | `GET` | `/volumes` | Empty query only (Bollard emits trailing `?`) |
| Current log page | `GET` | `/containers/{name}/logs` | `follow=false`, `stdout=true`, `stderr=true`, `since=0`, `until=0`, `timestamps=true`, `tail=4096` |
| Historical log page | `GET` | `/containers/{name}/logs` | As above, with `until` the collector's bounded, rounded timestamp second |

All observed requests use HTTP/1.1 and have no request body. `tail=4096` is the
collector's fixed maximum Docker log window. The collector requests
`follow=false`; it does not use Docker log hijacking or upgrade semantics.

The regression test intentionally asserts exact request lines. A Bollard,
collector, or dependency change that introduces a new path, API-version prefix,
query key, query value shape, or negotiation call must fail the test and update
this decision before the gateway is widened.

### Label-filtered collector

`DOCKERMAP_DOCKER_LABEL_FILTER` is a boundary control, not merely a collector
preference. A second isolated trace with
`com.dockermap.fixture=trace-123` measures these exact raw targets:

| Purpose | Method | Raw target |
| --- | --- | --- |
| Container inventory | `GET` | `/containers/json?all=true&size=false&filters=%7B%22label%22%3A%5B%22com.dockermap.fixture%3Dtrace-123%22%5D%7D` |
| Network inventory | `GET` | `/networks?filters=%7B%22label%22%3A%5B%22com.dockermap.fixture%3Dtrace-123%22%5D%7D` |
| Volume inventory | `GET` | `/volumes?filters=%7B%22label%22%3A%5B%22com.dockermap.fixture%3Dtrace-123%22%5D%7D` |

The `filters` value is one percent-encoded JSON object with exactly one `label`
array containing exactly one bounded label expression. When a gateway label
filter is configured, it requires the exact canonical measured encoding and
value for all three inventory calls; omission, a different label, another
filter type, another value, alternate JSON/percent-encoding, malformed input,
or duplicate `filters` keys fails closed. When no gateway label filter is
configured, every `filters` key fails closed. The gateway applies the same
bounded label-expression rules as the collector before comparing the canonical
configured value.

## Gateway policy

Until a separately reviewed change, allow only the measured requests above.

- Method must be exactly `GET`; all other methods, including `HEAD`, are
  rejected until a separately reviewed contract adds them.
- Paths are accepted only in origin form and must exactly match one of the four
  route shapes. Empty query is allowed only for `/networks` and `/volumes`.
- The container path segment must be a single non-empty, unescaped Docker
  name/ID segment. Encoded separators, duplicate slashes, dot segments and
  absolute-form targets are rejected, not normalised.
- Query parameters are unique and exactly match the table. Unknown keys,
  duplicate keys, empty/value-shape changes, and unbounded/following logs are
  rejected.
- Inventory calls use the unfiltered form only when no gateway label filter is
  configured. With one configured label filter, all three require the measured
  single `filters` object; the gateway rejects scope widening or filter removal.
- Requests with a body, `Upgrade`, `Connection: upgrade`, `CONNECT`, or other
  hijack/streaming forms are rejected.
- The gateway has no public listener or admin endpoint. Only the collector can
  reach its private network/socket.
- Gateway unavailability is a Docker-provider failure. The collector must
  surface unavailable/degraded evidence and must never reconnect to
  `/var/run/docker.sock` directly.

## Implemented gateway boundary (slice 2)

`dockermap-docker-gateway` listens only on a filtered Unix socket and opens the
raw Docker socket only after policy approval. It uses Hyper's HTTP/1 parser and
client over Unix streams; it does not implement a raw HTTP parser and does not
copy requester-controlled headers upstream. The collector's explicit default
endpoint is `/run/dockermap/docker-read.sock`; it rejects both common raw Docker
socket paths and has no raw-socket retry path.

Gateway regression tests use a fake raw Unix Docker endpoint to establish that
allowed targets are forwarded verbatim and denied method, route, query,
framing, upgrade, and encoded-path forms never reach Docker. They cover the
representative mutation, inspect/archive/top/exec/events/stats/image/build, and
request-ambiguity classes enumerated below. Slice 3 will add the isolated
real-Docker and container-mount/network proof when the services are split.

The pre-split compatibility image starts the gateway before its collector so
the collector already exercises the filtered contract. It is **not** the final
authority boundary: gateway and collector still share that image's raw-socket
mount until Slice 3 removes it from the frontend/collector runtime.

This policy intentionally excludes container archive/export, top/processes,
inspect, exec, events, stats, images, builds, plugin APIs and every mutation.
Future #70 `events` or `stats` support requires a new explicit policy, negative
tests, and review; it must not be enabled by a broad read wildcard.

## Deployment profiles

### Docker-only (recommended container default)

- Frontend has the existing external `proxy` network identity and serves Caddy
  at port 3233, but has no Docker socket or infrastructure project mount.
- Collector has only a bounded project root mounted read-only, a private
  frontend/collector network, and a separate collector/gateway network.
- Gateway has no published ports and is attached only to the collector/gateway
  transport. The implementation uses a shared filtered Unix socket, so the
  gateway has no Docker network at all; that is narrower than a private network.
- Collector runs in restricted PID mode and host providers are unavailable by
  construction; no host PID, systemd D-Bus, host `/proc`, host home, or broad
  filesystem mounts are present.

### Demo

No Docker socket, gateway, or host providers; only explicit sample data.

### Full-host inspection

This is an explicit native/systemd profile. `dockermap-gateway` alone joins
Docker's group and owns the filtered socket; `dockermap-collector` receives
only that socket through the gateway group and never joins Docker's group;
`dockermap-api` is a third identity. It keeps bounded existing host providers,
with the documented privacy/trust trade-off. Tailscale and Headscale are
separately opt-in and off by default; #62 adds neither credentials nor
control-plane permissions.

## Read-only Hearth discovery (2026-08-28)

Live Docker evidence, not deployment intent, shows the current `dockermap`
container is rootful Docker on the default context. The socket is
`/var/run/docker.sock`, owned by UID 0/GID 973 with mode 0660. The running
container uses image `dockermap:hearth`, runs as the image default user (empty
`Config.User`, therefore root today), mounts the socket and project root
read-only, and is only on the external `proxy` network. Its Compose metadata
points to the tracked Hearth infrastructure stack. It currently has no
read-only root filesystem and retains several capabilities despite dropping
`ALL`.

These facts guide the eventual canary but do not authorize a deployment. The
implementation must re-inspect them immediately before rollout and preserve the
current Compose/image revision as rollback.

## Required negative tests before switching topology

Using only test-owned Docker resources, prove:

1. The measured reads (including bounded logs) succeed through the gateway.
2. `POST`, `PUT`, `PATCH`, `DELETE`, and `CONNECT` fail at the gateway for
   representative container, network, volume and image mutations.
3. Unknown GET paths; archive/export/top/inspect; encoded-path and
   duplicate-slash forms; absolute targets; duplicate/unknown query keys;
   request bodies; and upgrade/hijack forms fail closed.
4. Frontend/API have no raw socket mount or gateway reachability; collector has
   no raw socket mount; only gateway has the socket mount.
5. Gateway loss or invalid configuration leaves Docker unavailable/degraded and
   cannot trigger a raw-socket fallback.
6. Docker-only profile leaves host providers unavailable while inventory, logs,
   live-Docker E2E and normal browser workflows continue to work.

## Delivery and rollback

1. This ADR and measured contract.
2. Gateway plus read/deny integration tests.
3. Frontend/collector/gateway runtime split and production-E2E migration.
4. Native full-host separation and hardening.
5. Separate canary, deployment evidence, and hostile final certification.

Do not modify Caddy/Authentik for slices 1–4. Before slice 5, run the full
repository gate, live-Docker and production-image tests, privilege-boundary
tests, browser workflows and deployment smoke. Keep the current deployment
revision available until the canary is accepted.
