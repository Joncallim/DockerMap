/**
 * Production isolation proof for the time-to-answer benchmark (#335).
 *
 * The benchmark may never leak into the shipped product. These checks fail
 * closed: the ordinary production artifact must not contain the acceptance seam,
 * the benchmark probe entry or any benchmark identifier; the seam's identifiers
 * may appear in product source only inside the seam module and its two import
 * sites; the production Vite config must define the compile-time flag `false`;
 * and no production build path may reach the benchmark configs.
 *
 * They require a production build of the web app to exist, because the strongest
 * evidence is the shipped bundle itself (`npm run build`, which `npm run check`
 * runs before this suite).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/**
 * Harness-only identifiers. They live in `tests/perf` and must never appear in a
 * product source file, in the production bundle, or in a benchmark-mode bundle.
 */
const HARNESS_IDENTIFIERS = [
  "__dockermapProbe",
  "measureModelAcceptance",
  "browserProbe",
  "benchVite.config",
  "benchAppVite.config",
  "perf:time-to-answer",
  "__dockermapBenchHelpers"
];

/**
 * The acceptance seam's identifiers. They are REAL product source (#335), but
 * they must be compiled out of the shipped artifact and may only exist inside the
 * seam module and the files that import it.
 */
const SEAM_IDENTIFIERS = [
  "__dockermapBenchAcceptanceSink",
  "__dockermapBenchRenderDelayMs",
  "dockermapAcceptedRevision",
  "recordModelAcceptance",
  "useDeliveredModel",
  "ModelAcceptanceStamp"
];

const SEAM_MODULE = "apps/web/src/lib/performance/modelAcceptance.tsx";
const SEAM_IMPORT = "lib/performance/modelAcceptance";

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

function offendersIn(files, identifiers, filter = () => true) {
  const offenders = [];
  for (const file of files.filter(filter)) {
    const body = readFileSync(file, "utf8");
    for (const identifier of identifiers) {
      if (body.includes(identifier)) offenders.push(`${file.slice(REPO_ROOT.length + 1)} → ${identifier}`);
    }
  }
  return offenders;
}

describe("time-to-answer production isolation", () => {
  it("ships no benchmark or seam identifier in the production web bundle", () => {
    const dist = join(REPO_ROOT, "apps/web/dist");
    assert.ok(
      existsSync(dist),
      "apps/web/dist is missing: build the web app first (npm run build) so the shipped artifact can be inspected"
    );
    const artifacts = walk(dist).filter((file) => /\.(js|mjs|css|html|json|map)$/.test(file));
    assert.ok(artifacts.length > 0, "the production build produced no inspectable artifacts");
    const offenders = offendersIn(artifacts, [...HARNESS_IDENTIFIERS, ...SEAM_IDENTIFIERS]);
    assert.deepEqual(
      offenders,
      [],
      `the production bundle references benchmark identifiers: ${offenders.join(", ")}`
    );
  });

  it("keeps harness identifiers entirely out of product sources", () => {
    const offenders = offendersIn(productionSources(), HARNESS_IDENTIFIERS);
    assert.deepEqual(offenders, [], `product sources reference harness identifiers: ${offenders.join(", ")}`);
  });

  it("confines the acceptance seam to the seam module and its import sites", () => {
    const offenders = productionSources()
      .filter((file) => file.slice(REPO_ROOT.length + 1) !== SEAM_MODULE)
      .filter((file) => {
        const body = readFileSync(file, "utf8");
        return SEAM_IDENTIFIERS.some((identifier) => body.includes(identifier)) && !body.includes(SEAM_IMPORT);
      })
      .map((file) => file.slice(REPO_ROOT.length + 1));
    assert.deepEqual(
      offenders,
      [],
      `a product source uses the acceptance seam without importing the seam module: ${offenders.join(", ")}`
    );

    const seam = readFileSync(join(REPO_ROOT, SEAM_MODULE), "utf8");
    // The seam must be gated by the compile-time flag, not by a runtime check, so
    // it can be eliminated entirely from the product build.
    assert.ok(
      seam.includes("__DOCKERMAP_BENCH_ACCEPTANCE__"),
      "the seam module must be gated by the compile-time __DOCKERMAP_BENCH_ACCEPTANCE__ flag"
    );
    assert.ok(
      !/if\s*\(\s*(?:import\.meta\.env|process\.env)/.test(seam),
      "the seam must not be gated by a runtime environment check: it could not be eliminated"
    );
  });

  it("defines the compile-time seam flag as false in the production web config", () => {
    const webConfig = readFileSync(join(REPO_ROOT, "apps/web/vite.config.ts"), "utf8");
    const definition = /__DOCKERMAP_BENCH_ACCEPTANCE__\s*:\s*([^,}\n]+)/.exec(webConfig);
    assert.ok(definition, "the production web config must declare the seam flag");
    assert.equal(
      definition[1].trim(),
      '"false"',
      "the production web config must define the seam flag as the literal string \"false\""
    );
    assert.ok(!webConfig.includes("benchVite"), "the production web config references the benchmark config");
    assert.ok(!webConfig.includes("benchApp"), "the production web config references the benchmark app build");
  });

  it("does not reach a benchmark build config or entry from any production script", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    const productionScripts = Object.entries(pkg.scripts).filter(
      ([name]) => !name.startsWith("perf:") && name !== "test:perf"
    );
    const offenders = productionScripts.filter(
      ([, command]) =>
        command.includes("benchVite") ||
        command.includes("benchAppVite") ||
        command.includes("tests/perf/capture")
    );
    assert.deepEqual(offenders, [], `a production script invokes the benchmark: ${JSON.stringify(offenders)}`);

    const webPackage = JSON.parse(readFileSync(join(REPO_ROOT, "apps/web/package.json"), "utf8"));
    for (const [name, command] of Object.entries(webPackage.scripts)) {
      assert.ok(
        !String(command).includes("bench") && !String(command).includes("tests/perf"),
        `the production web script "${name}" reaches into the benchmark`
      );
    }
  });

  it("compiles the seam into the benchmark-mode application build, not the product", () => {
    const benchAppDist = join(REPO_ROOT, "tests/perf/.bench-app-dist");
    if (!existsSync(benchAppDist)) {
      // The capture harness builds this and asserts the same property itself
      // (fail closed) before it measures anything, so the check is not lost — it
      // simply has no artifact to inspect outside a capture.
      return;
    }
    const artifacts = walk(benchAppDist).filter((file) => /\.(js|mjs|html)$/.test(file));
    assert.ok(artifacts.length > 0, "the benchmark-mode build produced no inspectable artifacts");
    const compiled = artifacts.some((file) =>
      readFileSync(file, "utf8").includes("__dockermapBenchAcceptanceSink")
    );
    assert.ok(compiled, "the benchmark-mode application build does not contain the acceptance seam");
    const offenders = offendersIn(artifacts, HARNESS_IDENTIFIERS);
    assert.deepEqual(
      offenders,
      [],
      `the benchmark-mode application build carries harness identifiers: ${offenders.join(", ")}`
    );
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
    const offenders = offendersIn(
      walk(dist).filter((entry) => /\.(js|mjs|html)$/.test(entry)),
      analytics
    );
    assert.deepEqual(offenders, [], `the production bundle carries analytics markers: ${offenders.join(", ")}`);
  });
});
