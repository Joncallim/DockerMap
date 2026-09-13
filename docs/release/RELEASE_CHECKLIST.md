# Private-alpha release checklist

This checklist decides whether one exact DockerMap commit is ready for
maintainer-authorized `v0.1.0-alpha.2` tagging. It does not authorize the tag,
create a release, or publish an image. Release readiness means the Docker-only
profile can inspect its bounded host surface without changing inspected Docker
state and can be installed, recovered, rolled back, removed, and reinstalled as
documented.

## 1. Freeze the candidate

- [ ] Record the exact 40-character `main` SHA.
- [ ] Confirm the worktree and generated contracts are clean at that SHA.
- [ ] Confirm `VERSION` and the proposed tag agree.
- [ ] Record known limitations without presenting deferred work as shipped.
- [ ] Confirm the advertised surface is Docker-only; native/full-host and the
  single-container compatibility profile remain unsupported.

Any fix after this point creates a new candidate SHA and restarts this
checklist.

## 2. Canonical repository and supply-chain gates

Run against the exact candidate and retain complete command results:

- [ ] `npm run check`
- [ ] `npm run test:e2e`
- [ ] `npm run test:e2e:a11y`
- [ ] `npm run test:live-docker`
- [ ] `npm run build:deploy`
- [ ] production-image E2E
- [ ] `npm audit --omit=dev`
- [ ] RustSec audit with the repository-pinned audit command
- [ ] Docker image build and Syft SPDX JSON SBOM
- [ ] complete Grype report plus the remediable high/critical gating report
- [ ] GitGuardian/security checks

The tag workflow reruns these release gates, creates checksums and package/image
SBOMs, and **retains candidate artifacts for maintainer review** for 30 days. It
**does not publish prerelease assets automatically** and cannot create a GitHub
Release.

## 3. Disposable-guest install and boundary checks

Use HEARTH only as the hypervisor. Never certify or reboot HEARTH itself. In a
new disposable supported guest, execute
[the Docker-only deployment procedure](../deployment/DOCKER.md) without
undocumented corrections.

- [ ] Record guest OS, kernel, architecture, Docker, Compose, Git, and Chromium
  versions.
- [ ] Check out the exact candidate SHA detached from any moving branch.
- [ ] Create separate API and daemon tokens in the protected external env file.
- [ ] Build and start the fixed `dockermap-alpha2` Compose project.
- [ ] Confirm all three DockerMap components report healthy, not merely
  running.
- [ ] Confirm anonymous `/api/health`, `/api/snapshot`, `/api/history`, and
  `/api/findings` access is denied.
- [ ] Confirm authenticated health, snapshot, runtime map, Compose scan,
  history, findings, and SSE checks pass.
- [ ] Confirm history is the closed, bounded daemon-lifetime snapshot contract;
  do not describe it as persistent Docker events or causality.
- [ ] Confirm the collector has no host-published port and only the gateway has
  the raw Docker socket.
- [ ] Confirm unrelated Docker objects are excluded from labelled live-Docker
  acceptance evidence.

Never retain a credential, session cookie, shell trace, or persistent browser
profile as evidence.

## 4. Recovery, rollback, and clean state

- [ ] Restart all three DockerMap components and repeat smoke/boundary checks.
- [ ] Record the guest `boot_id`, perform an actual guest reboot, prove the
  `boot_id` changed, and repeat the checks.
- [ ] Confirm DockerMap recovered through Docker's boot startup and
  `unless-stopped` policy without manually recreating the project.
- [ ] Preserve the working image identity, install an upgrade candidate, restore
  the preserved image with `--no-build`, and rerun acceptance checks.
- [ ] Remove the named Compose project with volumes and orphans.
- [ ] Prove no DockerMap-labelled containers, networks, or volumes remain and
  the frontend no longer listens.
- [ ] Remove only the verified DockerMap checkout, protected credential file,
  boot marker, and known local images.
- [ ] Reinstall the same exact SHA from a new clone with new credentials and
  rerun the install checks.

A service restart, container recreation, or hypervisor uptime is not guest
reboot evidence.

## 5. Candidate security decision

- [ ] Retain the complete Grype SARIF report under the exact candidate artifact.
- [ ] Confirm the fixed/remediable high/critical gate is green.
- [ ] Copy the candidate record from
  [security finding triage](SECURITY_FINDING_TRIAGE.md).
- [ ] For every unfixed high/critical finding, record exposure, compensating
  controls, owner, review date, and an explicit named-maintainer `ACCEPT` or
  `DEFER` decision.
- [ ] Treat any missing owner, assessment, report, or decision as `DEFER`.

`DEFER` blocks publication. Scanner silence or a green remediable-finding gate
is not an implicit acceptance of the complete report.

## 6. Final maintainer gate

- [ ] Update [the alpha baseline](ALPHA_BASELINE.md) with exact-candidate facts
  and no secrets.
- [ ] Prepare release notes with exact SHA, supported profile, checksums, SBOM,
  scan decision, limitations, and skipped tests.
- [ ] Obtain explicit maintainer authorization to create the tag or prerelease.

Do not tag or publish without that authorization.

## Historical evidence

Earlier private-review work proved useful boundaries on Hearth, including the
filtered Docker gateway, bearer-session anonymous denial, private collector,
SSE behavior, component restart recovery, and isolated live-Docker fixtures.
Those alpha.1-era records remain in [the alpha baseline](ALPHA_BASELINE.md).
They informed this checklist but do not satisfy alpha.2's exact-SHA clean-host,
real guest reboot, rollback, removal, reinstall, or current scan decisions.
