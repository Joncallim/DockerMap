# Release supply-chain baseline

This policy makes release dependency and container-image risk visible without
claiming that a passing scan proves a deployment is secure. It applies to every
pull request and tagged release candidate.

## Automated gates

| Surface | Gate | Policy |
| --- | --- | --- |
| Node production dependencies | `npm audit --omit=dev` | Any reported production dependency vulnerability fails CI. |
| Rust dependencies | RustSec `cargo audit` through `cargo-audit` 0.22.2 installed with `--locked` | Any RustSec advisory fails CI. The exact tool release supports the pinned Rust 1.88 toolchain and avoids resolving newer audit-tool dependencies during CI. An exception may be added only for a specific advisory ID, with a linked tracking issue and expiry/review date in this document. There are no current exceptions. |
| Built Docker image | Anchore Grype scan of locally built `dockermap:ci` | High and critical findings with a fix available fail CI. Lower-severity and currently unfixable findings are retained in the scan artifact for review; they are not silently treated as accepted. |
| Image inventory | Anchore Syft SPDX JSON SBOM | Generated from the locally built CI image and retained for 30 days with the workflow SHA. |
| Tagged release candidate | Checksums, package/image SPDX JSON SBOMs, and the same Node/Rust/image gates | Generated from the exact tagged source and retained for 30 days with the tag and commit SHA. |

The image scan does not upload DockerMap images to any registry. Dependency
audits and scanner advisory databases naturally contact their public update
sources during CI; the product runtime does not gain any new network behavior.

## Finding triage and exceptions

A failed gate is remediated by updating the affected dependency or pinned base
image and rerunning the appropriate build and scan. Do not suppress a finding
by lowering the severity threshold, replacing the scanner output, or broadening
an ignore rule.

For a risk that cannot immediately be remediated, create a public tracking
issue containing the advisory/CVE, affected release candidate, why it is not
exploitable or not yet fixable, compensating controls, owner, and a review
date. A maintainer must decide whether the private-alpha release is deferred.
There are no RustSec exceptions today: this repository intentionally has no
`.cargo/audit.toml`. The only permitted exception mechanism is a reviewed,
checked-in `.cargo/audit.toml` with an exact advisory ID under
`[advisories].ignore`, for example:

```toml
[advisories]
ignore = ["RUSTSEC-YYYY-NNNN"]
```

Never add a workflow command-line ignore. Adding that file must be in the same
change as the tracking issue, expiry/review date, and the record in this
document; removing the exception must remove the ID and update the record.

## Base-image pinning

Every external `FROM` reference in the root Dockerfile is pinned to an upstream
manifest-list SHA-256 digest. The human-readable tag remains beside the digest
to make the intended upstream release clear. This fixes base-image selection;
it is not a claim that the whole container build is byte-for-byte reproducible.
The Dockerfile frontend selector and Debian `apt` repositories remain mutable
inputs, so this baseline deliberately does not claim a fully reproducible image
build. A digest is intentionally not a floating tag: it is updated only in a
reviewed maintenance change that records the new upstream digest and passes the
Docker image build, vulnerability scan, and relevant release checks.
Manifest-list digests retain the upstream image's supported architecture
variants.

## Release publication control

A `v*` tag reruns the production Node audit, RustSec advisory audit, local
release-candidate image build/vulnerability scan, release build, version/tag
check, normalized archive packaging, checksum, and both release-artifact and
image SBOM generation. It uploads those outputs only as a 30-day GitHub Actions
artifact. The workflow has read-only repository contents permission and cannot
create a GitHub Release or publish a container image.

After the exact-tag clean-host, proxy, restart/reboot, and required #15/#16
evidence is reviewed, a maintainer may create the private prerelease manually
and attach the checksummed archive and SPDX SBOM. Record the source SHA, scan
result summary, any deferred finding, and known limitations in the release
notes. This prevents a tag by itself from being represented as certified alpha
evidence.
