# DockerMap Safety Notes

This file explains the main risks in plain language. DockerMap is currently an inspection
tool. It reads Docker and Compose information and can preview a Compose edit, but it does
not write files or change containers.

## What DockerMap Can Reveal

DockerMap can show:

- Container names, image names, ports, networks, volumes, and logs.
- Host folders used by Compose bind mounts.
- systemd unit names, tmux session names, package/service metadata, reverse-proxy markers,
  DNS markers, and native process relationships when those providers are enabled.
- The difference between mounts declared in Compose and mounts Docker is actually using.
- Dry-run diffs for proposed Compose mount edits.

That information is useful for debugging, but it may also reveal private folder names,
service names, process arguments, or network layout.

## Security Invariants

DockerMap must preserve these invariants until a future write-mode design explicitly
changes them:

- The Rust daemon binds to loopback by default.
- The browser-facing API only forwards fixed read-only route shapes to the daemon.
- Host-provider commands are fixed read-only invocations, never user-supplied shell.
- Non-health API routes require a bearer token when `DOCKERMAP_API_TOKEN` is set.
- CORS uses explicit origins only; wildcard origins are rejected at startup.
- Remote daemon URLs are rejected unless `DOCKERMAP_ALLOW_REMOTE_DAEMON=true` is set.
- Daemon error details are hidden unless `DOCKERMAP_EXPOSE_ERROR_DETAILS=true` is set.
- Compose edit planning is dry-run only and always returns `willWrite: false`.
- Filesystem inspection stays bounded to explicit Compose targets, documented provider paths,
  or fixed config locations; DockerMap must not do unbounded host-wide scans for discovery.
- Package registry, advisory, DNS-provider API, and generic external-API lookups are not
  enabled in DockerMap runtime by default; any future lookup must be opt-in or explicitly
  documented before release.
- Package, service, process, unit, and proxy inspection must not leak secrets from env vars,
  command lines, service files, credentials, or inline auth URLs.

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

### Host Provider Expansion

Risk: systemd units, tmux panes, Python/native processes, reverse proxies, DNS configs, and
package metadata can expose secrets or trigger accidental host-wide scanning.

Protections:

- Provider commands stay fixed and read-only, such as list/status/introspection calls.
- Provider discovery stays bounded to explicit request parameters, known config locations, or
  capped fixture-like scans instead of recursive host crawling.
- Python/native-process collection must not read `/proc/<pid>/environ`, process memory,
  open files, `/proc/<pid>/fd` targets, terminal scrollback, logs, or cwd contents beyond
  bounded manifest checks under the configured project root.
- Native-process command summaries must be tokenized, redacted, or omitted before they reach
  nodes, edges, diagnostics, fixtures, screenshots, logs, or issue comments. Raw argv and
  raw `ps args` must never leave the provider boundary.
- Python project discovery must not read `.env`, `.pypirc`, `pip.conf`, `pip.ini`, Poetry auth
  config, private-index credentials, or virtualenv package trees.
- Package registry/advisory traffic, DNS-provider API calls, Cloudflare API calls, and
  generic external-API lookups are disabled or not implemented in DockerMap runtime today.
- Tailscale and Headscale discovery use fixed local CLI commands when those tools are
  installed. DockerMap does not add tokens, URLs, or user input, but those commands inherit
  the daemon environment and the installed tools may use the operator's existing daemon/config
  to contact their configured control plane.
- The browser UI currently loads Google Fonts from Google-hosted font endpoints. Treat
  that as browser asset egress, separate from daemon/provider egress.
- Sensitive values from env files, process args, unit files, proxy configs, and package auth
  settings must be redacted or omitted before returning API responses.
- Security validation for provider routes must run locally without Docker, systemd, tmux, or a
  GUI so the release gate does not depend on a specific host setup.

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
- Query limits for Compose scan, edit-plan, and logs routes.
- Hidden daemon error details by default.
- HTTP and SSE daemon-error redaction unless detail exposure is explicitly enabled.
- Read-only API behavior for authenticated callers, including rejected write verbs.
- Fixed daemon proxy path shaping for logs, container detail, and Compose scan requests.
- Compose malformed-file diagnostics and blocked unsafe edit plans.
- Symlink bind-source detection without following the symlink during validation.
- Provider redaction fixtures for systemd, tmux, npm/package metadata, native-process-shaped
  output, reverse-proxy markers, DNS markers, provider diagnostics, and provider edge metadata.
- GUI smoke coverage against daemon fallback mode.

Security checks that still require release evidence:

- Live-Docker E2E on a Docker-capable Linux host.
- Reverse-proxy bearer-token injection and SSE streaming through the public review URL.
- Direct remote inaccessibility of the daemon port.
- A release decision on whether Tailscale/Headscale delegated CLI collection and
  Google-hosted web fonts are acceptable defaults for the private review environment.
- Package/advisory network-egress behavior for package, Python/native-process, DNS, and
  external-API collectors if those routes later land or become configurable.

## Out Of Scope Until Write Mode

- Writing Compose files.
- Creating backup files.
- Rolling back failed changes.
- Multi-user permissions.
- A full login/session system inside DockerMap.
