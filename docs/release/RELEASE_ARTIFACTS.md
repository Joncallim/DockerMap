# Release audit artifacts

Tagged release candidates rerun the dependency/image security gates and build
the same deploy artifacts used by DockerMap's deployment build. They retain a
Linux `x86_64` audit/review archive, SHA-256 file, package SPDX JSON SBOM,
image SPDX JSON SBOM, and image scan report for maintainer review.

The archive contains the daemon and Docker Read Gateway binaries, compiled web
assets, Docker/systemd deployment templates, and the release checklist. It is
an audit/review bundle, not a standalone installer: it intentionally omits the
Node API runtime and dependency tree needed by a complete deployment. The
embedded `ARTIFACT-METADATA` records `installable=false`, the exact product
version, release tag, platform, and source Git SHA. `MANIFEST.sha256` covers
every other file inside the archive. Operators must use the documented source
or container deployment paths in the
[deployment documentation](../deployment/DEPLOYMENT.md) and preserve the
Docker authority separation.

The workflow does not publish to a container registry, create a GitHub Release,
use a private package, or add a credential requirement to ordinary builds. A
maintainer may attach the reviewed candidate archive, checksum, and SBOM to a
private prerelease only after the release checklist is complete. The outer
checksum verifies the downloaded archive. The inner manifest then verifies its
extracted contents:

```bash
sha256sum --check dockermap-vX.Y.Z-linux-x86_64.sha256
tar -xzf dockermap-vX.Y.Z-linux-x86_64.tar.gz
cd dockermap-vX.Y.Z-linux-x86_64
sha256sum --check MANIFEST.sha256
```

Before treating the bundle as evidence, compare `source_sha` in
`ARTIFACT-METADATA` with the reviewed release-candidate commit. Packaging fails
when modified or untracked source files differ from that commit.

See [the supply-chain baseline](SUPPLY_CHAIN.md) and
[security finding triage](SECURITY_FINDING_TRIAGE.md) for advisory handling,
base-image digest updates, SBOM retention, full image-report triage, and the
non-automatic publication rule. Only create a tag after the release checklist's
remaining gates have been fulfilled against that exact commit.
