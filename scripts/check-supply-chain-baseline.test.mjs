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
});

test("CI enforces documented Rust and container supply-chain gates", async () => {
  const workflow = await read(".github/workflows/ci.yml");

  assertImmutableActionsAndReadOnlyPermissions(workflow, "CI");
  assert.match(workflow, /cargo install cargo-audit --version 0\.22\.2 --locked/);
  assert.match(workflow, /cargo audit --file crates\/Cargo\.lock/);
  assert.doesNotMatch(workflow, /rustsec\/audit-check/);
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

  assertImmutableActionsAndReadOnlyPermissions(workflow, "release");
  assert.match(workflow,
    /anchore\/sbom-action@3ad7283483fc7af8ff2b4ea19663c2d5ca935e26/);
  assert.match(workflow, /cargo install cargo-audit --version 0\.22\.2 --locked/);
  assert.match(workflow, /cargo audit --file crates\/Cargo\.lock/);
  assert.doesNotMatch(workflow, /rustsec\/audit-check/);
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
  assert.match(checklist, /RustSec advisory audit/);
  assert.match(checklist, /does not publish a prerelease\s+automatically/);
  assert.match(policy, /not a claim that the whole container build is byte-for-byte reproducible/);
  assert.match(policy, /Dockerfile frontend selector and Debian `apt` repositories remain mutable\s+inputs/);
});
