import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";

const script = path.resolve("scripts/collect-atlas-hybrid-bundle-evidence.mjs");
const metadata = { sourceRevision: "abc", buildMode: "production", fixtureRevision: "fixture", rendererPolicyVersion: "policy", runnerClass: "dedicated", browserRevision: "123" };

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: "ignore" });
    child.on("close", (code) => resolve(code));
  });
}

async function fixture(root) {
  const manifest = path.join(root, ".vite", "manifest.json");
  await mkdir(path.dirname(manifest), { recursive: true });
  await mkdir(path.join(root, "assets"));
  await writeFile(path.join(root, "assets", "atlas.js"), "atlas");
  await writeFile(path.join(root, "assets", "shared.js"), "shared");
  await writeFile(manifest, JSON.stringify({ "src/screens/AtlasOverview.tsx": { file: "assets/atlas.js", imports: ["shared"] }, shared: { file: "assets/shared.js" } }));
  const metadataPath = path.join(root, "metadata.json");
  const packagePath = path.join(root, "package.json");
  const lockfile = path.join(root, "package-lock.json");
  await writeFile(metadataPath, JSON.stringify(metadata));
  await writeFile(packagePath, JSON.stringify({ dependencies: { react: "19.1.1" } }));
  await writeFile(lockfile, "safe lockfile v1");
  return { manifest, metadataPath, packagePath, lockfile };
}

function args(input, output, baseline) {
  return ["--manifest", input.manifest, "--entry", "src/screens/AtlasOverview.tsx", "--metadata", input.metadataPath, "--package-manifest", input.packagePath, "--lockfile", input.lockfile, ...(baseline ? ["--baseline", baseline] : []), "--output", output];
}

test("collects route chunks with closed metadata and a manifest/lock runtime dependency proof", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "atlas-bundle-"));
  try {
    const input = await fixture(root);
    const output = path.join(root, "artifact.json");
    assert.equal(await run(args(input, output)), 0);
    const artifact = JSON.parse(await readFile(output, "utf8"));
    assert.equal(artifact.assets.length, 2);
    assert.deepEqual(artifact.runtimeDependencyProof.dependencyAllowlist, ["react@19.1.1"]);
    const candidate = path.join(root, "candidate.json");
    assert.equal(await run(args(input, candidate, output)), 0);
    assert.equal(JSON.parse(await readFile(candidate, "utf8")).comparison.baselineRouteGzipBytes, artifact.atlasRouteGzipBytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects arbitrary metadata and a runtime dependency or lockfile change against the reviewed baseline", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "atlas-bundle-"));
  try {
    const input = await fixture(root);
    const baseline = path.join(root, "baseline.json");
    assert.equal(await run(args(input, baseline)), 0);
    await writeFile(input.metadataPath, JSON.stringify({ ...metadata, rawHostPath: "/private/host" }));
    assert.equal(await run(args(input, path.join(root, "unsafe.json"), baseline)), 1);
    await writeFile(input.metadataPath, JSON.stringify(metadata));
    await writeFile(input.packagePath, JSON.stringify({ dependencies: { react: "19.1.1", "new-runtime": "1.0.0" } }));
    assert.equal(await run(args(input, path.join(root, "dependency-change.json"), baseline)), 1);
    await writeFile(input.packagePath, JSON.stringify({ dependencies: { react: "19.1.1" } }));
    await writeFile(input.lockfile, "safe lockfile v2");
    assert.equal(await run(args(input, path.join(root, "lock-change.json"), baseline)), 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("requires a complete matching baseline artifact and permits only a source revision difference", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "atlas-bundle-"));
  try {
    const input = await fixture(root);
    const baselinePath = path.join(root, "baseline.json");
    assert.equal(await run(args(input, baselinePath)), 0);
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    const candidate = path.join(root, "candidate.json");
    await writeFile(input.metadataPath, JSON.stringify({ ...metadata, sourceRevision: "candidate" }));
    assert.equal(await run(args(input, candidate, baselinePath)), 0);
    const reject = async (name, altered) => {
      const hostile = path.join(root, `${name}.json`);
      await writeFile(hostile, JSON.stringify(altered));
      assert.equal(await run(args(input, candidate, hostile)), 1);
    };
    await reject("minimal", { baseline: baseline.baseline });
    await reject("extra", { ...baseline, forged: true });
    await reject("wrong-route", { ...baseline, atlasRouteEntry: "src/screens/Other.tsx" });
    await reject("wrong-policy", { ...baseline, metadata: { ...baseline.metadata, rendererPolicyVersion: "other-policy" } });
    await reject("wrong-runner", { ...baseline, metadata: { ...baseline.metadata, runnerClass: "other-runner" } });
    await reject("bad-total", { ...baseline, atlasRouteGzipBytes: -1 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refuses an unattributable static Atlas route", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "atlas-bundle-"));
  try {
    const input = await fixture(root);
    await writeFile(input.manifest, JSON.stringify({ "index.html": { file: "assets/app.js" } }));
    assert.equal(await run(args(input, path.join(root, "artifact.json"))), 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects traversal, absolute paths, and symlink escapes in hostile Vite manifests", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "atlas-bundle-"));
  try {
    const input = await fixture(root);
    const output = path.join(root, "artifact.json");
    await writeFile(input.manifest, JSON.stringify({ "src/screens/AtlasOverview.tsx": { file: "../outside.js" } }));
    assert.equal(await run(args(input, output)), 1);
    await writeFile(input.manifest, JSON.stringify({ "src/screens/AtlasOverview.tsx": { file: "/outside.js" } }));
    assert.equal(await run(args(input, output)), 1);
    const outside = path.join(root, "outside.js");
    await writeFile(outside, "outside");
    await symlink(outside, path.join(root, "assets", "linked.js"));
    await writeFile(input.manifest, JSON.stringify({ "src/screens/AtlasOverview.tsx": { file: "assets/linked.js" } }));
    assert.equal(await run(args(input, output)), 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects hostile CLI and manifest entry source keys before emitting an artifact", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "atlas-bundle-"));
  try {
    const input = await fixture(root);
    const output = path.join(root, "artifact.json");
    assert.equal(await run(["--manifest", input.manifest, "--entry", "../AtlasOverview.tsx", "--metadata", input.metadataPath, "--package-manifest", input.packagePath, "--lockfile", input.lockfile, "--output", output]), 1);
    await writeFile(input.manifest, JSON.stringify({ "src/screens/AtlasOverview.tsx": { src: "../AtlasOverview.tsx", file: "assets/atlas.js" } }));
    assert.equal(await run(args(input, output)), 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refuses an existing symlink output and does not follow it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "atlas-bundle-"));
  try {
    const input = await fixture(root);
    const outside = path.join(root, "outside.json");
    const output = path.join(root, "output.json");
    await writeFile(outside, "preserve-me");
    await symlink(outside, output);
    assert.equal(await run(args(input, output)), 1);
    assert.equal(await readFile(outside, "utf8"), "preserve-me");
  } finally { await rm(root, { recursive: true, force: true }); }
});
