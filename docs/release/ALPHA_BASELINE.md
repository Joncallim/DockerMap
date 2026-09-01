# Private alpha baseline

This document records the reproducible engineering baseline that must be
rechecked before a `v0.1.0-alpha` tag. It is deliberately not a release
announcement or a substitute for remaining clean-host and recovery evidence.

## Certified implementation baseline

- DockerMap commit: `17d3fa69d4a9ca363e1042d6c8f627a08f8b947c`
- Hearth deployment configuration: `aaa54ef942673d3b42ea0f1570e62089f02abea8`
- Host: Linux `7.0.0-29-generic` (`x86_64`)
- Node/npm: `v22.23.2` / `10.9.8`
- Rust/Cargo: `1.88.0`
- Docker/Compose: `29.7.2` / `v5.5.0`

The validated Docker-only authority chain is:

```text
Caddy → DockerMap frontend → collector → Docker Read Gateway → Docker Engine
```

Only the gateway has the raw Docker socket. The frontend and collector have no
raw Docker socket; the collector uses the gateway's fixed, filtered Unix
socket. The exact read policy and deployment-profile trade-offs are in
[Docker authority boundary](../architecture/DOCKER_AUTHORITY_BOUNDARY.md).

## Evidence completed on the baseline

- `npm run check`
- `npm run test:e2e` (90 browser tests)
- `npm run test:e2e:a11y` (77 accessibility/responsive tests)
- `npm run test:live-docker` (isolated labelled Docker fixture)
- production-image E2E
- `npm run build:deploy`
- Hearth deployment smoke: Docker-source snapshot/runtime/logs, source
  coherence, SSE, gateway mutation denial, and component restart recovery.

No credential, session cookie, bearer token, or persistent browser profile was
retained as release evidence.

## Release-host revalidation

On 2026-09-02, the Docker-capable Hearth release host reran the isolated
live-Docker fixture against DockerMap commit
`783a7a4d3c228862c5f0a5b3647949ed9b679dd9`.

- Host: Linux `7.0.0-30-generic` (`x86_64`)
- Node/npm: `v22.23.2` / `10.9.8`
- Rust/Cargo: `1.88.0`
- Docker/Compose: `29.7.2` / `v5.5.0`
- Result: `npm run test:live-docker` passed (one isolated labelled fixture).

This is release-host evidence only. It does not substitute for the remaining
clean-host installation or host-reboot recovery evidence below.

## Known limitations before tagging

- The current private-review deployment uses DockerMap bearer-session protection
  rather than Authentik. It must prove anonymous API denial, rejection of
  client-supplied identity headers, a private daemon, and SSE through Caddy.
  Interactive SSO is deployment-specific evidence, not an alpha blocker.
- Clean-host installation and host-reboot recovery remain required before a
  broader support claim. This is a private alpha candidate only.
- DockerMap intentionally has no persistent event history, resource telemetry,
  image-update/advisory lookup, or write mode. Those are later roadmap epics.
- Full-host/native inspection is intentionally more trusted than the default
  Docker-only profile. Tailscale and Headscale remain opt-in and do not add
  credentials or control-plane permissions.

## Tagging rule

Tag only after the checklist's required boundary and build evidence has been
recorded against the exact candidate commit. Alpha tags are prereleases.
