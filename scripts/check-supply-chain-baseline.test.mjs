import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, root), "utf8");
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

  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(workflow,
    /rustsec\/audit-check@69366f33c96575abad1ee0dba8212993eecbe998/);
  assert.match(workflow, /working-directory:\s*crates/);
  assert.match(workflow,
    /anchore\/sbom-action@3ad7283483fc7af8ff2b4ea19663c2d5ca935e26/);
  assert.match(workflow,
    /anchore\/scan-action@27805bf3b4e84b4a5c980df22ed233c00390a439/);
  assert.match(workflow,
    /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
  assert.match(workflow, /severity-cutoff:\s*high/);
  assert.match(workflow, /only-fixed:\s*true/);
  assert.match(workflow, /image-supply-chain-\$\{\{ github\.sha \}\}/);
});

test("tag builds retain artifacts for review and cannot publish automatically", async () => {
  const workflow = await read(".github/workflows/release.yml");
  const checklist = await read("docs/release/RELEASE_CHECKLIST.md");

  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow,
    /anchore\/sbom-action@3ad7283483fc7af8ff2b4ea19663c2d5ca935e26/);
  assert.match(workflow,
    /rustsec\/audit-check@69366f33c96575abad1ee0dba8212993eecbe998/);
  assert.match(workflow,
    /anchore\/scan-action@27805bf3b4e84b4a5c980df22ed233c00390a439/);
  assert.match(workflow, /npm audit --omit=dev/);
  assert.match(workflow, /image:\s*dockermap:release-candidate/);
  assert.match(workflow,
    /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
  assert.match(workflow, /release-candidate-\$\{\{ github\.ref_name \}\}-\$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(workflow, /gh\s+release\s+create/);
  assert.match(checklist, /RustSec advisory audit/);
  assert.match(checklist, /does not publish a prerelease\s+automatically/);
});
