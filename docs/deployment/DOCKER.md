# Running DockerMap In Docker

This is the fastest way to try DockerMap. One image runs all three pieces (Rust daemon,
Node API, and the built web app behind nginx) and exposes a single port.

## Files

- [`Dockerfile`](../../Dockerfile): multi-stage build (Rust daemon, Node/web build, runtime image).
- [`docker-compose.yml`](../../docker-compose.yml): one-service Compose file for local use.
- [`deploy/docker/nginx.conf`](../../deploy/docker/nginx.conf): serves the web app and proxies `/api/*`.
- [`deploy/docker/entrypoint.sh`](../../deploy/docker/entrypoint.sh): starts the daemon, the API, then nginx in the foreground.

## Run With Docker Compose

```bash
docker compose up --build
```

Open `http://127.0.0.1:3233`.

## Run With Plain Docker

```bash
docker build -t dockermap:local .
docker run --rm -p 3233:3233 \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v "$PWD":/opt/dockermap/project:ro \
  dockermap:local
```

## What The Mounts Are For

- `/var/run/docker.sock` (read-only): lets the daemon read real container, network, and
  volume state from the host's Docker Engine. Omit it and DockerMap falls back to mock
  data when `DOCKERMAP_ALLOW_MOCK=true`.
- `/opt/dockermap/project` (read-only): the Compose project directory DockerMap scans.
  Point this at whichever project you want to inspect.

## Optional Docker Label Filter

Set `DOCKERMAP_DOCKER_LABEL_FILTER` on the daemon to inspect only Docker resources
that carry one label expression:

```yaml
environment:
  DOCKERMAP_DOCKER_LABEL_FILTER: "com.dockermap.fixture=abc123"
```

When unset, DockerMap inspects all visible Docker containers, networks, and volumes.
When set, the filter is applied directly to Docker Engine list calls before DockerMap
builds its snapshot. This is useful for sandbox fixtures and release-host tests where
unrelated host resources must stay out of the UI.

## Security Note

Mounting the Docker socket gives the container the same level of access as the Docker
daemon itself. Only do this on hosts you trust, and keep the read-only (`:ro`) flag.
See [docs/security/THREAT_MODEL.md](../security/THREAT_MODEL.md) for the full risk
discussion. This single-container image is meant for local/dev use; for an
internet-reachable review deployment, follow
[docs/deployment/REVERSE_PROXY.md](REVERSE_PROXY.md) instead.

## Environment Variables

All variables from [`.env.example`](../../.env.example) work inside the container. Set
them under `environment:` in `docker-compose.yml` or with `-e` on `docker run`.
