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
- Every browser API route requires a bearer token when `DOCKERMAP_API_TOKEN` is set.
- Every daemon route, including health and fallback responses, requires a bearer token when
  `DOCKERMAP_DAEMON_TOKEN` is set (falling back to `DOCKERMAP_API_TOKEN`); non-loopback
  daemon binding additionally requires that credential.
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
- Runtime relationship evidence is a separate publication surface. It is a closed, bounded
  record with no generic metadata/config/argv field; evidence values pass the same
  redaction and control-character publication boundary as all other daemon response text.
  A malformed evidence record is rejected at the API schema boundary rather than
  partially published.
- Observed Docker inventory history is a daemon-lifetime, maximum-64-row
  comparison of already-sanitized Docker snapshots. It never uses Docker's event
  stream or persists rows. It exposes only opaque event/container identities and
  closed status classes, resets on source changes, and is empty for mock fallback.

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

- Only the Docker Read Gateway mounts the raw socket. Frontend/API has neither
  that mount nor the filtered socket; the collector has only the filtered Unix
  socket and no raw-socket fallback.
- The gateway is default-deny and permits only the measured container/network/
  volume inventory calls, fixed bounded non-following logs, bounded Docker
  events, and—only when no Docker label scope is configured—the exact finite
  per-container stats request `stream=false&one-shot=true`. It rejects
  mutations, inspect/archive/top/exec, streaming or malformed stats, every
  stats request under a configured label scope, images/builds, ambiguous
  targets, unknown queries, bodies, and upgrades before opening Docker.
  Gateway permission does not publish raw stats or relax collector cadence or
  redaction obligations; a collector-side inventory filter is not stats-route
  authorization.
- A read-only socket mount is retained as a filesystem safeguard but is not
  treated as Docker API authorization.

### Observed Inventory History

Risk: a history feature could leak raw Docker metadata or imply that DockerMap
knows why a service changed.

Protections:

- History is derived after snapshot sanitization and accepts only the closed
  appeared/disappeared/status-changed vocabulary and `running`/`stopped`/`other`
  status classes.
- Public event IDs and revisions are opaque; raw Docker IDs, container names,
  status strings, paths, diagnostics, and Docker event payloads are not retained
  or returned.
- The baseline and rows reset across Docker/mock source transitions; mock is an
  explicit empty/unavailable response rather than relabelled Docker history.
- The browser renders observed rows only when authenticated `/api/history` data
  attests Docker source and the current live model revision. Mismatched, missing,
  mock, and demo data fail closed.
- A row records only an inventory delta between successful publications. It is
  not evidence of a deployment, restart, failure, recovery, causal chain,
  compromise, reachability, or impact.

### Current Docker Resource Telemetry

Risk: Docker stats can expose container names, process-adjacent details,
network-interface counters, long-lived activity patterns, or unbounded work.

Protections:

- The gateway permits exactly one finite per-container stats request and only
  on an unfiltered profile. A configured Docker label scope denies every stats
  request before it reaches Docker because the stats endpoint cannot express
  that scope.
- The daemon chooses targets solely from its published sanitized snapshot; a
  caller cannot choose a container, query, cadence, or timeout.
- Retention is bounded to 16 current opaque-container rows, with at most two
  in-flight requests, a 750 ms request timeout, and an 8-second metric expiry.
  It stores private previous numeric counters only long enough to derive the
  next bounded rate.
- Raw Docker stats, names and raw IDs, interface names, PIDs, counter values,
  and historical series are discarded at the collector boundary. They do not
  enter cache publication, API bytes, contracts, fixtures, or the browser.
- An active response must attest live Docker source, the current model revision,
  and Docker observation revision; each browser-rendered value must also match
  the current live model and an unexpired metric. Source changes discard public
  values and private baselines; mismatched, expired, missing, mock, and demo
  data fail closed.

Current limitations: this is numeric current-state evidence only. It does not
authorize streaming stats, prove performance cause or workload health, or make
the label-scoped fixture eligible for stats collection. The focused unfiltered
live-Docker proof is deliberately separate and requires both exact opt-ins
(`DOCKERMAP_E2E_LIVE_DOCKER=1` and
`DOCKERMAP_E2E_UNFILTERED_TELEMETRY=1`); it checks the fixed request,
authentication, opaque bounded publication, source reset, and owned-fixture
cleanup. It does not turn the ordinary label-scoped live browser suite into a
green release gate.

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
- The browser UI uses its local/system font stack and does not request a hosted
  font service at runtime.
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

- Keep the Rust daemon private on `127.0.0.1`; if remote daemon access is unavoidable,
  set `DOCKERMAP_DAEMON_TOKEN` and protect that endpoint independently.
- Expose only the Node API and static web app through a proxy.
- Set `DOCKERMAP_API_TOKEN` on the Node API.
- Make the proxy authenticate viewers before it injects the API token.
- Keep `DOCKERMAP_ALLOWED_ORIGINS` limited to the review UI origin.

## Security Test Coverage

Automated tests currently cover:

- Browser and daemon bearer-token enforcement, including health, version aliases, fallback routes,
  API-to-daemon credential propagation, and remote-bind rejection without a daemon token.
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
- Runtime-edge evidence schema rejection and publication redaction, including malformed
  provenance fields and secret/control-character-bearing evidence summaries or references.
- Observed-history baseline, source-reset, mock-empty, cap/newest-first,
  sanitization, schema-validation, auth, and browser revision-coherence cases.
- GUI smoke coverage against daemon fallback mode.
- Route and middleware completeness: every Express layer must be wrapped in
  `trackedMiddleware()` and every route registered through `registerRoute()` with
  `ROUTE_MANIFEST`. The completeness walker fails CI for any untracked
  response-capable layer; maintain the tracked middleware list in
  `apps/api/src/index.ts` (lines 38-43).

Security checks that still require release evidence:

- Live-Docker E2E on a Docker-capable Linux host.
- Reverse-proxy bearer-token injection and SSE streaming through the public review URL.
- Direct remote inaccessibility of the daemon port.
- A release decision on whether Tailscale/Headscale delegated CLI collection is
  enabled for the candidate. The local/system browser font stack has no
  hosted-font exception.
- Package/advisory network-egress behavior for package, Python/native-process, DNS, and
  external-API collectors if those routes later land or become configurable.

## Out Of Scope Until Write Mode

- Writing Compose files.
- Creating backup files.
- Rolling back failed changes.
- Multi-user permissions.
- A full login/session system inside DockerMap.
