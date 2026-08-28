# DockerMap Draft Deployment

This is a practical checklist for a private review deployment on one Linux host. It is
not a public production hardening guide yet.

## Deployment Shape

Use three local pieces:

- Rust daemon on `127.0.0.1:4100`
- Node API on `127.0.0.1:4000`
- Static web app served by Nginx or another reverse proxy

The public internet should only reach the reverse proxy. The proxy should authenticate
human viewers and inject the DockerMap bearer token when it forwards `/api/*` requests to
the local Node API.

## Host Requirements

- Linux host with Docker available if you want live Docker data.
- Node.js 22 or newer.
- Rust 1.88.0 or the repo-pinned `rust-toolchain.toml`.
- Nginx, Caddy, or another HTTPS reverse proxy.
- A dedicated service user, for example `dockermap`.

## Prepare The Host

For the explicit full-host profile, create separate service identities. Only
the gateway account belongs to the host's `docker` group; the collector has no
raw Docker authority.

```bash
sudo groupadd --system dockermap-gateway
sudo useradd --system --gid dockermap-gateway --home /nonexistent --shell /usr/sbin/nologin dockermap-gateway
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin dockermap-collector
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin dockermap-api
sudo usermod -aG docker dockermap-gateway
sudo usermod -aG dockermap-gateway dockermap-collector
sudo mkdir -p /opt/dockermap
sudo chown -R root:root /opt/dockermap
```

Check out or copy the repo into `/opt/dockermap`, then run the build commands from that
directory. If you use a different path, update the systemd units and
`DOCKERMAP_PROJECT_ROOT`.

## Build On The Host

From the checked-out repo:

```bash
npm ci
npm run build:deploy
```

This builds:

- `apps/api/dist`
- `apps/web/dist`
- `crates/target/release/dockermap-daemon`
- `crates/target/release/dockermap-docker-gateway`

## External Network Behavior

Separate build-time downloads from DockerMap runtime behavior:

- Build and maintenance commands can use the network. `npm ci`, Cargo dependency
  fetches, and `npm audit --omit=dev` contact npm or Cargo registries/advisory
  services as part of installing, building, or validating the project.
- DockerMap runtime does not run package-registry, package-advisory, DNS-provider API,
  Cloudflare API, or generic external-API lookups today. Advisory/update fields may
  appear in contracts and fixtures, but the daemon does not populate them from a live
  registry or advisory service.
- The web UI currently loads Google Fonts from `fonts.googleapis.com` and
  `fonts.gstatic.com` when a browser opens it. Package the fonts locally before release
  if the review environment must avoid browser egress.

Current runtime provider behavior:

| Provider area | Default behavior | Network note |
| --- | --- | --- |
| Docker | Collector uses the local Docker Read Gateway. Only that gateway opens the raw local Docker socket. | Local host socket access, not registry access. |
| Compose and npm/package metadata | Reads bounded files under `DOCKERMAP_PROJECT_ROOT`. | No registry, audit, advisory, or `.npmrc` lookup. |
| systemd, cron, PM2, tmux, listeners | Runs fixed local read-only commands or reads local `/proc`/cron files. | No user-supplied shell and no configured external destination. |
| reverse-proxy and local DNS markers | Checks fixed local marker paths and Docker image/name signals. | Does not read proxy/DNS config contents or call DNS/proxy provider APIs. |
| Tailscale and Headscale | Runs fixed local CLI commands if the tools are installed. | DockerMap does not add tokens, URLs, or user input, but those CLIs inherit the daemon environment and may use the operator's existing daemon/config to contact their configured control plane. |
| Node API to Rust daemon | Uses `DOCKERMAP_DAEMON_URL`, defaulting to `http://127.0.0.1:4100`, and forwards `DOCKERMAP_DAEMON_TOKEN` (falling back to `DOCKERMAP_API_TOKEN`) as Bearer auth. | Non-loopback daemon URLs are rejected unless `DOCKERMAP_ALLOW_REMOTE_DAEMON=true`; the daemon itself refuses a non-loopback bind without that credential. |
| Public review access | Disabled unless you deploy a reverse proxy. | The proxy, SSO, VPN, or DNS provider may have its own network behavior outside DockerMap. |

## Environment File

Copy the example and edit it:

```bash
sudo mkdir -p /etc/dockermap
sudo cp .env.example /etc/dockermap/dockermap.env
sudo chmod 600 /etc/dockermap/dockermap.env
```

Set at least:

- `DOCKERMAP_DAEMON_TOKEN`
- `DOCKERMAP_ALLOWED_ORIGINS`
- `DOCKERMAP_PROJECT_ROOT`

Keep `DOCKERMAP_DAEMON_HOST=127.0.0.1` for draft review deployments.

## systemd Units

Copy the templates:

```bash
sudo cp deploy/systemd/dockermap-docker-gateway.service /etc/systemd/system/
sudo cp deploy/systemd/dockermap-daemon.service /etc/systemd/system/
sudo cp deploy/systemd/dockermap-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dockermap-docker-gateway dockermap-daemon dockermap-api
```

Check status:

```bash
systemctl status dockermap-docker-gateway dockermap-daemon dockermap-api --no-pager
systemctl status dockermap-api --no-pager
```

If live Docker data is required, make sure only `dockermap-gateway` can read the
Docker socket. The gateway owns `/run/dockermap/docker-read.sock` and the collector
gets only that filtered socket through its `dockermap-gateway` supplemental group.
Do not add `dockermap-collector` or `dockermap-api` to Docker's group.

## Profiles and full-host trade-offs

| Profile | Docker authority | Host-provider visibility |
| --- | --- | --- |
| Demo | None; sample data only. | None. |
| Docker-only (recommended) | Gateway-only raw socket; collector gets a filtered Unix socket and bounded project mount. | Restricted PID namespace; host providers unavailable. |
| Full-host (this systemd profile) | Gateway-only raw socket; collector never joins Docker's group. | Intentional access to bounded host providers and fixed read-only commands. |

Full-host inspection is not a claim of perfect sandboxing: it intentionally sees
host `/proc`, fixed system locations, and selected local commands. Tailscale and
Headscale remain disabled unless `DOCKERMAP_ENABLE_TAILSCALE=true` or
`DOCKERMAP_ENABLE_HEADSCALE=true` is explicitly set. DockerMap does not add their
credentials, control-plane permissions, or new egress; unavailable providers are
reported as such.

## Reverse Proxy

Start from `deploy/nginx/dockermap.conf` or `docs/deployment/REVERSE_PROXY.md`.

Before enabling it:

- Replace `dockermap.example.com`.
- Replace `replace-with-the-same-token` with the value in `DOCKERMAP_API_TOKEN`.
- Add viewer authentication such as SSO, VPN, basic auth, or an IP allowlist.
- Serve HTTPS.

For the static web app, use:

```text
/opt/dockermap/apps/web/dist
```

## Smoke Test

Local API check on the host:

```bash
DOCKERMAP_API_TOKEN="$(sudo awk -F= '/^DOCKERMAP_API_TOKEN=/{print $2}' /etc/dockermap/dockermap.env)" \
  DOCKERMAP_SMOKE_URL=http://127.0.0.1:4000 \
  ./scripts/smoke-deploy.sh
```

Proxy check from another machine:

```bash
DOCKERMAP_SMOKE_URL=https://dockermap.example.com ./scripts/smoke-deploy.sh
```

The proxy check should work without exporting `DOCKERMAP_API_TOKEN` if the proxy injects
the token server-side.

The smoke script currently verifies:

- `/api/health` returns `200`.
- Browser API routes return `401` without a token when `DOCKERMAP_API_TOKEN`
  is provided locally.
- `/api/health`, `/api/snapshot`, `/api/runtime/map`, and `/api/compose/scan` return `200`
  with the expected auth path.
- `/api/events/stream` emits at least one `snapshot` SSE event.

## Draft Deployment Definition Of Done

- `dockermap-daemon` and `dockermap-api` are running under systemd.
- The daemon is not reachable from outside the host.
- The web UI loads over HTTPS.
- `/api/health`, `/api/snapshot`, `/api/runtime/map`, and `/api/compose/scan` pass smoke
  checks through the proxy.
- `/api/events/stream` stays live through the proxy without buffering away the
  event stream.
- Viewer authentication is enabled at the proxy.
- `DOCKERMAP_API_TOKEN` is set and browser API routes reject direct unauthenticated
  requests.
