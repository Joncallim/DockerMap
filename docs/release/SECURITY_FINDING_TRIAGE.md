# Security finding triage

The image gate fails when a high or critical finding has an available fix. That
is a **remediable** gate, not a declaration that the image has zero high or
critical findings. The complete Grype SARIF report can also contain unfixed or
wont-fix findings. Those findings are release decisions, not scanner noise.

For every tagged candidate, retain the complete report in the GitHub Actions
artifact `image-supply-chain-<candidate commit SHA>` and reference the exact
`*.grype.all.sarif` file below. Before publishing, a maintainer must complete
every field in a candidate record and explicitly decide **DEFER** or **ACCEPT**.
`ACCEPT` requires a named maintainer, a review date, and a stated rationale;
there is no workflow ignore, severity downgrade, or scanner suppression path.

## Candidate record template

Copy this section for each candidate; do not replace the complete scan artifact
with this summary.

```text
Candidate source commit: <40-hex SHA>
Candidate image identity: <registry/name@sha256:... or local name@sha256:...>
Complete report artifact: image-supply-chain-<candidate commit SHA>/<file.grype.all.sarif>
Scanner identity and scan date: <pinned tool/action identity; YYYY-MM-DD>
Owner: <named maintainer>
Review date: <YYYY-MM-DD>
Maintainer decision: DEFER | ACCEPT
Decision rationale: <required for ACCEPT; link any tracking issue>

Finding/group: <CVE/GHSA IDs and affected package(s), or explicitly bounded base-image group>
Exposure and compensating controls: <how DockerMap uses it; controls, or NOT ASSESSED>
```

## Current baseline — untriaged and deferred

This record documents the local remediation candidate only. It is **UNTRIAGED /
DEFERRED**, is not a maintainer acceptance, and does not authorize a release.
PR #208 is an enabling control; issue #63 remains open until a tagged candidate
has an uploaded complete report and a maintainer completes this record.

```text
Candidate source commit: 5a93bbea2106f79ba7d0add891c87f43abac6a5a
Candidate image identity: dockermap:supply-chain-remediated@sha256:0d43bb3a149408c6718d0e9726145ecb649ed7447bdba13b61ed5a27f7c76176
Complete report artifact: PENDING — image-supply-chain-<candidate commit SHA>/<image.grype.all.sarif> must be uploaded by the candidate CI run
Scanner identity and scan date: anchore/grype:latest@sha256:8a93fc48da96bd6ec5981279d099b69de11541dc68fdf222fb9161f8ff284af7; 2026-09-02
Owner: UNASSIGNED — named maintainer required before ACCEPT
Review date: UNSET — required before ACCEPT
Maintainer decision: DEFER
Decision rationale: No maintainer triage yet. Local scan confirms zero remediable high/critical findings, but does not establish zero high/critical findings overall.
```

The following explicitly grouped base-image/runtime findings were present in
that complete local report with no fix version reported. Their exposure and
compensating controls are **NOT ASSESSED**; no control is accepted by this
record. A maintainer must split a group if its exposure differs.

| Finding/group (CVE IDs) | Affected package(s) | Exposure and compensating controls | Owner | Review date | Maintainer decision |
| --- | --- | --- | --- | --- | --- |
| curl/libcurl runtime group: CVE-2026-10536, CVE-2026-11856, CVE-2026-12064, CVE-2026-8286, CVE-2026-8924, CVE-2026-8926, CVE-2026-8927, CVE-2026-8932, CVE-2026-9079, CVE-2026-9080, CVE-2026-9545 | `curl`, `libcurl4t64` | NOT ASSESSED | UNASSIGNED | UNSET | DEFER |
| glibc runtime group: CVE-2026-5435, CVE-2026-5450, CVE-2026-5928 | `libc-bin`, `libc6` | NOT ASSESSED | UNASSIGNED | UNSET | DEFER |
| nginx runtime group: CVE-2026-42533, CVE-2026-56434, CVE-2026-60005 | `nginx`, `nginx-common` | NOT ASSESSED | UNASSIGNED | UNSET | DEFER |
| Perl runtime group: CVE-2026-12087, CVE-2026-13221, CVE-2026-42496, CVE-2026-42497, CVE-2026-48959, CVE-2026-48961, CVE-2026-48962, CVE-2026-57432, CVE-2026-57433, CVE-2026-7017, CVE-2026-8376, CVE-2026-9538 | `perl-base` | NOT ASSESSED | UNASSIGNED | UNSET | DEFER |
| libssh2 runtime group: CVE-2026-58050, CVE-2026-58051, CVE-2026-66032, CVE-2026-66033, CVE-2026-66034, CVE-2026-66035 | `libssh2-1t64` | NOT ASSESSED | UNASSIGNED | UNSET | DEFER |
| ncurses runtime group: CVE-2025-69720 | `libncursesw6`, `libtinfo6`, `ncurses-base`, `ncurses-bin` | NOT ASSESSED | UNASSIGNED | UNSET | DEFER |
| gzip: CVE-2026-41992 | `gzip` | NOT ASSESSED | UNASSIGNED | UNSET | DEFER |
| libacl: CVE-2026-54369, CVE-2026-54370 | `libacl1` | NOT ASSESSED | UNASSIGNED | UNSET | DEFER |
| SQLite: CVE-2026-11822, CVE-2026-11824 | `libsqlite3-0` | NOT ASSESSED | UNASSIGNED | UNSET | DEFER |

When a subsequent base image or package update changes the report, preserve the
previous candidate record with its artifact reference and add a new dated
record. Never edit an accepted candidate's list in place.
