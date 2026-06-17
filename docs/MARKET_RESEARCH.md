# DockerMap Market Research

## Executive Summary

DockerMap has a plausible niche among developers and small operators running Docker Compose on a single host, home lab, VPS, NAS, or remote development box. The clearest demand signal is not for another generic container dashboard. It is for a focused tool that explains how runtime objects, Compose declarations, host paths, named volumes, and logs relate to each other, especially when users are debugging bind mounts, cross-platform paths, and persistent state.

The best positioning is:

- Local-first Docker and Compose path mapping.
- Read-only by default, with dry-run edit plans before write mode.
- Designed for people who understand enough Docker to be dangerous, but still lose time tracing mounts, files, networks, and logs by hand.

## Demand Signals

### Docker Compose Volumes And Bind Mounts

Forum, Reddit, Stack Overflow, and GitHub issue traffic repeatedly shows confusion around bind mounts versus named volumes, short versus long syntax, host path creation, file versus directory mounts, and OS-specific path behavior.

Representative sources:

- Docker Docs: volumes are the preferred Docker-managed persistence mechanism, while bind mounts depend on host filesystem layout. Source: https://docs.docker.com/engine/storage/volumes/
- Docker Docs: bind mounts connect a host file or directory directly into a container. Source: https://docs.docker.com/engine/storage/bind-mounts/
- Reddit r/docker: users explicitly ask why people use bind mounts when Docker docs recommend named volumes. Source: https://www.reddit.com/r/docker/comments/1h85f4b/why_do_i_see_most_people_use_bind_mounts_when/
- Reddit r/docker: users describe confusion because Compose calls both named volumes and bind mounts `volumes`. Source: https://www.reddit.com/r/docker/comments/1fnnyxs/volumes_versus_bind_mounts/
- Docker Community Forums: users ask how to make a volume at a specific host path, and answers usually have to explain the bind mount versus named volume distinction. Source: https://forums.docker.com/t/how-to-make-volume-on-a-specific-path/92694
- Docker Community Forums: users still ask about short versus long mount syntax behavior. Source: https://forums.docker.com/t/short-vs-long-volume-declaration-syntax-behavior/82730
- Stack Overflow: high-traffic questions ask how to mount host directories and how to distinguish bind mounts from managed volumes. Sources: https://stackoverflow.com/questions/40905761/how-do-i-mount-a-host-directory-as-a-volume-in-docker-compose and https://stackoverflow.com/questions/41299514/docker-compose-define-mount-for-bind-mount-and-managed-mount
- Docker Compose and Docker for Linux GitHub issues show edge cases around single-file mounts, trailing slashes, colons in paths, and platform differences. Sources: https://github.com/docker/for-linux/issues/1496, https://github.com/docker/compose/issues/8533, https://github.com/docker/compose/issues/12993, and https://github.com/microsoft/WSL/issues/1854

Implication for DockerMap:

- The path-map view is a real user problem, not an invented feature.
- The product should keep using the exact language users encounter: source, target, bind, named volume, anonymous volume, read-only, missing host path, symlink, duplicate target, and unresolved variable.
- A visual graph is useful only if paired with diagnostics and concrete file origins.

### Local And Self-Hosted Operators

Self-hosted and small-server users frequently run Compose on a VPS, NAS, or home lab and need practical debugging rather than Kubernetes-grade orchestration. These users value:

- local-first tooling;
- no cloud account;
- quick inspection of a single host;
- logs and resource visibility;
- safe edits to Compose files;
- reverse proxy awareness.

This fits DockerMap better than enterprise fleet management. Competing head-on with Portainer, Docker Desktop, or Kubernetes dashboards is less attractive than owning the "explain this one host and its persistent paths" workflow.

### PM2, systemd, tmux, Supervisor, And Other Persistent Runtimes

There is also demand around non-container persistent processes:

- PM2 official docs position it as a daemon process manager for keeping apps online.
- PM2's ecosystem includes several third-party dashboards and GUIs, which indicates demand for visual process management.
- Reddit r/node discussions show PM2 is still used on VPS deployments and debated against Docker/Kubernetes.
- tmux official docs describe detachable sessions that keep programs running and can be reattached later.
- systemd is the default service manager on most Linux hosts and exposes service state through `systemctl`.

Representative sources:

- PM2 quick start and overview: https://pm2.keymetrics.io/docs/usage/quick-start/ and https://pm2.io/docs/runtime/overview/
- PM2 project README: https://github.com/Unitech/pm2
- Third-party PM2 dashboards: https://github.com/orchidfiles/pm2-dashboard, https://github.com/oxdev03/pm2.web, https://github.com/thechandanbhagat/ezpm2gui, and https://github.com/orangecoding/pm2-hawkeye
- Reddit r/node PM2 discussions: https://www.reddit.com/r/node/comments/yj85v1/pm2_what_problem_does_it_solve/, https://www.reddit.com/r/node/comments/1au4doh/is_pm2_still_the_way_to_go_in_2024/, and https://www.reddit.com/r/node/comments/p6ezi6/how_to_keep_a_nodejs_app_running_after_i_close/
- tmux wiki: https://github.com/tmux/tmux/wiki and https://github.com/tmux/tmux/wiki/Getting-Started
- systemd/systemctl docs: https://www.man7.org/linux/man-pages/man1/systemctl.1.html and https://www.freedesktop.org/software/systemd/man/systemd.service.html

Implication for DockerMap:

- Expanding beyond Docker is possible, but it should be framed as "persistent runtime map" rather than bolting unrelated tools onto a Docker dashboard.
- PM2 and systemd are better first additions than tmux because they expose structured process/service metadata. tmux is useful, but it is more session-oriented and harder to model safely.

## Likely Users

### Solo Developer On A VPS

Runs one or more apps with Docker Compose, PM2, or systemd. Wants to know what is running, where data is stored, why a bind mount is wrong, and what will change before editing Compose.

Priority workflows:

- inspect Compose services, networks, volumes, and bind mounts;
- trace app logs;
- validate path mappings before deploy;
- compare old and proposed path changes.

### Self-Hosted/Home-Lab Operator

Runs services on a NAS, mini PC, or remote box. Often uses bind mounts to put data under visible host folders. Needs safer management without learning every Docker edge case.

Priority workflows:

- see which service owns which host folder;
- identify missing paths and permissions-adjacent problems;
- avoid deleting or remapping persistent data accidentally;
- export a map for backup planning.

### Small Team Maintaining Compose Stacks

Uses Compose for internal services, staging, or edge deployments. Needs reviewable diffs and validation around paths and persistent storage.

Priority workflows:

- dry-run edits;
- diagnostics in CI;
- exported reports;
- policy checks for risky mounts.

### Node Developer Using PM2

Runs Node/Bun apps directly on a host with PM2, sometimes alongside Docker. Wants process status, logs, restart counts, startup persistence, and reverse proxy mapping.

Priority workflows:

- map PM2 apps to ports, env files, working directories, logs, and startup scripts;
- compare PM2-managed apps with Docker-managed services;
- detect orphaned processes and stale configs.

## Competitive Landscape

### Portainer

Portainer is broad container management. DockerMap should not compete by adding every Docker action. The opportunity is narrower: Compose path understanding, dry-run path edits, and local-first safety.

### Docker Desktop

Docker Desktop gives container visibility but is not a specialized Compose path-debugging or host persistence map. DockerMap can be useful on Linux servers and remote hosts where Docker Desktop is not the normal operator interface.

### Dozzle And Log Viewers

Dozzle-like tools focus on logs. DockerMap should include logs as context, not as its whole product.

### PM2 Dashboards

PM2-specific dashboards already exist and validate demand for web-based PM2 monitoring. DockerMap should only enter this area if it can show relationships across runtimes: PM2 app -> port -> reverse proxy -> host directory -> Docker dependency.

### Generic Observability

Grafana/Prometheus and APM tools solve metrics and traces. DockerMap should avoid becoming a metrics platform.

## Product Direction

### Keep The Core Narrow

The core promise should remain:

- discover running Docker state;
- parse Compose files;
- map host paths to container paths;
- diagnose unsafe or confusing mount declarations;
- produce dry-run edit plans.

### Add Persistent Runtime Providers Behind One Model

Make expansion provider-based:

- `docker`: containers, images, networks, volumes, logs.
- `compose`: services, mounts, project files, edit plans.
- `pm2`: apps, script path, cwd, env file, status, restart count, ports if detectable, logs.
- `systemd`: services, unit files, working directories, exec commands, restart policy, logs via journald.
- `tmux`: sessions, windows, panes, commands, attached/detached state.
- `tailscale` / `headscale`: tailnet peers, online state, DNS names, and tailnet IPs.
- `reverse_proxy`: nginx, Nginx Proxy Manager, Traefik, Caddy, HAProxy, Envoy, Apache httpd, Cloudflare Tunnel, and frp markers.
- `local_dns`: Pi-hole, AdGuard Home, dnsmasq, Unbound, CoreDNS, and Technitium DNS markers.
- later: Supervisor, launchd, cron, Docker contexts, SSH remotes.

### Recommended Expansion Order

1. Complete Docker Compose path edit safety.
2. Add export/report mode for backup and review.
3. Add PM2 read-only provider.
4. Add systemd read-only provider.
5. Add cross-runtime graph edges where evidence is strong.
6. Add tmux read-only provider after PM2/systemd because tmux data is less structured.

## Feasibility Notes

PM2 is feasible:

- `pm2 jlist` exposes JSON process metadata.
- Logs are accessible through PM2 paths and `pm2 logs`.
- Actions such as restart/stop are possible later, but should start read-only.

systemd is feasible on Linux:

- `systemctl list-units`, `systemctl show`, and unit files expose structured service metadata.
- journald can provide logs when permissions allow.
- User services and system services need separate handling.

tmux is feasible but lower priority:

- `tmux list-sessions`, `list-windows`, and `list-panes` can expose session state.
- Capturing pane commands and scrollback can leak secrets, so defaults must be conservative.
- tmux is better as a "session inventory" provider than a process supervisor provider.

Supervisor is feasible:

- `supervisorctl status` and XML-RPC can expose process state.
- It is less common in newer Node/self-hosted conversations than PM2/systemd, but useful for Python stacks.

## Security And Privacy Requirements For Expansion

- Keep all providers read-only until the write model is explicit.
- Default to loopback binding.
- Do not expose environment variables by default.
- Redact secrets from process args, env files, logs, and unit files.
- Treat shell commands, service files, pane content, and logs as sensitive host data.
- Require explicit opt-in before remote host collection.

## Bottom Line

There is enough visible demand to continue DockerMap, but the wedge should stay specific: local-first runtime and persistence mapping for Docker Compose users. PM2 and systemd expansion is possible and commercially sensible if implemented as read-only providers under a broader "persistent runtime map" concept. tmux is possible but should come later because it is less structured and carries higher accidental secret exposure risk.
