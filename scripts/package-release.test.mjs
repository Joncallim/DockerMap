import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { generatedModule } from "./check-version-authority.mjs";

const execFileAsync = promisify(execFile);
const sourceRoot = path.resolve(import.meta.dirname, "..");
const version = "0.1.0-alpha.2";

async function write(root, relativePath, contents, mode) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, mode ? { mode } : undefined);
}

async function writeJson(root, relativePath, value) {
  await write(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function releaseFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dockermap-release-bundle-"));
  await write(root, "VERSION", `${version}\n`);
  const workspacePaths = ["", "apps/api", "apps/web", "packages/contracts"];
  for (const workspacePath of workspacePaths) {
    await writeJson(root, path.join(workspacePath, "package.json"), {
      name: workspacePath || "dockermap-monorepo",
      version,
      ...(workspacePath === "" ? { workspaces: ["apps/*", "packages/*"] } : {}),
      ...(workspacePath && workspacePath !== "packages/contracts"
        ? { dependencies: { "@dockermap/contracts": version } }
        : {}),
    });
  }
  await writeJson(root, "package-lock.json", {
    version,
    packages: Object.fromEntries(workspacePaths.map((workspacePath) => [workspacePath, {
      version,
      ...(workspacePath && workspacePath !== "packages/contracts"
        ? { dependencies: { "@dockermap/contracts": version } }
        : {}),
    }])),
  });
  for (const name of ["dockermap-core", "dockermap-daemon", "dockermap-docker-gateway"]) {
    await write(root, `crates/${name}/Cargo.toml`, `[package]\nname = "${name}"\nversion = "${version}"\n`);
  }
  await write(root, "apps/api/src/generated/productVersion.ts", generatedModule(version));
  await write(root, "scripts/package-release.sh", await readFile(path.join(sourceRoot, "scripts/package-release.sh")), 0o755);
  await write(root, "scripts/check-version-authority.mjs", await readFile(path.join(sourceRoot, "scripts/check-version-authority.mjs")), 0o755);
  await write(root, "crates/target/release/dockermap-daemon", "daemon\n", 0o755);
  await write(root, "crates/target/release/dockermap-docker-gateway", "gateway\n", 0o755);
  await write(root, "apps/web/dist/index.html", "<!doctype html>\n");
  await write(root, "deploy/docker/entrypoint.sh", "#!/bin/sh\n", 0o755);
  await write(root, "deploy/systemd/dockermap-daemon.service", "[Service]\n");
  await write(root, "docs/release/RELEASE_CHECKLIST.md", "# Checklist\n");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "release-test@example.invalid"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Release Test"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
  return root;
}

test("alpha.2 packaging check accepts the exact tag and rejects the stable tag", async () => {
  await execFileAsync("bash", ["scripts/package-release.sh", "v0.1.0-alpha.2", "--check"], { cwd: sourceRoot });
  await assert.rejects(
    execFileAsync("bash", ["scripts/package-release.sh", "v0.1.0", "--check"], { cwd: sourceRoot }),
    /must exactly match v0\.1\.0-alpha\.2/
  );
});

test("audit bundle records exact source identity and verifies both checksum layers", async () => {
  const root = await releaseFixture();
  const output = path.join(root, "dist/release");
  try {
    const { stdout: sourceSha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
    await execFileAsync("bash", ["scripts/package-release.sh", `v${version}`], { cwd: root });
    const archiveName = `dockermap-v${version}-linux-x86_64.tar.gz`;
    await execFileAsync("sha256sum", ["--check", `dockermap-v${version}-linux-x86_64.sha256`], { cwd: output });
    const { stdout: listing } = await execFileAsync("tar", ["-tzf", archiveName], { cwd: output });
    for (const expected of [
      "ARTIFACT-METADATA",
      "MANIFEST.sha256",
      "bin/dockermap-daemon",
      "bin/dockermap-docker-gateway",
      "web/index.html",
      "deploy/docker/entrypoint.sh",
      "deploy/systemd/dockermap-daemon.service",
      "RELEASE_CHECKLIST.md",
    ]) {
      assert.match(listing, new RegExp(`dockermap-v${version}-linux-x86_64/${expected.replaceAll(".", "\\.")}(?:\\n|$)`));
    }
    await execFileAsync("tar", ["-xzf", archiveName], { cwd: output });
    const stage = path.join(output, `dockermap-v${version}-linux-x86_64`);
    await execFileAsync("sha256sum", ["--check", "MANIFEST.sha256"], { cwd: stage });
    const metadata = await readFile(path.join(stage, "ARTIFACT-METADATA"), "utf8");
    assert.match(metadata, /^artifact_type=dockermap-audit-review-bundle$/m);
    assert.match(metadata, /^installable=false$/m);
    assert.match(metadata, new RegExp(`^product_version=${version.replaceAll(".", "\\.")}$`, "m"));
    assert.match(metadata, new RegExp(`^source_sha=${sourceSha.trim()}$`, "m"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
