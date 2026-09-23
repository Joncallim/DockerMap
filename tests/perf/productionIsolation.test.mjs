/**
 * Production isolation proof for the time-to-answer benchmark (#335).
 *
 * The benchmark may never leak into the shipped product. These checks fail
 * closed: they assert the ordinary production artifact does not contain the
 * benchmark entry or its probe identifiers, that the benchmark build config is
 * not reachable from any production build path, and that the daemon's stage
 * attribution hook is inert unless the benchmark explicitly enables it.
 *
 * They require a production build of the web app to exist, because the
 * strongest evidence is the shipped bundle itself.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Identifiers that must never appear in a shipped artifact. */
const PROBE_IDENTIFIERS = [
  "__dockermapProbe",
  "__dockermapBench",
  "__dockermapBenchHelpers",
  "measureModelAcceptance",
  "browserProbe",
  "benchVite",
  "perf:time-to-answer"
];

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    const info = statSync(full);
    if (info.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

function productionSources() {
  const roots = ["apps/web/src", "apps/api/src", "packages/contracts/src"];
  return roots.flatMap((root) => {
    const full = join(REPO_ROOT, root);
    return existsSync(full) ? walk(full) : [];
  });
}

describe("time-to-answer production isolation", () => {
  it("ships no benchmark identifier in the production web bundle", () => {
    const dist = join(REPO_ROOT, "apps/web/dist");
    assert.ok(
      existsSync(dist),
      "apps/web/dist is missing: build the web app first (npm run build) so the shipped artifact can be inspected"
    );
    const artifacts = walk(dist).filter((file) => /\.(js|mjs|css|html|json|map)$/.test(file));
    assert.ok(artifacts.length > 0, "the production build produced no inspectable artifacts");
    const offenders = [];
    for (const file of artifacts) {
      const body = readFileSync(file, "utf8");
      for (const identifier of PROBE_IDENTIFIERS) {
        if (body.includes(identifier)) offenders.push(`${file.slice(REPO_ROOT.length + 1)} → ${identifier}`);
      }
    }
    assert.deepEqual(offenders, [], `the production bundle references benchmark identifiers: ${offenders.join(", ")}`);
  });

  it("keeps benchmark identifiers out of every production source file", () => {
    const offenders = [];
    for (const file of productionSources()) {
      const body = readFileSync(file, "utf8");
      for (const identifier of PROBE_IDENTIFIERS) {
        if (body.includes(identifier)) offenders.push(`${file.slice(REPO_ROOT.length + 1)} → ${identifier}`);
      }
    }
    assert.deepEqual(offenders, [], `production sources reference benchmark identifiers: ${offenders.join(", ")}`);
  });

  it("does not reach the benchmark build config from any production build script", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    const productionScripts = Object.entries(pkg.scripts).filter(
      ([name]) => !name.startsWith("perf:") && name !== "test:perf"
    );
    const offenders = productionScripts.filter(([, command]) => command.includes("benchVite") || command.includes("tests/perf/capture"));
    assert.deepEqual(offenders, [], `a production script invokes the benchmark: ${JSON.stringify(offenders)}`);

    const webConfig = readFileSync(join(REPO_ROOT, "apps/web/vite.config.ts"), "utf8");
    assert.ok(!webConfig.includes("bench"), "the production web Vite config references the benchmark");

    const webPackage = JSON.parse(readFileSync(join(REPO_ROOT, "apps/web/package.json"), "utf8"));
    for (const [name, command] of Object.entries(webPackage.scripts)) {
      assert.ok(
        !String(command).includes("bench") && !String(command).includes("tests/perf"),
        `the production web script "${name}" reaches into the benchmark`
      );
    }
  });

  it("keeps the daemon stage attribution hook inert by default", () => {
    const hookPath = join(REPO_ROOT, "crates/dockermap-daemon/src/bench_timing.rs");
    assert.ok(existsSync(hookPath), "the bench attribution hook is missing");
    const hook = readFileSync(hookPath, "utf8");
    assert.ok(
      hook.includes("DOCKERMAP_BENCH_STAGE_TIMING_PATH"),
      "the hook must be enabled by an explicit environment variable"
    );
    assert.ok(
      hook.includes("is_absolute()"),
      "the hook must refuse a relative sink path, so it cannot silently write into a working directory"
    );

    // The hook must not be reachable from any route or API surface.
    const offenders = [];
    for (const file of productionSources()) {
      const body = readFileSync(file, "utf8");
      if (body.includes("DOCKERMAP_BENCH_STAGE_TIMING_PATH")) offenders.push(file.slice(REPO_ROOT.length + 1));
    }
    assert.deepEqual(offenders, [], `an API or web source reads the bench hook: ${offenders.join(", ")}`);

    // And it must only be consulted by the daemon's own collection paths.
    const daemonSources = walk(join(REPO_ROOT, "crates/dockermap-daemon/src")).filter((file) => file.endsWith(".rs"));
    const consumers = daemonSources
      .filter((file) => readFileSync(file, "utf8").includes("bench_timing"))
      .map((file) => file.slice(REPO_ROOT.length + 1))
      .sort();
    assert.deepEqual(consumers, [
      "crates/dockermap-daemon/src/cache_refresh.rs",
      "crates/dockermap-daemon/src/main.rs"
    ]);
  });

  it("adds no browser analytics or tracking to the production bundle", () => {
    const dist = join(REPO_ROOT, "apps/web/dist");
    assert.ok(existsSync(dist), "apps/web/dist is missing: build the web app first");
    const analytics = [
      "google-analytics",
      "googletagmanager",
      "gtag(",
      "sendBeacon",
      "navigator.sendBeacon",
      "mixpanel",
      "posthog",
      "sentry.init",
      "datadogRum"
    ];
    const offenders = [];
    for (const file of walk(dist).filter((entry) => /\.(js|mjs|html)$/.test(entry))) {
      const body = readFileSync(file, "utf8");
      for (const marker of analytics) {
        if (body.includes(marker)) offenders.push(`${file.slice(REPO_ROOT.length + 1)} → ${marker}`);
      }
    }
    assert.deepEqual(offenders, [], `the production bundle carries analytics markers: ${offenders.join(", ")}`);
  });
});
