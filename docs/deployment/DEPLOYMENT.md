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

Create the service user and place the repo where the systemd templates expect it:

```bash
sudo useradd --system --home /opt/dockermap --shell /usr/sbin/nologin dockermap
sudo mkdir -p /opt/dockermap
sudo chown dockermap:dockermap /opt/dockermap
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
| Docker | Reads the local Docker socket. | Local host socket access, not registry access. |
| Compose and npm/package metadata | Reads bounded files under `DOCKERMAP_PROJECT_ROOT`. | No registry, audit, advisory, or `.npmrc` lookup. |
| systemd, cron, PM2, tmux, listeners | Runs fixed local read-only commands or reads local `/proc`/cron files. | No user-supplied shell and no configured external destination. |
| reverse-proxy and local DNS markers | Checks fixed local marker paths and Docker image/name signals. | Does not read proxy/DNS config contents or call DNS/proxy provider APIs. |
| Tailscale and Headscale | Runs fixed local CLI commands if the tools are installed. | DockerMap does not add tokens, URLs, or user input, but those CLIs inherit the daemon environment and may use the operator's existing daemon/config to contact their configured control plane. |
| Node API to Rust daemon | Uses `DOCKERMAP_DAEMON_URL`, defaulting to `http://127.0.0.1:4100`. | Non-loopback daemon URLs are rejected unless `DOCKERMAP_ALLOW_REMOTE_DAEMON=true`. |
| Public review access | Disabled unless you deploy a reverse proxy. | The proxy, SSO, VPN, or DNS provider may have its own network behavior outside DockerMap. |

## Environment File

Copy the example and edit it:

```bash
sudo mkdir -p /etc/dockermap
sudo cp .env.example /etc/dockermap/dockermap.env
sudo chmod 600 /etc/dockermap/dockermap.env
```

Set at least:

- `DOCKERMAP_API_TOKEN`
- `DOCKERMAP_ALLOWED_ORIGINS`
- `DOCKERMAP_PROJECT_ROOT`

Keep `DOCKERMAP_DAEMON_HOST=127.0.0.1` for draft review deployments.

## systemd Units

Copy the templates:

```bash
sudo cp deploy/systemd/dockermap-daemon.service /etc/systemd/system/
sudo cp deploy/systemd/dockermap-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dockermap-daemon dockermap-api
```

Check status:

```bash
systemctl status dockermap-daemon --no-pager
systemctl status dockermap-api --no-pager
```

If live Docker data is required, make sure the `dockermap` service user can read the
Docker socket. The provided daemon unit uses `SupplementaryGroups=docker`; the user must
also be a member of that group on hosts that require it.

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

## Draft Deployment Definition Of Done

- `dockermap-daemon` and `dockermap-api` are running under systemd.
- The daemon is not reachable from outside the host.
- The web UI loads over HTTPS.
- `/api/health`, `/api/snapshot`, `/api/runtime/map`, and `/api/compose/scan` pass smoke
  checks through the proxy.
- Viewer authentication is enabled at the proxy.
- `DOCKERMAP_API_TOKEN` is set and non-health API routes reject direct unauthenticated
  requests.
