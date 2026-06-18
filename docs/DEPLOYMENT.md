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

Start from `deploy/nginx/dockermap.conf` or `docs/REVERSE_PROXY.md`.

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
