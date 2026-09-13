# Private-alpha evidence baseline

This document separates historical evidence from the still-unfilled
`v0.1.0-alpha.2` candidate record. Older successful runs are useful regression
evidence, but they cannot certify a different commit, guest, image, or scan.

## Alpha.2 exact-candidate record — pending

Fill this section only from the disposable-guest procedure after final `main`
is frozen. Do not guess a SHA, tool version, VM identity, or result.

```text
Candidate source commit: PENDING
Candidate tag: v0.1.0-alpha.2 (not authorized or created)
Guest identity: PENDING
Guest OS/kernel/architecture: PENDING
Docker/Compose: PENDING
Git/Chromium: PENDING
Image identity: PENDING
Repository full gate: PENDING
Playwright/accessibility: PENDING
Live Docker: PENDING
Deployment build: PENDING
Production-image E2E: PENDING
SBOM/checksum: PENDING
Complete and gating vulnerability scans: PENDING
Clean install/auth/private daemon: PENDING
Component restart: PENDING
Guest boot_id change and post-reboot recovery: PENDING
Rollback: PENDING
Uninstall/clean state: PENDING
Fresh reinstall: PENDING
Maintainer security decision: PENDING
```

Until every required item is complete, alpha.2 is not certified.

## Intended alpha.2 authority chain

The candidate must prove this Docker-only chain:

```text
loopback browser → DockerMap frontend/API → collector → Docker Read Gateway → Docker Engine
```

Only the gateway may hold the raw Docker socket. The frontend and collector
must not. The collector uses the gateway's filtered Unix socket, a bounded
read-only project mount, and a restricted PID namespace. The exact procedure is
[Docker-only deployment](../deployment/DOCKER.md).

## Historical alpha.1-era evidence

The following facts are retained as historical evidence, not relabelled as an
alpha.2 certification:

- DockerMap commit `17d3fa69d4a9ca363e1042d6c8f627a08f8b947c`
- Hearth deployment configuration
  `aaa54ef942673d3b42ea0f1570e62089f02abea8`
- Linux `7.0.0-29-generic` (`x86_64`)
- Node/npm `v22.23.2` / `10.9.8`
- Rust/Cargo `1.88.0`
- Docker/Compose `29.7.2` / `v5.5.0`
- passing repository, Playwright, accessibility, isolated live-Docker,
  production-image E2E, deployment-build, gateway-denial, source-coherence,
  SSE, and component-restart checks recorded at that time

On 2026-09-02, Hearth separately reran the isolated live-Docker fixture at
DockerMap commit `783a7a4d3c228862c5f0a5b3647949ed9b679dd9` using Linux
`7.0.0-30-generic`, Node/npm `v22.23.2` / `10.9.8`, Rust/Cargo `1.88.0`,
and Docker/Compose `29.7.2` / `v5.5.0`; the one labelled fixture passed.

No credential, bearer token, session cookie, or persistent browser profile was
retained in those records. Neither historical run proved alpha.2's clean-host
install, exact current SHA, actual guest reboot, rollback, removal, fresh
reinstall, or current complete vulnerability report.

## Known candidate limitations

- The supported surface is Docker-only Compose on the exact certified guest
  baseline. Native/full-host and single-container layouts are not supported.
- The frontend is loopback-only in the canonical procedure. A public reverse
  proxy or SSO layer needs separate deployment evidence.
- DockerMap keeps at most 64 identity-free Docker inventory deltas for the
  current daemon process. History is not persistent across collector restart or
  reboot and is not a Docker event stream or causality record.
- Resource telemetry, image update/advisory lookup, continuous Docker events,
  and write mode are not shipped.
- Tailscale, Headscale, and other host providers are unavailable in the
  restricted Docker-only profile.

## Tagging rule

Tag only after the checklist and candidate security record are complete for the
exact candidate and a maintainer explicitly authorizes tagging. Alpha tags are
prereleases; documentation preparation does not grant publication authority.
