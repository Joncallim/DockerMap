# Private-alpha support policy

DockerMap's private alpha is tested and supported only on the following
baseline. Other environments may work, but they are not release evidence until
they have passed the documented gates.

## Supported baseline

| Component | Supported baseline |
| --- | --- |
| Linux | Current Ubuntu LTS-compatible `x86_64` host with a supported Docker Engine installation |
| Docker Engine | 29.x or later compatible with the Compose plugin |
| Docker Compose | v5.x plugin |
| Node.js | 22.x LTS |
| npm | Version bundled with the supported Node 22 release |
| Rust/Cargo | 1.88.0 (the pinned toolchain) |
| Browser | Current Chromium family; Playwright Chromium is the automated baseline |

## Deployment profiles

- **Demo** needs no Docker or host providers and is sample data only.
- **Docker-only** is the recommended supported container profile. It uses the
  filtered Docker Read Gateway, a bounded read-only project mount, and no host
  PID namespace.
- **Full-host/native** is supported only for operators who explicitly accept
  its additional host-provider visibility. It is not equivalent to the
  Docker-only profile and must use the documented systemd units.

## Update and support expectations

- Pin the release tag or exact commit for a deployment. Do not deploy an
  arbitrary moving branch as release evidence.
- Run the release checklist after upgrading Docker, Docker Compose, Node, Rust,
  or the host operating system.
- Report a supported-environment defect with the DockerMap SHA, deployment
  profile, sanitized command result, and relevant diagnostics. Never include
  tokens, cookies, raw logs containing secrets, or Docker socket paths from
  unrelated workloads.
- No compatibility promise is made for non-Linux Docker Desktop, Podman,
  rootless Docker, Kubernetes, or unsupported browser engines during alpha.
