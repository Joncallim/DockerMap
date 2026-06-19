# DockerMap Safety Notes

This file explains the main risks in plain language. DockerMap is currently an inspection
tool. It reads Docker and Compose information and can preview a Compose edit, but it does
not write files or change containers.

## What DockerMap Can Reveal

DockerMap can show:

- Container names, image names, ports, networks, volumes, and logs.
- Host folders used by Compose bind mounts.
- The difference between mounts declared in Compose and mounts Docker is actually using.
- Dry-run diffs for proposed Compose mount edits.

That information is useful for debugging, but it may also reveal private folder names,
service names, or network layout.

## Security Invariants

DockerMap must preserve these invariants until a future write-mode design explicitly
changes them:

- The Rust daemon binds to loopback by default.
- The browser-facing API only forwards fixed read-only route shapes to the daemon.
- Non-health API routes require a bearer token when `DOCKERMAP_API_TOKEN` is set.
- CORS uses explicit origins only; wildcard origins are rejected at startup.
- Remote daemon URLs are rejected unless `DOCKERMAP_ALLOW_REMOTE_DAEMON=true` is set.
- Daemon error details are hidden unless `DOCKERMAP_EXPOSE_ERROR_DETAILS=true` is set.
- Compose edit planning is dry-run only and always returns `willWrite: false`.

## Main Risks And Protections

### Host Paths

Risk: a Compose scan can reveal paths on the host, such as `/srv/app/data`.

Protections:

- The API and daemon bind to loopback by default.
- Explicit Compose file scans stay under `DOCKERMAP_PROJECT_ROOT`.
- Parent traversal like `../secret` is rejected for requested Compose file paths.
- Symlinked requested Compose paths are rejected.

### Docker Socket

Risk: Docker socket access is powerful. A process with Docker socket access can often
control the host.

Protections:

- DockerMap only reads Docker state today.
- DockerMap has no container, image, network, volume, or file write endpoints.
- Logs are read only for containers in the current snapshot.

### Compose Edits

Risk: a bad mount edit can break a service or point it at the wrong host folder.

Protections:

- Edit planning is dry-run only.
- Edit plans return a unified diff and `willWrite: false`.
- Invalid targets and unsafe source values are blocked.
- Actual writes are out of scope until backup and rollback behavior exists.

### Remote Review

Risk: a reverse proxy can turn a local tool into something reachable by other people.

Protections:

- Keep the Rust daemon private on `127.0.0.1`.
- Expose only the Node API and static web app through a proxy.
- Set `DOCKERMAP_API_TOKEN` on the Node API.
- Make the proxy authenticate viewers before it injects the API token.
- Keep `DOCKERMAP_ALLOWED_ORIGINS` limited to the review UI origin.

## Security Test Coverage

Automated tests currently cover:

- API bearer-token enforcement and public health routes.
- Explicit CORS origin reflection and wildcard-origin rejection.
- Loopback-only daemon URL validation.
- Query limits for Compose scan and edit-plan routes.
- Hidden daemon error details by default.
- Compose malformed-file diagnostics and blocked unsafe edit plans.
- Symlink bind-source detection without following the symlink during validation.
- GUI smoke coverage against daemon fallback mode.

Security checks that still require release evidence:

- Live-Docker E2E on a Docker-capable Linux host.
- Reverse-proxy bearer-token injection and SSE streaming through the public review URL.
- Direct remote inaccessibility of the daemon port.

## Out Of Scope Until Write Mode

- Writing Compose files.
- Creating backup files.
- Rolling back failed changes.
- Multi-user permissions.
- A full login/session system inside DockerMap.
