# Running DockerMap In Docker

Docker-only is the recommended container profile. Compose runs a frontend
(nginx plus Node API), a Rust collector, and a Docker Read Gateway. Only the
gateway receives the raw Docker socket; the collector receives a filtered Unix
socket and the bounded project mount.

## Files

- [`Dockerfile`](../../Dockerfile): multi-stage build (Rust daemon, Node/web build, runtime image).
- [`docker-compose.yml`](../../docker-compose.yml): split Docker-only deployment.
- [`deploy/docker/nginx.conf`](../../deploy/docker/nginx.conf): serves the web app and proxies `/api/*`.
- [`deploy/docker/frontend-entrypoint.sh`](../../deploy/docker/frontend-entrypoint.sh):
  starts the frontend API and nginx for the Compose `dockermap` service.
- [`deploy/docker/entrypoint.sh`](../../deploy/docker/entrypoint.sh): compatibility
  image entrypoint that starts gateway, collector, API, and nginx together; it is
  not the split Compose authority profile.

## Run With Docker Compose

```bash
docker compose up --build
```

Before starting Compose, generate a daemon-to-collector token in a protected
environment file and set `DOCKERMAP_DAEMON_TOKEN`; set `DOCKER_GID` to the
numeric group owning `/var/run/docker.sock`. Open `http://127.0.0.1:3233`.

## Run With Plain Docker

```bash
docker build -t dockermap:local .
docker run --rm -p 127.0.0.1:3233:3233 \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v "$PWD":/opt/dockermap/project:ro \
  dockermap:local
```

The port is bound to loopback (127.0.0.1) because with no `DOCKERMAP_API_TOKEN`
set the API is unauthenticated read-only — do not expose it on the LAN. For
remote access, set `DOCKERMAP_API_TOKEN` (see `.env.example`) and publish the
port on the interface of your choice, e.g. `-p 3233:3233`.

## Authority and mounts

- Gateway only: `/var/run/docker.sock` read-only. The gateway independently
  permits only reviewed inventory, bounded non-following logs, bounded Docker
  events, and the exact finite per-container stats request
  `stream=false&one-shot=false` on an unfiltered profile. It denies all stats
  requests when `DOCKERMAP_DOCKER_LABEL_FILTER` is set because that Docker
  endpoint cannot express the inventory label scope.
- Collector only: `/opt/dockermap/project` read-only plus the filtered gateway
  socket. It cannot mount or fall back to the raw socket.
- Frontend: neither mount. It is the only DockerMap service that has a
  listener and it has no gateway network/socket path.

## Optional Docker Label Filter

Set `DOCKERMAP_DOCKER_LABEL_FILTER` on the daemon to inspect only Docker resources
that carry one label expression:

```yaml
environment:
  DOCKERMAP_DOCKER_LABEL_FILTER: "com.dockermap.fixture=abc123"
```

With a label filter, inventory and Docker events remain gateway-scoped, but
per-container stats are deliberately unavailable. Do not rely on collector-side
inventory selection to authorize a stats request: the gateway fails it closed.

When unset, DockerMap inspects all visible Docker containers, networks, and volumes.
When set, the filter is applied directly to Docker Engine list calls before DockerMap
builds its snapshot. This is useful for sandbox fixtures and release-host tests where
unrelated host resources must stay out of the UI.

## Security Note

Mounting a Docker socket gives its holder Docker-daemon-level authority; `:ro`
does not restrict Docker API mutations. DockerMap therefore gives that mount
only to the fail-closed gateway. See [docs/security/THREAT_MODEL.md](../security/THREAT_MODEL.md).
The plain `docker run` compatibility image remains a local/dev convenience and
does not provide this three-service isolation; use Compose for deployments.

## Environment Variables

`.env.example` is the deployable starter file. The table below is the complete
DockerMap/Vite configuration contract; `NODE_ENV` is a normal Node runtime
setting rather than a DockerMap setting. Boolean switches only enable on the
literal value `true`; use `false` or leave them unset otherwise. Values marked
**secret** must not be copied into browser build variables, logs, screenshots,
or proxy configuration committed to source control.

| Variable | Scope | Default | Accepted values / range |
| --- | --- | --- | --- |
| `PORT` | Node API | `4000` | Integer `1`–`65535`. The API still binds loopback. |
| `DOCKERMAP_DAEMON_URL` | Node API | `http://127.0.0.1:4100` | Absolute `http`/`https` URL; loopback unless `DOCKERMAP_ALLOW_REMOTE_DAEMON=true`. |
| `DOCKERMAP_API_TOKEN` | Node API / daemon fallback | unset | Non-empty **secret**; enables bearer mode unless forward-auth is selected. |
| `DOCKERMAP_DAEMON_TOKEN` | Node API / daemon | `DOCKERMAP_API_TOKEN` | Non-empty **secret** when set; API-to-daemon credential. |
| `DOCKERMAP_ALLOWED_ORIGINS` | Node API | `http://127.0.0.1:3233,http://localhost:3233` | Comma-separated explicit `http`/`https` origins only; no `*`, path, query, or credentials. |
| `DOCKERMAP_ALLOW_MOCK` | Node API | `false` | `true` permits Node mock fallback when the daemon is unavailable. |
| `DOCKERMAP_EXPOSE_ERROR_DETAILS` | Node API | `false` | `true` exposes daemon failure details; keep `false` outside diagnosis. |
| `DOCKERMAP_SSE_INTERVAL_MS` | Node API | `2000` | Number clamped to `1000`–`30000` ms; non-numeric uses default. |
| `DOCKERMAP_MAX_SSE_STREAMS_PER_SESSION` | Node API | `8` | Number clamped to `1`–`64`. |
| `DOCKERMAP_MAX_SSE_STREAMS` | Node API | `128` | Number clamped to `1`–`1024`. |
| `DOCKERMAP_AUTH_REQUIRED` | Node API | `false` | `true` selects trusted forward-auth and takes precedence over bearer token mode. |
| `DOCKERMAP_AUTH_USER_HEADER` | Node API | `x-remote-user` | Trusted forward-auth header name: lowercase letters, digits, and `-`. |
| `DOCKERMAP_AUTH_NAME_HEADER` | Node API | `x-remote-name` | Trusted forward-auth header name: lowercase letters, digits, and `-`. |
| `DOCKERMAP_AUTH_EMAIL_HEADER` | Node API | `x-remote-email` | Trusted forward-auth header name: lowercase letters, digits, and `-`. |
| `DOCKERMAP_AUTH_GROUPS_HEADER` | Node API | `x-remote-groups` | Trusted forward-auth header name: lowercase letters, digits, and `-`; comma-separated groups. |
| `DOCKERMAP_AUTH_COOKIE` | Node API | `dockermap_session` | HTTP cookie-token characters only; bearer-mode session cookie name. |
| `DOCKERMAP_DAEMON_HOST` | Rust daemon | `127.0.0.1` | `localhost` or an IP address. A non-loopback bind also requires `DOCKERMAP_ALLOW_REMOTE_DAEMON=true` and a token. |
| `DOCKERMAP_DAEMON_PORT` | Rust daemon | `4100` | Unsigned 16-bit integer (`0`–`65535` accepted by the current parser); use `1`–`65535` for a usable listener. |
| `DOCKERMAP_PROJECT_ROOT` | Rust daemon | current working directory | Existing canonicalizable directory used as the bounded Compose/project root. |
| `DOCKERMAP_DOCKER_LABEL_FILTER` | Rust daemon | unset | Empty or one Docker label expression (`key` or `key=value`), at most 256 characters, no NUL or empty key. |
| `DOCKERMAP_PID_NAMESPACE` | Rust daemon | `auto` | `auto`, `host`, or `restricted`; `auto` and invalid values fail closed to restricted host-provider visibility. `host` is an explicit, trusted full-host deployment override. |
| `DOCKERMAP_FORCE_MOCK` | Rust daemon | `false` | **Test/internal only.** Literal `true` forces mock inventory even if Docker is reachable; never use as a deployment fallback. |
| `DOCKERMAP_ALLOW_REMOTE_DAEMON` | Node API / Rust daemon | `false` | Literal `true` permits a remote daemon URL/non-loopback daemon bind; use only with a non-empty daemon/API token. |
| `VITE_API_BASE_URL` | web build time | `http://127.0.0.1:4000` | Empty string for same-origin `/api` paths (production image), or one public API origin. It is browser-visible: no secrets. |

All variables above work inside the container. Set them under `environment:` in
`docker-compose.yml`, with `-e` on `docker run`, or from a protected env file.
