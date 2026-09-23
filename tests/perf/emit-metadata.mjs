#!/usr/bin/env node
/**
 * Emit the pinned benchmark environment metadata for a controlled capture
 * (#335). Every field is read from the runner itself, so a capture cannot be
 * recorded against a guessed environment.
 *
 *   node tests/perf/emit-metadata.mjs --output /controlled/time-to-answer-metadata.json
 *
 * `sourceRevision` is the candidate source revision (git HEAD by default);
 * `fixtureRevision` and `ssePollIntervalMs` are the harness constants.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURE_REVISION } from "./dockerFixtureTopology.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const args = Object.fromEntries(
  process.argv.slice(2).flatMap((value, index, all) => (value.startsWith("--") ? [[value.slice(2), all[index + 1] ?? ""]] : []))
);
const outputPath = args.output;
if (!outputPath || outputPath.startsWith("--")) {
  throw new Error("Usage: node tests/perf/emit-metadata.mjs --output <metadata.json>");
}

/** Reduce a version string to a safe token (the contract's value allowlist). */
function safeToken(value) {
  const token = String(value).trim().replace(/[^A-Za-z0-9._@:+=-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!token) throw new Error("environment field reduced to an empty token");
  return token.slice(0, 160);
}

function command(file, commandArgs) {
  return execFileSync(file, commandArgs, { encoding: "utf8", cwd: REPO_ROOT }).trim();
}

const nodeRevision = safeToken(process.version.replace(/^v/, ""));
const rustRevision = safeToken(command("rustc", ["--version"]).split(" ")[1] ?? "unknown");
let dockerRevision = "unavailable";
try {
  dockerRevision = safeToken(command("docker", ["version", "--format", "{{.Server.Version}}"]));
} catch {
  dockerRevision = "unavailable";
}
const osKernel = safeToken(command("uname", ["-r"]));
const architecture = safeToken(command("uname", ["-m"]));
const cpuClass = safeToken(`cpus-${command("nproc", [])}vcpu`);
const runnerClass = safeToken(args["runner-class"] ?? `linux-${architecture}-dedicated`);
let osImage = safeToken(args["os-image"] ?? "unknown");
if (!args["os-image"]) {
  try {
    const lines = readFileSync("/etc/os-release", "utf8").split("\n");
    const name = lines.find((line) => line.startsWith("ID="))?.split("=")[1]?.replace(/"/g, "") ?? "linux";
    const version = lines.find((line) => line.startsWith("VERSION_ID="))?.split("=")[1]?.replace(/"/g, "") ?? "";
    osImage = safeToken(`${name}-${version}`);
  } catch {
    osImage = "linux-unknown";
  }
}
const fontEnvironment = safeToken(args["font-environment"] ?? "system-default");

const require = createRequire(import.meta.url);
const playwrightPackage = JSON.parse(
  readFileSync(require.resolve("playwright-core/package.json"), "utf8")
);
const browserRevision = safeToken(playwrightPackage.version);
const browserFlags = ["--disable-background-networking", "--disable-sync", "--no-first-run", "--no-default-browser-check"];

let sourceRevision = args["source-revision"];
if (!sourceRevision) {
  try {
    sourceRevision = command("git", ["rev-parse", "HEAD"]);
  } catch {
    sourceRevision = "uncommitted";
  }
}
if (!existsSync(resolve(REPO_ROOT, "crates/target/release/dockermap-daemon"))) {
  throw new Error(
    "the release daemon is missing: run `npm run build:deploy` (or cargo build --release) before capturing"
  );
}

const metadata = {
  environment: {
    runnerClass,
    cpuClass,
    osImage,
    osKernel,
    nodeRevision,
    rustRevision,
    dockerRevision,
    // The API's own default; the capture never overrides it, because stage 5
    // measures today's real publication-observation mechanism.
    ssePollIntervalMs: "2000",
    browserEngine: "chromium",
    browserRevision,
    browserFlags,
    fontEnvironment,
    buildMode: "production",
    fixtureRevision: FIXTURE_REVISION,
    sourceRevision: safeToken(sourceRevision)
  },
  daemonBinary: resolve(REPO_ROOT, "crates/target/release/dockermap-daemon")
};

writeFileSync(outputPath, `${JSON.stringify(metadata, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(metadata.environment, null, 2)}\n`);
process.stdout.write(`[metadata] wrote ${outputPath}\n`);
