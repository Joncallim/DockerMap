# Docker authority boundary decision (#62)

Status: accepted and implemented. The measured contract, gateway, Docker-only
runtime split, native full-host identity separation, and private-alpha
deployment evidence are recorded. Issue #62 remains open for maintainer
closure; this status is not a claim that every later release gate is complete.

## Decision

DockerMap uses a small DockerMap-owned **Docker Read Gateway**. It is the
only workload with the raw Docker Unix socket. The browser-facing frontend
(nginx plus Node API) and the Rust collector will not mount or fall back to
the raw socket.

```text
Caddy / browser-facing authentication boundary
        |
frontend: nginx + Node API          (no Docker socket)
        |
collector: Rust daemon              (gateway endpoint only)
        |
Docker Read Gateway                 (only raw-socket mount)
        |
Docker Engine
```

The gateway is a deliberately narrow HTTP proxy in the existing Rust
workspace, built with established HTTP parsing/proxy primitives. It has
no UI, no policy DSL, no user-configurable wildcard permissions, and no Docker
mutation implementation. It rejects requests before forwarding them to Docker.

## Why this boundary

The pre-#62 all-in-one deployment started nginx, Node, and the Rust daemon in
one root container with `/var/run/docker.sock`. `:ro` made the mount entry
read-only but did not constrain Docker API methods: a browser/API compromise
could open the socket without using DockerMap's routes. The current Compose
deployment moves that authority to the gateway; the compatibility image is not
the production authority model.

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

### Bounded Docker events foundation (#70)

The gateway's
`bollard_0_19_event_request_traverses_the_real_gateway_and_only_safe_form_reaches_docker`
regression points Bollard 0.19.4 at the real filtered Unix gateway with an
isolated raw-Docker Unix stub behind it. An approved request reaches the raw
stub exactly once; a second Bollard request with an incomplete action filter is
denied without reaching the stub. This exercises Bollard's actual headers,
empty body, and HTTP framing through the production policy path. Its approved
origin-form target is:

```text
/events?since=<unix-seconds>&until=<unix-seconds>&filters=<form-encoded JSON>
```

Bollard serializes the outer fields in `since`, optional `until`, `filters`
order. Its `filters` value is JSON serialized from a Rust `HashMap`, so JSON
object key order is not stable and cannot be used as an authority check. The
gateway instead decodes that one value and accepts only this closed structure:

```json
{
  "type": ["container"],
  "event": ["create", "start", "stop", "die", "restart", "destroy", "health_status"]
}
```

When `DOCKERMAP_DOCKER_LABEL_FILTER` is configured, the object must also
contain exactly `"label": ["<configured expression>"]`. When it is not
configured, a `label` event filter is rejected. Map and event-set order are
semantically irrelevant only after the parser proves that all keys and values
match this closed structure exactly; missing, duplicate, malformed, unrelated,
or scope-widening filters fail closed.

Form percent-decoding is byte-accurate and must produce strict UTF-8 before JSON
or configured-label comparison. Malformed escapes, invalid bytes, overlong UTF-8
and truncated sequences are rejected; they are never converted to replacement
characters that could accidentally match a configured label. The approved raw
target is forwarded verbatim only after these checks.

Both accepted request forms require canonical unsigned Unix seconds:

- A live tail has `since` and no `until`; `since` must be no more than 300
  seconds behind the gateway clock and cannot be in the future.
- A finite replay has `since` and `until`; both must be at or before the
  gateway clock, `since <= until`, and the request must start within the same
  300-second recent window.

This remains a gateway policy boundary: it forwards Docker's response body and
does not itself redact or publish it. The daemon now has a separately reviewed
collector that immediately reduces this one approved response form to closed
event kinds and opaque identities before retention or publication. Raw event
payloads remain neither safe to publish nor exposed. Any expansion beyond this
closed form still requires an explicit policy, negative tests, and review.

## Gateway policy

Allow only the measured inventory/log requests and the bounded event form above.
There is no general Docker read permission or path wildcard.

- Method must be exactly `GET`; all other methods, including `HEAD`, are
  rejected until a separately reviewed contract adds them.
- Paths are accepted only in origin form and must exactly match one of the five
  route shapes. Empty query is allowed only for `/networks` and `/volumes`.
- The container path segment must be a single non-empty, unescaped Docker
  name/ID segment. Encoded separators, duplicate slashes, dot segments and
  absolute-form targets are rejected, not normalised.
- Query parameters are unique and exactly match the applicable contract.
  Unknown keys, duplicate keys, empty/value-shape changes, unbounded/following
  logs, old event lookback, and unscoped event requests are rejected.
- Inventory calls use the unfiltered form only when no gateway label filter is
  configured. With one configured label filter, all three require the measured
  single `filters` object; the gateway rejects scope widening or filter removal.
- Requests with a body, `Upgrade`, `Connection: upgrade`, `CONNECT`, or
  hijack framing are rejected. The approved `/events` call is a normal HTTP
  response stream, not a protocol upgrade.
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
representative mutation, inspect/archive/top/exec/stats/image/build, unsafe
event-query, and request-ambiguity classes enumerated below. A Bollard-driven
wire test proves that nondeterministic filter-map ordering is accepted only
after exact semantic validation. The isolated live-Docker and production-image
suites cover allowed reads, denied mutations, and the split mount/network
profile.

The single-container compatibility image starts the gateway before its
collector and therefore exercises the filtered contract, but it is **not** the
production isolation profile: its processes share one container namespace and
raw-socket mount. Use the split Compose deployment for Docker-only operation.

This policy intentionally excludes container archive/export, top/processes,
inspect, exec, stats, images, builds, plugin APIs and every mutation. It permits
only the bounded, container-scoped event selection above. Any later event
expansion or stats support requires a new explicit policy, negative tests, and
review; it must not be enabled by a broad read wildcard.

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
control-plane permissions. The native collector unit forces
`DOCKERMAP_PID_NAMESPACE=host` in its final `ExecStart`, overriding the shared
environment file's Docker-only-safe `restricted` value; it does not rely on
automatic namespace detection. `ProtectSystem=strict` leaves
`/opt/dockermap` read-only: the collector has no persistent writable project
path.

## Read-only Hearth discovery (2026-08-28, pre-cutover record)

Before the #62 cutover, live Docker evidence—not deployment intent—showed the
then-current `dockermap` container was rootful Docker on the default context.
The socket was `/var/run/docker.sock`, owned by UID 0/GID 973 with mode 0660.
At capture, the running container used image `dockermap:hearth`, ran as the
image default user (empty `Config.User`, therefore root), mounted the socket
and project root read-only, and was only on the external `proxy` network. Its
Compose metadata pointed to the tracked Hearth infrastructure stack. It had no
read-only root filesystem and retained several capabilities despite dropping
`ALL`.

These facts informed the canary and rollback preparation. The post-cutover
authority and recovery evidence is recorded in the private-alpha baseline and
#62 resolution evidence; operators must still inspect their own socket
ownership and Compose revision before deployment.

## Negative-test evidence for the split topology

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

## Delivery and rollback record

1. This ADR and measured contract (PR #92).
2. Gateway plus read/deny integration tests (PR #93).
3. Frontend/collector/gateway runtime split and production-E2E migration (PR #94).
4. Native full-host separation and hardening (PR #95).
5. Isolated live-Docker evidence and the private-alpha deployment baseline (PRs #96–#99).

The public proxy authentication mechanism was intentionally left outside this
authority split. Deployment evidence records its browser-facing boundary
separately; a future change must not broaden Docker authority to solve a proxy
configuration problem.
