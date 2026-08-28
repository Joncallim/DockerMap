# Release artifacts

Tagged releases build the same deploy artifacts used by DockerMap's deployment
build and publish a deterministic Linux `x86_64` archive plus SHA-256 file.

The archive contains the daemon and Docker Read Gateway binaries, compiled web
assets, Docker/systemd deployment templates, and the release checklist. It is
an inspection and installation aid, not a claim that a raw binary bundle alone
is an authenticated production deployment. Operators should follow the
[deployment documentation](../deployment/DEPLOYMENT.md) and preserve the
Docker authority separation.

The workflow does not publish to a container registry, use a private package,
or add a credential requirement to ordinary builds. The GitHub release asset
checksum permits an operator to verify the downloaded archive:

```bash
sha256sum --check dockermap-vX.Y.Z-linux-x86_64.sha256
```

Only create a tag after the release checklist's remaining gates have been
fulfilled against that exact commit.
