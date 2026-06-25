# DockerMap Sandbox Fixture

Use the sandbox fixture when you want DockerMap to inspect a realistic but isolated
topology. It creates a labeled Docker Compose project, temporary provider command stubs,
and a bounded project root under `/tmp`.

## Start

```bash
scripts/dockermap-fixture-up.sh --verify
```

The script starts:

- a labeled Compose stack with containers, networks, volumes, bind mounts, reverse-proxy
  markers, DNS markers, and Tailscale/Headscale marker containers;
- a generated npm project tree under the fixture project root;
- temporary fixed-output command stubs for Tailscale, Headscale, systemd, PM2, tmux,
  and crontab;
- DockerMap daemon, API, and web processes on loopback-only random ports.

The daemon is started with `DOCKERMAP_DOCKER_LABEL_FILTER` so DockerMap sees only the
fixture-labeled Docker resources. The script also starts an unlabeled control container
and verifies it does not appear in `/api/snapshot`.

## Stop

```bash
scripts/dockermap-fixture-down.sh
```

If you used a custom state path, pass the same path:

```bash
scripts/dockermap-fixture-down.sh --state-file /tmp/my-dockermap-fixture.env
```

The teardown script is idempotent. It stops only the DockerMap processes recorded in the
state file, removes the unlabeled control container by name, runs Compose `down --volumes`
for the recorded fixture project, deletes the temporary fixture root, and reports any
remaining Docker resources with the fixture label.

## Cleanup Boundary

The fixture removes resources and files that it creates. It does not remove Docker base
images pulled by Docker, Docker daemon event history, shell history, or the checked-in
fixture scripts themselves.
