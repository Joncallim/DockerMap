import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkVersionAuthority, generatedModule, parseVersionFile } from "./check-version-authority.mjs";

const execFileAsync = promisify(execFile);

const version = "1.2.3-rc.1+build.7";
const workspacePaths = ["", "apps/api", "apps/web", "packages/contracts"];

async function writeJson(root, relativePath, value) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dockermap-version-authority-"));
  await writeFile(path.join(root, "VERSION"), `${version}\n`);
  for (const packagePath of workspacePaths) {
    await writeJson(root, path.join(packagePath, "package.json"), {
      name: packagePath || "root",
      version,
      ...(packagePath === "" ? { workspaces: ["apps/*", "packages/*"] } : {}),
      ...(packagePath && packagePath !== "packages/contracts" ? { dependencies: { "@dockermap/contracts": version } } : {}),
    });
  }
  const packages = Object.fromEntries(workspacePaths.map((packagePath) => [packagePath, {
    version,
    ...(packagePath && packagePath !== "packages/contracts" ? { dependencies: { "@dockermap/contracts": version } } : {}),
  }]));
  await writeJson(root, "package-lock.json", { version, packages });
  for (const name of ["dockermap-core", "dockermap-daemon", "dockermap-docker-gateway"]) {
    const manifest = path.join("crates", name, "Cargo.toml");
    await mkdir(path.join(root, "crates", name), { recursive: true });
    await writeFile(path.join(root, manifest), `[package]\nname = "${name}"\nversion = "${version}"\n`);
  }
  await mkdir(path.join(root, "apps/api/src/generated"), { recursive: true });
  await writeFile(path.join(root, "apps/api/src/generated/productVersion.ts"), generatedModule(version));
  return root;
}

test("accepts strict SemVer root authority and all matching mirrors", async () => {
  const root = await fixture();
  try { assert.equal(await checkVersionAuthority({ root }), version); } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects a stale Cargo product-version mirror", async () => {
  const root = await fixture();
  try {
    await writeFile(path.join(root, "crates/dockermap-daemon/Cargo.toml"), `[package]\nname = "dockermap-daemon"\nversion = "1.2.4"\n`);
    await assert.rejects(checkVersionAuthority({ root }), /dockermap-daemon\/Cargo\.toml version/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects a stale npm workspace dependency mirror", async () => {
  const root = await fixture();
  try {
    await writeJson(root, "apps/web/package.json", { name: "web", version, dependencies: { "@dockermap/contracts": "1.2.4" } });
    await assert.rejects(checkVersionAuthority({ root }), /apps\/web\/package\.json dependency @dockermap\/contracts/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects a missing contracts dependency from a current consumer manifest", async () => {
  const root = await fixture();
  try {
    await writeJson(root, "apps/web/package.json", { name: "web", version });
    await assert.rejects(checkVersionAuthority({ root }), /apps\/web\/package\.json dependencies is missing/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects a missing contracts dependency from a current consumer lockfile entry", async () => {
  const root = await fixture();
  try {
    const lock = await readFile(path.join(root, "package-lock.json"), "utf8");
    const parsed = JSON.parse(lock);
    delete parsed.packages["apps/web"].dependencies["@dockermap/contracts"];
    await writeJson(root, "package-lock.json", parsed);
    await assert.rejects(checkVersionAuthority({ root }), /packages\["apps\/web"\].dependencies.@dockermap\/contracts/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("derives every package beneath declared workspace globs", async () => {
  const root = await fixture();
  try {
    await writeJson(root, "apps/extra/package.json", { name: "extra", version: "1.2.4" });
    await assert.rejects(checkVersionAuthority({ root }), /apps\/extra\/package\.json version/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("checks contracts mirrors for dynamically discovered workspace consumers", async () => {
  const root = await fixture();
  try {
    await writeJson(root, "apps/extra/package.json", { name: "extra", version, dependencies: { "@dockermap/contracts": "1.2.4" } });
    const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
    lock.packages["apps/extra"] = { version, dependencies: { "@dockermap/contracts": "1.2.4" } };
    await writeJson(root, "package-lock.json", lock);
    await assert.rejects(checkVersionAuthority({ root }), /apps\/extra\/package\.json dependency @dockermap\/contracts/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects workspace patterns the authority checker cannot enumerate", async () => {
  const root = await fixture();
  try {
    await writeJson(root, "package.json", { name: "root", version, workspaces: ["apps/**"] });
    await assert.rejects(checkVersionAuthority({ root }), /Unsupported workspace pattern/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects a stale generated API-local product version", async () => {
  const root = await fixture();
  try {
    await writeFile(path.join(root, "apps/api/src/generated/productVersion.ts"), generatedModule("1.2.4"));
    await assert.rejects(checkVersionAuthority({ root }), /productVersion\.ts/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects non-strict VERSION forms", () => {
  for (const value of ["01.2.3\n", "1.2\n", "1.2.3 \n", "1.2.3\nextra\n", "1.2.3-01\n"]) {
    assert.throws(() => parseVersionFile(value), /VERSION/);
  }
});

test("accepts strict SemVer prerelease identifiers containing hyphens", () => {
  assert.equal(parseVersionFile("1.2.3-preview-1+build-7\n"), "1.2.3-preview-1+build-7");
});

test("release packaging validates the tag against VERSION before staging", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const productVersion = (await readFile(path.join(root, "VERSION"), "utf8")).trim();
  await execFileAsync("bash", ["scripts/package-release.sh", `v${productVersion}`, "--check"], { cwd: root });
  await assert.rejects(
    execFileAsync("bash", ["scripts/package-release.sh", "v999.999.999", "--check"], { cwd: root }),
    /must exactly match/
  );
});

test("release packaging accepts the exact v-prefixed strict SemVer tag with build metadata", async () => {
  const root = await fixture();
  try {
    await mkdir(path.join(root, "scripts"), { recursive: true });
    const sourceRoot = path.resolve(import.meta.dirname, "..");
    await writeFile(path.join(root, "scripts/package-release.sh"), await readFile(path.join(sourceRoot, "scripts/package-release.sh"), "utf8"));
    await writeFile(path.join(root, "scripts/check-version-authority.mjs"), await readFile(path.join(sourceRoot, "scripts/check-version-authority.mjs"), "utf8"));
    await execFileAsync("bash", ["scripts/package-release.sh", `v${version}`, "--check"], { cwd: root });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("daemon compilation refuses a Cargo version that differs from root VERSION", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dockermap-daemon-version-build-"));
  try {
    const crate = path.join(root, "crates/dockermap-daemon");
    await mkdir(path.join(crate, "src"), { recursive: true });
    await writeFile(path.join(root, "VERSION"), "1.2.3\n");
    await writeFile(path.join(crate, "Cargo.toml"), "[package]\nname = \"daemon-version-build-fixture\"\nversion = \"1.2.4\"\nedition = \"2021\"\nbuild = \"build.rs\"\n");
    await writeFile(path.join(crate, "src/main.rs"), "fn main() {}\n");
    await writeFile(path.join(crate, "build.rs"), await readFile(path.resolve(import.meta.dirname, "../crates/dockermap-daemon/build.rs"), "utf8"));
    await assert.rejects(
      execFileAsync("cargo", ["check", "--manifest-path", path.join(crate, "Cargo.toml")], { env: { ...process.env, CARGO_TARGET_DIR: path.join(root, "target") } }),
      /must match root VERSION/
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});
