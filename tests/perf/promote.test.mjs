import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";

const fixtures = ["reference-25", "reference-100", "reference-250"];
const stages = [
["daemonStartToListenerMs", fixtures],
["listenerToFirstDockerModelMs", fixtures],
["dockerObservationMs", fixtures],
["composeEnrichmentMs", [...fixtures, "slow-bounded-compose-projection"]],
["publicationToNodeObservationMs", [...fixtures, "provider-only-revision-change", "docker-topology-change", "unavailable-optional-provider"]],
["notificationToCoherentModelMs", [...fixtures, "provider-only-revision-change", "docker-topology-change", "unavailable-optional-provider"]],
["coherentModelToUsefulRenderMs", [...fixtures, "docker-topology-change"]],
["buildModelMs", fixtures],
["findingsDerivationMs", fixtures],
["legacyTopologyLayoutMs", fixtures],
["commandQueryMs", fixtures],
["productionBundleMs", fixtures]
];

const environment = {
runnerClass: "linux-x86_64-dedicated", cpuClass: "cpus-16vcpu", osImage: "ubuntu-26.04", osKernel: "7.0.0-31-generic",
nodeRevision: "22.23.2", rustRevision: "1.88.0", dockerRevision: "29.8.1", ssePollIntervalMs: "2000",
daemonBinarySha256: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
daemonBinaryBuild: "cargo-build-release-locked-p-dockermap-daemon", cargoRevision: "cargo-1.88.0",
harnessRevision: "dddddddddddddddddddddddddddddddddddddddd", browserEngine: "chromium", browserRevision: "1.61.0",
browserFlags: ["--disable-background-networking"], fontEnvironment: "system-default", buildMode: "production",
fixtureRevision: "dockermap-v1/time-to-answer-fixtures-1", sourceRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
methodologyVersion: "dockermap-v1/time-to-answer-methodology-8"
};

function artifact(value = 10, overrides = {}) {
return {
baseline: "dockermap-v1/time-to-answer-baseline-4",
environment: { ...environment, ...(overrides.environment ?? {}) },
records: stages.flatMap(([stage, names]) => names.map((fixture) => ({
fixture, stage, measurementProtocol: stage === "publicationToNodeObservationMs" ? "controlled-poll-phase" : "end-to-end",
sourceEvidenceFile: "synthetic.raw.json", checkpointSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
runs: Array.from({ length: 3 }, () => Array.from({ length: 15 }, () => value))
})))
};
}

function run(baseline, candidate) {
const directory = mkdtempSync(join(tmpdir(), "dockermap-promote-"));
try {
const baselinePath = join(directory, "baseline.json");
const candidatePath = join(directory, "candidate.json");
writeFileSync(baselinePath, JSON.stringify(baseline));
writeFileSync(candidatePath, JSON.stringify(candidate));
return spawnSync("npx", ["tsx", "tests/perf/promote.ts", "--baseline", baselinePath, "--candidate", candidatePath], {
cwd: new URL("../..", import.meta.url), encoding: "utf8", timeout: 30_000
});
} finally {
rmSync(directory, { recursive: true, force: true });
}
}

test("promotion CLI accepts a compatible candidate within the reviewed limit", () => {
const result = run(artifact(10), artifact(12));
assert.equal(result.status, 0, result.stderr);
assert.match(result.stdout, /PROMOTION: PASS/);
});

test("promotion CLI names a stage beyond the reviewed limit", () => {
const candidate = artifact(10);
candidate.records[0].runs = Array.from({ length: 3 }, () => Array.from({ length: 15 }, () => 13));
const result = run(artifact(10), candidate);
assert.notEqual(result.status, 0);
assert.match(result.stdout, /reference-25\u0000daemonStartToListenerMs/);
assert.match(result.stdout, /PROMOTION: FAIL:Time-to-answer candidate exceeds/);
});

test("promotion CLI rejects an incompatible environment before a timing limit", () => {
const result = run(artifact(10), artifact(99, { environment: { osImage: "different-image" } }));
assert.notEqual(result.status, 0);
assert.match(result.stdout, /candidate does not match the pinned baseline environment/);
assert.doesNotMatch(result.stdout, /candidate exceeds the reviewed promotion limit/);
});
