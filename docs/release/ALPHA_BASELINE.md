# Private alpha baseline

This document records the reproducible engineering baseline that must be
rechecked before a `v0.1.0-alpha` tag. It is deliberately not a release
announcement or a substitute for the remaining authenticated reverse-proxy
certification.

## Certified implementation baseline

- DockerMap commit: `fb30b374d86102f8420a1815ba0c30b0b1e4c012`
- Hearth deployment configuration: `2e22669dfd6d4ecce5f3631c47dce01cbc05cc4d`
- Host: Linux `7.0.0-29-generic` (`x86_64`)
- Node/npm: `v22.23.2` / `10.9.8`
- Rust/Cargo: `1.88.0`
- Docker/Compose: `29.7.2` / `v5.5.0`

The validated Docker-only authority chain is:

```text
Caddy / Authentik → DockerMap frontend → collector → Docker Read Gateway → Docker Engine
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

## Known limitations before tagging

- A genuine Authentik-authenticated browser traversal through the public route
  remains required by [#16](https://github.com/Joncallim/DockerMap/issues/16)
  and the alpha epic [#63](https://github.com/Joncallim/DockerMap/issues/63).
  Internal trusted-header smoke and public unauthenticated redirects do not
  substitute for that check.
- The public reverse-proxy smoke script must be executed against the final
  release candidate without recording credentials.
- DockerMap intentionally has no persistent event history, resource telemetry,
  image-update/advisory lookup, or write mode. Those are later roadmap epics.
- Full-host/native inspection is intentionally more trusted than the default
  Docker-only profile. Tailscale and Headscale remain opt-in and do not add
  credentials or control-plane permissions.

## Tagging rule

Do not tag an alpha until the remaining #16/#63 authentication and
reverse-proxy checks have been recorded against the exact candidate commit.
