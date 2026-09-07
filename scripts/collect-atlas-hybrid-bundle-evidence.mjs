#!/usr/bin/env node
/**
 * Collect closed-schema production-build bundle evidence for the Atlas route.
 * It refuses static route inclusion and unreviewed dependency/metadata claims.
 */
import { gzipSync } from "node:zlib";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, all) => value.startsWith("--") ? [[value.slice(2), all[index + 1]]] : []));
const required = ["manifest", "entry", "metadata", "package-manifest", "lockfile", "output"];
if (required.some((key) => !args[key] || args[key].startsWith("--"))) {
  throw new Error("Usage: node scripts/collect-atlas-hybrid-bundle-evidence.mjs --manifest <vite-manifest.json> --entry <AtlasOverview source path> --metadata <safe-metadata.json> --package-manifest <apps/web/package.json> --lockfile <package-lock.json> --output <artifact.json>");
}
const safeValue = /^[A-Za-z0-9._/@:+=-]{1,160}$/;
const metadataKeys = ["sourceRevision", "buildMode", "fixtureRevision", "rendererPolicyVersion", "runnerClass", "browserRevision"];
const dependencyProofKeys = ["packageManifestSha256", "lockfileSha256", "dependencyAllowlist"];
const assetKeys = ["file", "bytes", "gzipBytes"];
const baselineArtifactKeys = ["baseline", "atlasRouteEntry", "metadata", "runtimeDependencyProof", "assets", "atlasRouteGzipBytes"];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value, keys) => isObject(value) && Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000");

function assertManifestAssetPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 240 || value.includes("\\") || value.includes("\u0000") || path.isAbsolute(value)) {
    throw new Error("Vite manifest asset paths must be short relative POSIX paths.");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..") || path.posix.normalize(value) !== value) {
    throw new Error("Vite manifest asset paths must not contain traversal or dot segments.");
  }
  return value;
}

function assertManifestSourceKey(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 240 || value.includes("\\") || value.includes("\u0000") || path.isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Atlas entry must be a bounded relative POSIX source key.");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..") || path.posix.normalize(value) !== value) {
    throw new Error("Atlas entry must not contain traversal or dot segments.");
  }
  return value;
}

function manifestChunk(value) {
  if (!isObject(value) || typeof value.file !== "string" || (value.css !== undefined && !Array.isArray(value.css)) || (value.imports !== undefined && !Array.isArray(value.imports)) || (value.dynamicImports !== undefined && !Array.isArray(value.dynamicImports))) {
    throw new Error("Vite manifest chunk has an unsafe schema.");
  }
  assertManifestAssetPath(value.file);
  for (const asset of value.css ?? []) assertManifestAssetPath(asset);
  for (const imported of [...(value.imports ?? []), ...(value.dynamicImports ?? [])]) {
    if (typeof imported !== "string" || imported.length === 0 || imported.length > 240 || imported.includes("\u0000")) throw new Error("Vite manifest import key is unsafe.");
  }
  return value;
}

function parseSafeMetadata(value) {
  if (!exactKeys(value, metadataKeys) || value.buildMode !== "production" || metadataKeys.some((key) => typeof value[key] !== "string" || !safeValue.test(value[key]))) {
    throw new Error("Bundle metadata must use exactly the closed safe source/build/fixture/policy/runner/browser fields.");
  }
  return Object.fromEntries(metadataKeys.map((key) => [key, value[key]]));
}

function dependencyProof(packageManifest, lockfile) {
  if (!isObject(packageManifest) || !isObject(packageManifest.dependencies)) throw new Error("Package manifest must contain a runtime dependency map.");
  const dependencyAllowlist = Object.entries(packageManifest.dependencies).map(([name, version]) => {
    if (!safeValue.test(name) || typeof version !== "string" || !safeValue.test(version)) throw new Error("Runtime dependency proof contains an unsafe dependency name or version.");
    return `${name}@${version}`;
  }).sort();
  return {
    packageManifestSha256: hash(JSON.stringify(dependencyAllowlist)),
    lockfileSha256: hash(lockfile),
    dependencyAllowlist
  };
}

function parseDependencyProof(value) {
  if (!exactKeys(value, dependencyProofKeys) || typeof value.packageManifestSha256 !== "string" || typeof value.lockfileSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.packageManifestSha256) || !/^[a-f0-9]{64}$/.test(value.lockfileSha256) || !Array.isArray(value.dependencyAllowlist) || value.dependencyAllowlist.length > 128 || !value.dependencyAllowlist.every((entry) => typeof entry === "string" && safeValue.test(entry)) || new Set(value.dependencyAllowlist).size !== value.dependencyAllowlist.length) {
    throw new Error("Atlas bundle baseline has an unsafe dependency proof.");
  }
  return { packageManifestSha256: value.packageManifestSha256, lockfileSha256: value.lockfileSha256, dependencyAllowlist: value.dependencyAllowlist };
}

function finiteByteCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function parseBaselineArtifact(value) {
  if (!exactKeys(value, baselineArtifactKeys) || value.baseline !== "atlas-v1/hybrid-bundle-baseline-1" || !Array.isArray(value.assets) || value.assets.length === 0 || value.assets.length > 1024 || !finiteByteCount(value.atlasRouteGzipBytes)) {
    throw new Error("Atlas bundle baseline must use the exact closed artifact schema.");
  }
  const atlasRouteEntry = assertManifestSourceKey(value.atlasRouteEntry);
  const metadata = parseSafeMetadata(value.metadata);
  const runtimeDependencyProof = parseDependencyProof(value.runtimeDependencyProof);
  const assets = value.assets.map((asset) => {
    if (!exactKeys(asset, assetKeys) || !finiteByteCount(asset.bytes) || !finiteByteCount(asset.gzipBytes)) throw new Error("Atlas bundle baseline has an unsafe asset record.");
    return { file: assertManifestAssetPath(asset.file), bytes: asset.bytes, gzipBytes: asset.gzipBytes };
  });
  if (new Set(assets.map((asset) => asset.file)).size !== assets.length || assets.reduce((total, asset) => total + asset.gzipBytes, 0) !== value.atlasRouteGzipBytes) {
    throw new Error("Atlas bundle baseline asset totals are inconsistent.");
  }
  return { baseline: value.baseline, atlasRouteEntry, metadata, runtimeDependencyProof, assets, atlasRouteGzipBytes: value.atlasRouteGzipBytes };
}

function equivalentPinnedMetadata(baseline, candidate) {
  return metadataKeys.filter((key) => key !== "sourceRevision").every((key) => baseline[key] === candidate[key]);
}

async function writeArtifactSafely(requestedOutput, artifact) {
  const output = path.resolve(requestedOutput);
  const parent = await realpath(path.dirname(output));
  const target = path.join(parent, path.basename(output));
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new Error("Atlas bundle evidence output must not be an existing symlink.");
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
  }
  const temporary = path.join(parent, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

const manifestPath = path.resolve(args.manifest);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (!isObject(manifest)) throw new Error("Vite manifest must be an object.");
const requestedEntry = assertManifestSourceKey(args.entry);
const entry = Object.entries(manifest).find(([key, value]) => key === requestedEntry || (isObject(value) && value.src === requestedEntry));
if (!entry) throw new Error(`Atlas bundle evidence requires a distinct manifest entry for ${requestedEntry}; static inclusion in the application entry is not attributable certification evidence.`);
const entryChunk = manifestChunk(entry[1]);
const atlasRouteEntry = entryChunk.src === undefined ? assertManifestSourceKey(entry[0]) : assertManifestSourceKey(entryChunk.src);
if (atlasRouteEntry !== requestedEntry) throw new Error("Atlas manifest entry source does not match the requested safe source key.");
const metadata = parseSafeMetadata(JSON.parse(await readFile(path.resolve(args.metadata), "utf8")));
const packageManifestText = await readFile(path.resolve(args["package-manifest"]), "utf8");
const lockfileText = await readFile(path.resolve(args.lockfile), "utf8");

const visited = new Set();
function visit(key) {
  if (visited.has(key)) return;
  const rawChunk = manifest[key];
  if (!rawChunk) throw new Error(`Vite manifest references missing chunk ${key}.`);
  const chunk = manifestChunk(rawChunk);
  visited.add(key);
  for (const imported of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) visit(imported);
}
visit(entry[0]);
const files = [...visited].flatMap((key) => {
  const chunk = manifestChunk(manifest[key]);
  return [chunk.file, ...(chunk.css ?? [])];
}).filter((file, index, all) => all.indexOf(file) === index).sort();
const root = await realpath(path.dirname(path.dirname(manifestPath)));
const assets = [];
for (const file of files) {
  const absolute = path.resolve(root, file);
  const relative = path.relative(root, absolute);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Vite manifest asset escapes the build root.");
  const assetStat = await lstat(absolute);
  if (assetStat.isSymbolicLink() || !assetStat.isFile()) throw new Error("Vite manifest assets must be regular non-symlink files.");
  const resolvedAsset = await realpath(absolute);
  const resolvedRelative = path.relative(root, resolvedAsset);
  if (resolvedRelative === "" || resolvedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(resolvedRelative)) throw new Error("Vite manifest asset resolves outside the build root.");
  const bytes = await readFile(resolvedAsset);
  assets.push({ file: path.posix.normalize(relative.split(path.sep).join("/")), bytes: (await stat(resolvedAsset)).size, gzipBytes: gzipSync(bytes).length });
}
const artifact = {
  baseline: "atlas-v1/hybrid-bundle-baseline-1",
  atlasRouteEntry,
  metadata,
  runtimeDependencyProof: dependencyProof(JSON.parse(packageManifestText), lockfileText),
  assets,
  atlasRouteGzipBytes: assets.reduce((total, asset) => total + asset.gzipBytes, 0)
};
if (args.baseline) {
  const baseline = parseBaselineArtifact(JSON.parse(await readFile(path.resolve(args.baseline), "utf8")));
  if (baseline.atlasRouteEntry !== artifact.atlasRouteEntry || !equivalentPinnedMetadata(baseline.metadata, artifact.metadata) || JSON.stringify(baseline.runtimeDependencyProof) !== JSON.stringify(artifact.runtimeDependencyProof)) {
    throw new Error("Atlas bundle candidate requires the matching reviewed package-manifest/lockfile dependency proof.");
  }
  const limit = Math.max(baseline.atlasRouteGzipBytes * 1.1, baseline.atlasRouteGzipBytes + 2 * 1024);
  if (!Number.isFinite(baseline.atlasRouteGzipBytes) || artifact.atlasRouteGzipBytes > limit) throw new Error(`Atlas route gzip total exceeds its baseline limit of ${limit} bytes.`);
  artifact.comparison = { baselineRouteGzipBytes: baseline.atlasRouteGzipBytes, allowedRouteGzipBytes: limit };
}
await writeArtifactSafely(args.output, artifact);
