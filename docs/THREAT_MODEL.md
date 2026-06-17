# DockerMap Threat Model

## Scope

This threat model covers backend behavior before GUI editing work: the Rust daemon, Rust core parsing/validation, Node/Express API, Docker socket reads, Compose file reads, and dry-run edit planning.

## Assets

- Host filesystem paths referenced by Compose files.
- Compose files and proposed edit diffs.
- Docker runtime metadata, container names, image names, networks, volumes, and logs.
- Docker socket access from the daemon process.
- Local API and daemon availability.

## Trust Boundaries

- Browser or API client to Node API.
- Node API to Rust daemon.
- Rust daemon to Docker socket.
- Rust daemon/core to host filesystem.
- Optional reverse proxy to Node API.

## Primary Risks And Controls

### Host Path Disclosure

Risk: Compose scans expose host paths to API clients.

Controls:
- API and daemon bind to loopback by default.
- Explicit file scanning is scoped to `DOCKERMAP_PROJECT_ROOT`.
- Parent traversal and symlinked requested paths are rejected.
- Remote daemon upstreams require `DOCKERMAP_ALLOW_REMOTE_DAEMON=true`.

### Symlink Traversal

Risk: A Compose filename or bind source can point outside the intended project.

Controls:
- Requested Compose file path components are checked with `symlink_metadata`.
- Bind source symlinks are reported as diagnostics and not followed during validation.

### Docker Socket Exposure

Risk: Docker socket access is effectively privileged host access.

Controls:
- Docker access remains read-oriented.
- Basic Compose mapping works without Docker.
- No mutation endpoints exist for containers, images, networks, volumes, or files.
- Logs are only read for containers present in the cached snapshot.

### Edit Safety

Risk: Path edits can break containers or redirect writes to sensitive host paths.

Controls:
- Edit planning is dry-run only.
- Edit plans return a unified diff and `willWrite: false`.
- Unsupported source edits are blocked.
- Invalid targets and NUL-containing values are blocked.

### Reverse Proxy Exposure

Risk: A reverse proxy can turn a local-only tool into a remotely reachable control surface.

Controls:
- Local loopback binding is the default.
- Roadmap now requires explicit reverse proxy guidance, forwarded-header trust configuration, timeout limits, SSE buffering guidance, and authentication before non-local exposure.

## Out Of Scope Until Write Mode

- Actual Compose file mutation.
- Backup file creation.
- Rollback execution.
- Authentication/session flows.
- Multi-user authorization.
