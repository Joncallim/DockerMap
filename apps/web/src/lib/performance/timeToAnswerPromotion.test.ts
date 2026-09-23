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
  TIME_TO_ANSWER_METHODOLOGY,
  TIME_TO_ANSWER_WARMED_SAMPLES,
  TIME_TO_ANSWER_WARM_UP_OBSERVATIONS,
  assertTimeToAnswerPromotion,
  assertWarmUpStationarity,
  assertDaemonBinaryProvenance,
  compatibleTimeToAnswerEnvironment,
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
  sourceRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  methodologyVersion: TIME_TO_ANSWER_METHODOLOGY
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

  it("accepts the provenance differences a candidate may carry: source revision, harness revision, rebuilt digest", () => {
    // Source and harness revisions differ by construction, and the daemon binary is
    // REBUILT from the candidate checkout — so a byte-identical digest is not even
    // reproducible across a changed CARGO_HOME. Requiring any of them to match would
    // make every candidate that touches the product or the harness uncomparable.
    const comparable = candidate({
      environment: {
        sourceRevision: "cccccccccccccccccccccccccccccccccccccccc",
        harnessRevision: "ab".repeat(20),
        daemonBinarySha256: "f".repeat(64)
      }
    });
    expect(() => assertTimeToAnswerPromotion(artifact(), comparable)).not.toThrow();
    const baseline = validateTimeToAnswerEvidence(artifact());
    const validated = validateTimeToAnswerEvidence(comparable);
    expect(compatibleTimeToAnswerEnvironment(baseline.environment, validated.environment)).toBe(true);
    expect(validated.environment.daemonBinarySha256).toBe("f".repeat(64));
  });

  it("rejects a candidate measured under a different methodology version", () => {
    const other = candidate({ environment: { methodologyVersion: "dockermap-v1/time-to-answer-methodology-1" } });
    expect(
      compatibleTimeToAnswerEnvironment(
        validateTimeToAnswerEvidence(artifact()).environment,
        validateTimeToAnswerEvidence(other).environment
      )
    ).toBe(false);
    expect(() => assertTimeToAnswerPromotion(artifact(), other)).toThrow(
      "does not match the pinned baseline environment"
    );
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
    // The daemon's first passes are cold, and with 15 recorded samples nearest-rank
    // p95 IS the maximum — so a surviving cold observation would become the
    // published number. The protocol discards a FIXED five observations (declared
    // before the capture), keeps them all for audit, and never trims further.
    const cold = [99.9, 40.1, 12.2, 3.4, 2.9];
    const warm = Array.from({ length: TIME_TO_ANSWER_WARMED_SAMPLES }, (_, index) => 2 + index * 0.1);
    const { warmUps, recorded } = splitWarmedObservations([...cold, ...warm]);
    expect(warmUps).toEqual(cold);
    expect(warmUps).toHaveLength(TIME_TO_ANSWER_WARM_UP_OBSERVATIONS);
    expect(recorded).toEqual(warm);
    const summary = summarizeTimeToAnswerStage([recorded, recorded, recorded]);
    expect(summary.runP95Ms.every((value) => value < 10)).toBe(true);
    expect(summary.medianOfThreeRunP95Ms).toBeLessThan(10);
    // No arbitrary sampling: the whole window is required and a short window FAILS
    // rather than being silently trimmed to the declared count.
    expect(() => splitWarmedObservations([...cold, ...warm].slice(0, cold.length + warm.length - 1))).toThrow();
  });

  it("invalidates a warmed window whose declared stationarity band is violated", () => {
    const measured = Array.from({ length: TIME_TO_ANSWER_WARMED_SAMPLES }, (_, index) => 2 + index * 0.1);
    // Warm-ups that never settled: the final pair still sits far above the measured
    // median, which is what the old single-discard policy published as a sample.
    const unsettled = [99.9, 40.1, 12.2, 11.6, 11.3];
    const bad = splitWarmedObservations([...unsettled, ...measured]);
    expect(() => assertWarmUpStationarity({ label: "reference-100|dockerObservationMs|run0", ...bad })).toThrow(
      /not stationary/
    );
    // A settled window passes and reports its ratio (declared band 0.5x–1.5x).
    const settled = splitWarmedObservations([99.9, 40.1, 12.2, 3.4, 2.9, ...measured]);
    const ratio = assertWarmUpStationarity({ label: "reference-100|dockerObservationMs|run0", ...settled });
    expect(ratio).toBeGreaterThanOrEqual(0.5);
    expect(ratio).toBeLessThanOrEqual(1.5);
    // The guard never repairs a window: it rejects, and the sample count must be
    // exactly the declared 15.
    expect(() =>
      assertWarmUpStationarity({ label: "x", warmUps: settled.warmUps, recorded: settled.recorded.slice(0, 14) })
    ).toThrow(/exactly 15 measured samples/);
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
