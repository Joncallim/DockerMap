# Private-alpha support policy

DockerMap `v0.1.0-alpha.2` has one intended support surface: the split
Docker-only Compose profile on an Ubuntu Server 26.04 LTS `x86_64` guest. The
candidate does not become certified merely because it meets these prerequisites;
the exact final SHA must pass the clean-host procedure and record its actual
versions first.

## Candidate requirements

| Component | Candidate requirement |
| --- | --- |
| Linux | Ubuntu Server 26.04 LTS `x86_64` guest using systemd to start Docker; record the exact point image and kernel |
| Docker | Supported Docker Engine release with the Docker Compose plugin |
| Source checkout | Git checkout detached at the exact certified 40-character SHA |
| Browser | Current Chromium family; Playwright Chromium is the automated baseline |
| Network | Loopback frontend by default; collector has no host-published port |

Node.js, npm, Rust, and Cargo are build inputs inside the multi-stage Docker
image for this deployment profile. Source-development checks use Node.js 22.x
LTS and the Rust toolchain pinned in `rust-toolchain.toml`; they are not extra
host runtime requirements for the Docker-only install.

The exact Linux, kernel, Docker, Compose, browser, image, and candidate SHA
verified by certification belong in [the alpha baseline](ALPHA_BASELINE.md).
Do not guess them in advance or broaden this table from an older Hearth run.

## Supported profile

The Docker-only profile uses:

- the filtered Docker Read Gateway as the only raw-socket holder;
- a bounded read-only project mount for the collector;
- an internal Compose network between frontend and collector;
- `DOCKERMAP_PID_NAMESPACE=restricted`, so host providers are unavailable;
- separate browser API and daemon bearer credentials stored outside the repo;
- loopback-only browser publication unless an independently reviewed proxy is
  added.

The following are not supported by alpha.2: the single-container compatibility
profile, native/full-host systemd deployment, public internet exposure,
non-Linux Docker Desktop, Podman, rootless Docker, Kubernetes, non-Chromium
browsers, and remote-daemon mode. They may work, but they are not release
evidence.

## Update and support expectations

- Pin the exact certified commit or release tag; never deploy a moving branch.
- Follow [the Docker-only procedure](../deployment/DOCKER.md) for installation,
  smoke checks, restart, real guest reboot, rollback, removal, and reinstall.
- Rerun certification after changing the guest OS, Docker, Compose, base image,
  or candidate commit.
- Report defects with the DockerMap SHA, deployment profile, sanitized command
  results, and relevant diagnostics. Never include tokens, cookies, raw logs
  containing secrets, or unrelated workload details.
- DockerMap's observed inventory history is bounded, identity-free, and kept
  only for the current daemon lifetime; reboot recovery does not imply history
  persistence.
