/**
 * RED-checks for the time-to-answer promotion gate (#335).
 *
 * Every case here must fail for an EVIDENCE reason — a bad comparison — and not
 * because the fixture happens to be malformed in some unrelated way. The
 * candidate in each rejection case is otherwise a complete, valid artifact.
 */
import { describe, expect, it } from "vitest";
import {
  TIME_TO_ANSWER_BASELINE,
  TIME_TO_ANSWER_CONTROLLED_RUNS,
  TIME_TO_ANSWER_MATRIX,
  TIME_TO_ANSWER_WARMED_SAMPLES,
  assertTimeToAnswerPromotion,
  assertDaemonBinaryProvenance,
  isScenarioCell,
  splitWarmedObservations,
  summarizeTimeToAnswerStage,
  TIME_TO_ANSWER_STAGE_KIND,
  TIME_TO_ANSWER_STAGES,
  timeToAnswerLimit,
  validateTimeToAnswerEvidence
} from "./timeToAnswerEvidence";

const environment = {
  runnerClass: "linux-x86_64-dedicated",
  cpuClass: "cpus-16vcpu",
  osImage: "ubuntu-26.04",
  osKernel: "7.0.0-31-generic",
  nodeRevision: "22.23.2",
  rustRevision: "1.88.0",
  dockerRevision: "29.8.1",
  ssePollIntervalMs: "2000",
  daemonBinarySha256: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  daemonBinaryBuild: "cargo-build-release-locked-p-dockermap-daemon",
  cargoRevision: "cargo-1.88.0",
  harnessRevision: "dddddddddddddddddddddddddddddddddddddddd",
  browserEngine: "chromium",
  browserRevision: "1.61.0",
  browserFlags: ["--disable-background-networking"],
  fontEnvironment: "system-default",
  buildMode: "production",
  fixtureRevision: "dockermap-v1/time-to-answer-fixtures-1",
  sourceRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
};

/** 15 finite non-negative warmed samples with a per-run offset. */
function samples(base: number): number[] {
  return Array.from({ length: TIME_TO_ANSWER_WARMED_SAMPLES }, (_, index) => base + index * 0.1);
}

function artifact(overrides: { environment?: Record<string, unknown>; records?: unknown[] } = {}) {
  return {
    baseline: TIME_TO_ANSWER_BASELINE,
    environment: { ...environment, ...(overrides.environment ?? {}) },
    records:
      overrides.records ??
      TIME_TO_ANSWER_MATRIX.map(({ fixture, stage }) => ({
        fixture,
        stage,
        runs: [samples(10), samples(11), samples(12)]
      }))
  };
}

function candidate(overrides: { environment?: Record<string, unknown>; records?: unknown[] } = {}) {
  return artifact({
    ...overrides,
    environment: { sourceRevision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", ...(overrides.environment ?? {}) }
  });
}

describe("time-to-answer promotion gate", () => {
  it("accepts a compatible candidate inside the reviewed budget", () => {
    expect(() => assertTimeToAnswerPromotion(artifact(), candidate())).not.toThrow();
  });

  it("accepts the only environment difference a candidate may carry: sourceRevision", () => {
    const comparable = candidate({ environment: { sourceRevision: "cccccccccccccccccccccccccccccccccccccccc" } });
    expect(validateTimeToAnswerEvidence(comparable).environment.sourceRevision).toBe(
      "cccccccccccccccccccccccccccccccccccccccc"
    );
    expect(() => assertTimeToAnswerPromotion(artifact(), comparable)).not.toThrow();
  });

  it("rejects a candidate above the reviewed budget, naming the cell", () => {
    const slow = candidate({
      records: TIME_TO_ANSWER_MATRIX.map(({ fixture, stage }) =>
        fixture === "reference-250" && stage === "dockerObservationMs"
          ? { fixture, stage, runs: [samples(1_000), samples(1_000), samples(1_000)] }
          : { fixture, stage, runs: [samples(10), samples(11), samples(12)] }
      )
    });
    expect(() => assertTimeToAnswerPromotion(artifact(), slow)).toThrow("promotion limit");
    // The limit itself is the reviewed rule, not an invented constant.
    expect(timeToAnswerLimit(10)).toBe(12.5);
    expect(timeToAnswerLimit(1)).toBe(3);
  });

  it("rejects a slow cell the budget tolerates only just", () => {
    const limit = timeToAnswerLimit(12);
    const pass = candidate({
      records: TIME_TO_ANSWER_MATRIX.map(({ fixture, stage }) =>
        fixture === "reference-100" && stage === "buildModelMs"
          ? { fixture, stage, runs: [[limit, limit, limit, ...Array(12).fill(limit)], [limit, limit, limit, ...Array(12).fill(limit)], [limit, limit, limit, ...Array(12).fill(limit)]] }
          : { fixture, stage, runs: [samples(1), samples(1), samples(1)] }
      )
    });
    expect(() => assertTimeToAnswerPromotion(artifact(), pass)).not.toThrow();
    const fail = candidate({
      records: TIME_TO_ANSWER_MATRIX.map(({ fixture, stage }) =>
        fixture === "reference-100" && stage === "buildModelMs"
          ? { fixture, stage, runs: [[limit + 1, ...Array(14).fill(limit + 1)], [limit + 1, ...Array(14).fill(limit + 1)], [limit + 1, ...Array(14).fill(limit + 1)]] }
          : { fixture, stage, runs: [samples(1), samples(1), samples(1)] }
      )
    });
    expect(() => assertTimeToAnswerPromotion(artifact(), fail)).toThrow("promotion limit");
  });

  it.each([
    ["runner class", "runnerClass", "some-other-runner"],
    ["cpu class", "cpuClass", "cpus-2vcpu"],
    ["os image", "osImage", "debian-13"],
    ["os kernel", "osKernel", "6.8.0-31-generic"],
    ["node revision", "nodeRevision", "20.11.0"],
    ["rust revision", "rustRevision", "1.80.0"],
    ["chromium revision", "browserRevision", "1.50.0"],
    ["fixture revision", "fixtureRevision", "dockermap-v1/other-fixtures"],
    ["sse poll interval", "ssePollIntervalMs", "1000"],
    ["font environment", "fontEnvironment", "different-fonts"]
  ])("rejects a candidate whose %s does not match the pinned baseline", (_label, key, value) => {
    expect(() => assertTimeToAnswerPromotion(artifact(), candidate({ environment: { [key]: value } }))).toThrow(
      "does not match the pinned baseline environment"
    );
  });

  it("treats dockerRevision as informational: a host engine change must not fail a comparison", () => {
    // No measured stage exercises the host Docker daemon — the capture runs
    // against the deterministic fixture daemon — so pinning it as a
    // compatibility key would reject a candidate for an untouched dimension.
    expect(() =>
      assertTimeToAnswerPromotion(artifact(), candidate({ environment: { dockerRevision: "30.1.0" } }))
    ).not.toThrow();
  });

  it("pins the median-of-three aggregation, not the first run or the pooled mean", () => {
    // One slow run and two fast runs: the median must pass, while a first-run
    // p95 or a pooled mean would exceed the budget.
    const slowFirst = candidate({
      records: TIME_TO_ANSWER_MATRIX.map(({ fixture, stage }) =>
        fixture === "reference-250" && stage === "commandQueryMs"
          ? {
              fixture,
              stage,
              runs: [
                [...Array(15).fill(500)],
                [...Array(15).fill(10)],
                [...Array(15).fill(10)]
              ]
            }
          : { fixture, stage, runs: [samples(10), samples(11), samples(12)] }
      )
    });
    expect(() => assertTimeToAnswerPromotion(artifact(), slowFirst)).not.toThrow();

    // Two slow runs and one fast run: the median is slow, so it must fail.
    const slowMajority = candidate({
      records: TIME_TO_ANSWER_MATRIX.map(({ fixture, stage }) =>
        fixture === "reference-250" && stage === "commandQueryMs"
          ? {
              fixture,
              stage,
              runs: [
                [...Array(15).fill(10)],
                [...Array(15).fill(500)],
                [...Array(15).fill(500)]
              ]
            }
          : { fixture, stage, runs: [samples(10), samples(11), samples(12)] }
      )
    });
    expect(() => assertTimeToAnswerPromotion(artifact(), slowMajority)).toThrow("promotion limit");
  });

  it("cannot let a cold first observation enter a warmed stage summary", () => {
    // The daemon's first-ever observation is a cold start, and with 15 recorded
    // samples nearest-rank p95 IS the maximum — so one cold observation would
    // become the published number. Exactly one observation is discarded as
    // warm-up; the rest are recorded unchanged.
    const observations = [99.9, ...Array.from({ length: 15 }, (_, index) => 2 + index * 0.1)];
    const { warmUp, recorded } = splitWarmedObservations(observations);
    expect(warmUp).toBe(99.9);
    expect(recorded).toEqual(observations.slice(1));
    const summary = summarizeTimeToAnswerStage([recorded, recorded, recorded]);
    expect(summary.runP95Ms.every((value) => value < 10)).toBe(true);
    expect(summary.medianOfThreeRunP95Ms).toBeLessThan(10);
    // No arbitrary sampling: the whole window is needed, and a short window fails.
    expect(() => splitWarmedObservations(observations.slice(0, 15))).toThrow();
  });

  it("binds the executed daemon binary to the recorded revision", () => {
    const digest = "a".repeat(64);
    expect(() =>
      assertDaemonBinaryProvenance({ expectedSha256: digest, observedSha256: digest, phase: "before" })
    ).not.toThrow();
    expect(() =>
      assertDaemonBinaryProvenance({
        expectedSha256: digest,
        observedSha256: "b".repeat(64),
        phase: "before capture"
      })
    ).toThrow("daemon binary provenance failed");
    expect(() =>
      assertDaemonBinaryProvenance({ expectedSha256: "not-a-digest", observedSha256: digest, phase: "before" })
    ).toThrow("two lowercase sha256 digests");
  });

  it("classifies every stage as cold-start, warmed-repeated or scenario-specific", () => {
    for (const stage of TIME_TO_ANSWER_STAGES) {
      expect(TIME_TO_ANSWER_STAGE_KIND[stage.id]).toBeDefined();
    }
    // Process start is genuinely cold: its first observation IS the measurement.
    expect(TIME_TO_ANSWER_STAGE_KIND.daemonStartToListenerMs).toBe("cold-start");
    expect(TIME_TO_ANSWER_STAGE_KIND.listenerToFirstDockerModelMs).toBe("cold-start");
    // The daemon-side attribution stages are warmed repeated operations.
    expect(TIME_TO_ANSWER_STAGE_KIND.dockerObservationMs).toBe("warmed-repeated");
    expect(TIME_TO_ANSWER_STAGE_KIND.composeEnrichmentMs).toBe("warmed-repeated");
    expect(TIME_TO_ANSWER_STAGE_KIND.findingsDerivationMs).toBe("warmed-repeated");
    // Scenario cells are declared only for scenario fixtures.
    expect(isScenarioCell("slow-bounded-compose-projection", "composeEnrichmentMs")).toBe(true);
    expect(isScenarioCell("reference-25", "composeEnrichmentMs")).toBe(false);
  });

  it("rejects a candidate with different browser flags", () => {
    expect(() =>
      assertTimeToAnswerPromotion(
        artifact(),
        candidate({ environment: { browserFlags: ["--disable-background-networking", "--enable-gpu"] } })
      )
    ).toThrow("does not match the pinned baseline environment");
  });

  it("rejects a candidate built in a non-production mode", () => {
    expect(() => validateTimeToAnswerEvidence(candidate({ environment: { buildMode: "development" } }))).toThrow(
      "closed safe metadata fields"
    );
  });

  it("rejects evidence with a missing stage", () => {
    const records = TIME_TO_ANSWER_MATRIX.slice(1).map(({ fixture, stage }) => ({
      fixture,
      stage,
      runs: [samples(10), samples(11), samples(12)]
    }));
    expect(() => validateTimeToAnswerEvidence(artifact({ records }))).toThrow("exact fixture × stage matrix");
  });

  it("rejects evidence with an undeclared stage", () => {
    const records = [
      ...TIME_TO_ANSWER_MATRIX.map(({ fixture, stage }) => ({
        fixture,
        stage,
        runs: [samples(10), samples(11), samples(12)]
      })),
      { fixture: "reference-25", stage: "inventedStageMs", runs: [samples(1), samples(1), samples(1)] }
    ];
    expect(() => validateTimeToAnswerEvidence(artifact({ records }))).toThrow("exact fixture × stage matrix");
  });

  it("rejects a malformed sample count", () => {
    const records = TIME_TO_ANSWER_MATRIX.map(({ fixture, stage }) =>
      fixture === "reference-25" && stage === "commandQueryMs"
        ? { fixture, stage, runs: [samples(10).slice(0, 14), samples(11), samples(12)] }
        : { fixture, stage, runs: [samples(10), samples(11), samples(12)] }
    );
    expect(() => validateTimeToAnswerEvidence(artifact({ records }))).toThrow(
      `requires exactly ${TIME_TO_ANSWER_WARMED_SAMPLES} finite`
    );
  });

  it("rejects a stage with too few controlled runs", () => {
    const records = TIME_TO_ANSWER_MATRIX.map(({ fixture, stage }) =>
      fixture === "reference-100" && stage === "buildModelMs"
        ? { fixture, stage, runs: [samples(10), samples(11)] }
        : { fixture, stage, runs: [samples(10), samples(11), samples(12)] }
    );
    expect(() => validateTimeToAnswerEvidence(artifact({ records }))).toThrow(
      "requires exactly three raw runs per stage"
    );
    expect(TIME_TO_ANSWER_CONTROLLED_RUNS).toBe(3);
  });

  it("rejects a supplied or fabricated summary instead of recomputing it", () => {
    const records = TIME_TO_ANSWER_MATRIX.map(({ fixture, stage }) =>
      fixture === "reference-250" && stage === "composeEnrichmentMs"
        ? {
            fixture,
            stage,
            runs: [samples(10), samples(11), samples(12)],
            summary: { runP95Ms: [1, 1, 1], medianOfThreeRunP95Ms: 1 }
          }
        : { fixture, stage, runs: [samples(10), samples(11), samples(12)] }
    );
    expect(() => validateTimeToAnswerEvidence(artifact({ records }))).toThrow("unsafe or incomplete shape");
  });

  it("rejects a negative or non-finite sample", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "12" as unknown as number]) {
      const records = TIME_TO_ANSWER_MATRIX.map(({ fixture, stage }) =>
        fixture === "reference-25" && stage === "findingsDerivationMs"
          ? { fixture, stage, runs: [[bad, ...samples(10).slice(1)], samples(11), samples(12)] }
          : { fixture, stage, runs: [samples(10), samples(11), samples(12)] }
      );
      expect(() => validateTimeToAnswerEvidence(artifact({ records }))).toThrow();
    }
  });

  it("rejects an unknown baseline identifier", () => {
    expect(() => validateTimeToAnswerEvidence({ ...artifact(), baseline: "dockermap-v1/other" })).toThrow(
      "closed baseline/environment/records schema"
    );
  });
});
