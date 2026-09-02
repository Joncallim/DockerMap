# Release artifacts

Tagged release candidates rerun the dependency/image security gates and build
the same deploy artifacts used by DockerMap's deployment build. They retain a
Linux `x86_64` archive, SHA-256 file, package SPDX JSON SBOM, image SPDX JSON
SBOM, and image scan report for maintainer review.

The archive contains the daemon and Docker Read Gateway binaries, compiled web
assets, Docker/systemd deployment templates, and the release checklist. It is
an inspection and installation aid, not a claim that a raw binary bundle alone
is an authenticated production deployment. Operators should follow the
[deployment documentation](../deployment/DEPLOYMENT.md) and preserve the
Docker authority separation.

The workflow does not publish to a container registry, create a GitHub Release,
use a private package, or add a credential requirement to ordinary builds. A
maintainer may attach the reviewed candidate archive, checksum, and SBOM to a
private prerelease only after the release checklist is complete. The checksum
permits an operator to verify the downloaded archive:

```bash
sha256sum --check dockermap-vX.Y.Z-linux-x86_64.sha256
```

See [the supply-chain baseline](SUPPLY_CHAIN.md) and
[security finding triage](SECURITY_FINDING_TRIAGE.md) for advisory handling,
base-image digest updates, SBOM retention, full image-report triage, and the
non-automatic publication rule. Only create a tag after the release checklist's
remaining gates have been fulfilled against that exact commit.
