# Records

Machine-oriented build, verification, and audit output lives here. These files are
written for traceability, not for a first read — start with the [docs index](../README.md)
instead if you're looking for explanations.

- [`BUILD_SUMMARY.md`](BUILD_SUMMARY.md) — point-in-time snapshot of what a build added,
  the verification commands that were run, and what was deliberately deferred.

## Runtime logs

DockerMap itself does not write log files to this repository. `*.log` is git-ignored.
When self-hosted with the provided systemd units (see
[docs/deployment/DEPLOYMENT.md](../deployment/DEPLOYMENT.md)), process output goes to the
systemd journal:

```bash
journalctl -u dockermap-daemon -f
journalctl -u dockermap-api -f
```

When run with Docker (see [docs/deployment/DOCKER.md](../deployment/DOCKER.md)), use:

```bash
docker compose logs -f
```
