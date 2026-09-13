import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, root), "utf8");
}

function assertImmutableActionsAndReadOnlyPermissions(workflow, name) {
  const actions = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)]
    .map((match) => match[1]);

  assert.ok(actions.length > 0, `${name} must use at least one action`);
  for (const action of actions) {
    assert.match(action, /^[^@\s]+@[a-f0-9]{40}$/,
      `${name} action must be pinned to an immutable 40-hex commit: ${action}`);
  }
  assert.match(workflow, /^permissions:\s*\n\s*contents:\s*read\s*$/m,
    `${name} must declare read-only repository contents`);
  assert.doesNotMatch(workflow, /^\s*[A-Za-z][A-Za-z-]*:\s*write\s*(?:#.*)?$/m,
    `${name} must not request a writable GitHub token permission`);
}

test("Dockerfile pins every external base image to a manifest digest", async () => {
  const dockerfile = await read("Dockerfile");
  const images = [...dockerfile.matchAll(/^FROM\s+([^\s]+)(?:\s+AS\s+\S+)?$/gim)]
    .map((match) => match[1]);

  assert.ok(images.length > 0, "Dockerfile must declare at least one base image");
  for (const image of images) {
    assert.match(image, /@sha256:[a-f0-9]{64}$/,
      `base image must be pinned to a SHA-256 manifest digest: ${image}`);
  }
  assert.match(dockerfile, /npm prune --omit=dev --workspaces --include-workspace-root/,
    "runtime dependencies must exclude workspace build tooling");
  assert.match(dockerfile, /apt-get upgrade -y --no-install-recommends/,
    "runtime base packages must receive current distribution security upgrades");
  assert.match(dockerfile, /rm -rf \/usr\/local\/lib\/node_modules\/npm \/usr\/local\/bin\/npm \/usr\/local\/bin\/npx/,
    "unused global npm must not remain in the production image");
});

test("CI enforces documented Rust and container supply-chain gates", async () => {
  const workflow = await read(".github/workflows/ci.yml");

  assertImmutableActionsAndReadOnlyPermissions(workflow, "CI");
  assert.match(workflow, /cargo install cargo-audit --version 0\.22\.2 --locked/);
  assert.match(workflow, /cargo audit --file crates\/Cargo\.lock/);
  assert.doesNotMatch(workflow, /rustsec\/audit-check/);
  assert.doesNotMatch(workflow, /cargo audit[^\n]*--ignore/);
  assert.match(workflow,
    /anchore\/sbom-action@3ad7283483fc7af8ff2b4ea19663c2d5ca935e26/);
  assert.match(workflow,
    /anchore\/scan-action@27805bf3b4e84b4a5c980df22ed233c00390a439/);
  assert.match(workflow,
    /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
  assert.match(workflow, /severity-cutoff:\s*high/);
  assert.match(workflow, /only-fixed:\s*true/);
  assert.match(workflow, /fail-build:\s*false/);
  assert.match(workflow, /only-fixed:\s*false/);
  assert.match(workflow, /dockermap-ci\.grype\.all\.sarif/);
  assert.match(workflow, /dockermap-ci\.grype\.gating\.sarif/);
  assert.match(workflow,
    /- name: Prepare image supply-chain evidence directory\s+run: mkdir -p artifacts/s);
  assert.match(workflow, /image-supply-chain-\$\{\{ github\.sha \}\}/);
});

test("tag builds retain artifacts for review and cannot publish automatically", async () => {
  const workflow = await read(".github/workflows/release.yml");
  const checklist = await read("docs/release/RELEASE_CHECKLIST.md");
  const policy = await read("docs/release/SUPPLY_CHAIN.md");
  const triage = await read("docs/release/SECURITY_FINDING_TRIAGE.md");

  assertImmutableActionsAndReadOnlyPermissions(workflow, "release");
  assert.match(workflow,
    /anchore\/sbom-action@3ad7283483fc7af8ff2b4ea19663c2d5ca935e26/);
  assert.match(workflow, /cargo install cargo-audit --version 0\.22\.2 --locked/);
  assert.match(workflow, /cargo audit --file crates\/Cargo\.lock/);
  assert.doesNotMatch(workflow, /rustsec\/audit-check/);
  assert.doesNotMatch(workflow, /cargo audit[^\n]*--ignore/);
  assert.match(workflow,
    /anchore\/scan-action@27805bf3b4e84b4a5c980df22ed233c00390a439/);
  assert.match(workflow, /npm audit --omit=dev/);
  assert.match(workflow, /image:\s*dockermap:release-candidate/);
  assert.match(workflow, /image\.grype\.all\.sarif/);
  assert.match(workflow, /image\.grype\.gating\.sarif/);
  assert.match(workflow,
    /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
  assert.match(workflow, /release-candidate-\$\{\{ github\.ref_name \}\}-\$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(workflow, /gh\s+release\s+create/);
  assert.match(checklist, /retains candidate\s+artifacts for maintainer review/);
  assert.match(checklist, /does not publish prerelease assets\s+automatically/);
  assert.doesNotMatch(checklist, /publishes the\s+prerelease assets/);
  assert.match(policy, /not a claim that the whole container build is byte-for-byte reproducible/);
  assert.match(policy, /Dockerfile frontend selector and Debian `apt` repositories remain mutable\s+inputs/);
  assert.match(policy, /The only permitted exception mechanism is a reviewed,\s+checked-in `.cargo\/audit\.toml`/);
  assert.match(policy, /\[advisories\]\.ignore/);
  await assert.rejects(read(".cargo/audit.toml"), { code: "ENOENT" },
    "no RustSec advisory-ignore configuration is checked in today");

  assert.match(policy, /complete Grype SARIF report/);
  assert.match(policy, /explicitly record either \*\*DEFER\*\* or \*\*ACCEPT\*\*/);
  assert.match(triage,
    /release-candidate-<tag>-<candidate commit SHA>\/dist\/release\/dockermap-<tag>-image\.grype\.all\.sarif/);
  assert.match(triage, /Candidate image identity:/);
  assert.match(triage, /Exposure and compensating controls:/);
  assert.match(triage, /Owner:/);
  assert.match(triage, /Review date:/);
  assert.match(triage, /Maintainer decision: DEFER \| ACCEPT/);
  assert.match(triage, /UNTRIAGED \/\s*DEFERRED/);
  assert.match(triage, /zero remediable high\/critical findings/);
  assert.match(triage, /#63 remains open/);

  const pendingCandidate = triage.split("## Alpha.2 candidate — pending exact scan")[1]
    ?.split("## Historical local baseline")[0];
  assert.ok(pendingCandidate, "alpha.2 must have an explicit pending candidate boundary");
  assert.match(pendingCandidate, /No alpha\.2 source SHA, image identity, complete report, or maintainer decision/);
  assert.match(pendingCandidate, /UNTRIAGED \/\s*DEFERRED/);
  assert.match(pendingCandidate, /blocks publication/);
  assert.doesNotMatch(pendingCandidate, /Maintainer decision: ACCEPT/,
    "a pending alpha.2 candidate must not be represented as accepted");

  const historicalBaseline = triage.split("## Historical local baseline — untriaged and deferred")[1];
  assert.ok(historicalBaseline, "the previous scan must remain clearly separated as historical evidence");
  assert.match(historicalBaseline, /Candidate source commit: 5a93bbea2106f79ba7d0add891c87f43abac6a5a/);
  assert.match(historicalBaseline, /Maintainer decision: DEFER/);
  assert.match(historicalBaseline, /not a maintainer acceptance/);
  assert.match(historicalBaseline, /must not be reused as alpha\.2 evidence/);
  assert.doesNotMatch(historicalBaseline, /Maintainer decision: ACCEPT/,
    "historical deferred evidence must not be represented as accepted");
});
