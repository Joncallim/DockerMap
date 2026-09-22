import { describe, expect, it } from "vitest";
import {
  TIME_TO_ANSWER_BASELINE,
  TIME_TO_ANSWER_CONTROLLED_RUNS,
  TIME_TO_ANSWER_MATRIX,
  TIME_TO_ANSWER_REFERENCE_FIXTURES,
  TIME_TO_ANSWER_STAGES,
  TIME_TO_ANSWER_WARMED_SAMPLES,
  assertTimeToAnswerPromotion,
  compatibleTimeToAnswerEnvironment,
  derivedTimeToAnswerSummaries,
  summarizeTimeToAnswerStage,
  timeToAnswerLimit,
  timeToAnswerP95,
  validateTimeToAnswerEvidence,
  withinTimeToAnswerPromotionLimit
} from "./timeToAnswerEvidence";

const environment: Record<string, unknown> = {
  runnerClass: "hearth-dedicated-x64",
  cpuClass: "pinned-4-vcpu",
  osImage: "ubuntu-24.04@sha256:fixture",
  osKernel: "7.0.0-31-generic",
  nodeRevision: "22.23.2",
  rustRevision: "1.88.0",
  dockerRevision: "29.0.0",
  browserEngine: "chromium",
  browserRevision: "1234567",
  browserFlags: ["--disable-background-networking"],
  fontEnvironment: "Noto-Sans-1.0",
  buildMode: "production",
  fixtureRevision: "dockermap-v1/time-to-answer-fixtures-1",
  sourceRevision: "candidate"
};

/**
 * Deliberately loosely typed: every hostile case below mutates the raw JSON a
 * benchmark job would emit, and the validator must reject it without the test
 * needing a cast per mutation.
 */
function rawEvidence(): {
  baseline: string;
  environment: Record<string, unknown>;
  records: { fixture: string; stage: string; runs: number[][] }[];
} {
  return {
    baseline: TIME_TO_ANSWER_BASELINE,
    environment,
    records: TIME_TO_ANSWER_MATRIX.map(({ fixture, stage }, record) => ({
      fixture,
      stage,
      runs: Array.from({ length: TIME_TO_ANSWER_CONTROLLED_RUNS }, (_, run) =>
        Array.from(
          { length: TIME_TO_ANSWER_WARMED_SAMPLES },
          (_, sample) => record * 100 + run * 10 + sample + 1
        )
      )
    }))
  };
}

describe("time-to-answer evidence contract", () => {
  it("defines a closed stage matrix covering every acceptance bucket", () => {
    expect(new Set(TIME_TO_ANSWER_STAGES.map((stage) => stage.id)).size).toBe(
      TIME_TO_ANSWER_STAGES.length
    );
    expect([...new Set(TIME_TO_ANSWER_STAGES.map((stage) => stage.bucket))].sort()).toEqual([
      "backend-collection",
      "browser-model",
      "rendering",
      "search",
      "transport-notification"
    ]);
    // The three reference sizes are measured for every stage.
    for (const stage of TIME_TO_ANSWER_STAGES) {
      for (const reference of ["reference-25", "reference-100", "reference-250"]) {
        expect(stage.fixtures).toContain(reference);
      }
    }
    // Every listed fixture is a declared fixture, and the matrix is the union
    // of the per-stage lists with no duplicate pair.
    const declared = new Set<string>(TIME_TO_ANSWER_REFERENCE_FIXTURES.map((fixture) => fixture.name));
    const expectedPairs = TIME_TO_ANSWER_STAGES.flatMap((stage) => stage.fixtures).length;
    expect(TIME_TO_ANSWER_MATRIX.length).toBe(expectedPairs);
    expect(new Set(TIME_TO_ANSWER_MATRIX.map(({ fixture, stage }) => `${fixture}\u0000${stage}`)).size).toBe(
      TIME_TO_ANSWER_MATRIX.length
    );
    for (const { fixture } of TIME_TO_ANSWER_MATRIX) expect(declared.has(fixture)).toBe(true);
    // The four scenario fixtures exist and are actually exercised.
    for (const scenario of [
      "provider-only-revision-change",
      "docker-topology-change",
      "slow-bounded-compose-projection",
      "unavailable-optional-provider"
    ]) {
      expect(declared.has(scenario)).toBe(true);
      expect(TIME_TO_ANSWER_MATRIX.some(({ fixture }) => fixture === scenario)).toBe(true);
    }
  });

  it("documents what each stage proves and does not prove", () => {
    for (const stage of TIME_TO_ANSWER_STAGES) {
      expect(stage.measures.length).toBeGreaterThan(20);
      expect(stage.doesNotProve.length).toBeGreaterThan(20);
    }
  });

  it("recomputes summaries from raw samples instead of trusting supplied values", () => {
    const evidence = validateTimeToAnswerEvidence(rawEvidence());
    const summaries = derivedTimeToAnswerSummaries(evidence);
    expect(TIME_TO_ANSWER_CONTROLLED_RUNS).toBe(3);
    expect(TIME_TO_ANSWER_WARMED_SAMPLES).toBe(15);
    expect(timeToAnswerP95(Array.from({ length: 15 }, (_, index) => index))).toBe(14);
    const warmed = Array.from({ length: 15 }, (_, index) => index + 1);
    expect(summarizeTimeToAnswerStage([warmed, warmed, warmed])).toEqual({
      runP95Ms: [15, 15, 15],
      medianOfThreeRunP95Ms: 15
    });
    const first = TIME_TO_ANSWER_MATRIX[0]!;
    expect(summaries.get(`${first.fixture}\u0000${first.stage}`)).toEqual({
      runP95Ms: [15, 25, 35],
      medianOfThreeRunP95Ms: 25
    });
  });

  it("fails closed on fabricated, incomplete or hostile artifacts", () => {
    expect(() =>
      validateTimeToAnswerEvidence({ ...rawEvidence(), summary: "fabricated" })
    ).toThrow("closed baseline/environment/records schema");
    expect(() =>
      validateTimeToAnswerEvidence({
        ...rawEvidence(),
        baseline: "dockermap-v1/other-baseline"
      })
    ).toThrow("closed baseline/environment/records schema");
    expect(() =>
      validateTimeToAnswerEvidence({
        ...rawEvidence(),
        records: rawEvidence().records.slice(1)
      })
    ).toThrow("exact fixture × stage matrix");

    const shortRun = rawEvidence();
    shortRun.records[0]!.runs[0] = [1];
    expect(() => validateTimeToAnswerEvidence(shortRun)).toThrow("exactly 15");

    const twoRuns = rawEvidence();
    twoRuns.records[0]!.runs = twoRuns.records[0]!.runs.slice(0, 2);
    expect(() => validateTimeToAnswerEvidence(twoRuns)).toThrow("three raw runs");

    const negative = rawEvidence();
    negative.records[0]!.runs[0] = Array.from({ length: 15 }, () => -1);
    expect(() => validateTimeToAnswerEvidence(negative)).toThrow("finite non-negative");

    const notANumber = rawEvidence();
    notANumber.records[0]!.runs[0] = Array.from({ length: 15 }, () => "fast" as unknown as number);
    expect(() => validateTimeToAnswerEvidence(notANumber)).toThrow("numeric");

    const unknownStage = rawEvidence();
    unknownStage.records[0]!.stage = "vibesMs" as never;
    expect(() => validateTimeToAnswerEvidence(unknownStage)).toThrow("unsafe or incomplete shape");

    const duplicated = rawEvidence();
    duplicated.records[1] = { ...duplicated.records[0]! };
    expect(() => validateTimeToAnswerEvidence(duplicated)).toThrow("duplicate or unsupported");

    const undeclaredFixture = rawEvidence();
    undeclaredFixture.records[0]!.fixture = "reference-1000";
    expect(() => validateTimeToAnswerEvidence(undeclaredFixture)).toThrow(
      "duplicate or unsupported"
    );
  });

  it("rejects unsafe or arbitrary runner metadata and only compares equivalent pinned environments", () => {
    expect(() =>
      validateTimeToAnswerEvidence({
        ...rawEvidence(),
        environment: { ...environment, rawHostPath: "/private/host" }
      })
    ).toThrow("closed safe metadata fields");
    expect(() =>
      validateTimeToAnswerEvidence({
        ...rawEvidence(),
        environment: { ...environment, fontEnvironment: "font with spaces" }
      })
    ).toThrow("closed safe metadata fields");
    expect(() =>
      validateTimeToAnswerEvidence({
        ...rawEvidence(),
        environment: { ...environment, browserEngine: "webkit" }
      })
    ).toThrow("closed safe metadata fields");

    const baseline = validateTimeToAnswerEvidence(rawEvidence()).environment;
    expect(compatibleTimeToAnswerEnvironment(baseline, { ...baseline, sourceRevision: "other" })).toBe(
      true
    );
    expect(compatibleTimeToAnswerEnvironment(baseline, { ...baseline, browserRevision: "9" })).toBe(
      false
    );
    expect(compatibleTimeToAnswerEnvironment(baseline, { ...baseline, dockerRevision: "30.0.0" })).toBe(
      false
    );
    expect(compatibleTimeToAnswerEnvironment(baseline, { ...baseline, fixtureRevision: "v2" })).toBe(
      false
    );
  });

  it("uses the reviewed max(baseline × 1.25, baseline + 2 ms) promotion gate", () => {
    expect(timeToAnswerLimit(4)).toBe(6);
    expect(timeToAnswerLimit(20)).toBe(25);
    expect(withinTimeToAnswerPromotionLimit(20, 25)).toBe(true);
    expect(withinTimeToAnswerPromotionLimit(20, 25.01)).toBe(false);
    expect(() => timeToAnswerLimit(-1)).toThrow("finite non-negative");
    expect(() => timeToAnswerLimit(Number.NaN)).toThrow("finite non-negative");

    const candidate = rawEvidence();
    candidate.environment = { ...candidate.environment, sourceRevision: "other" };
    expect(() => assertTimeToAnswerPromotion(rawEvidence(), candidate)).not.toThrow();

    const slower = rawEvidence();
    slower.records[0]!.runs = slower.records[0]!.runs.map((run) => run.map(() => 1_000_000));
    expect(() => assertTimeToAnswerPromotion(rawEvidence(), slower)).toThrow(
      "exceeds the reviewed promotion limit"
    );

    const wrongEnvironment = rawEvidence();
    wrongEnvironment.environment = { ...wrongEnvironment.environment, dockerRevision: "30.0.0" };
    expect(() => assertTimeToAnswerPromotion(rawEvidence(), wrongEnvironment)).toThrow(
      "does not match the pinned baseline environment"
    );
  });
});
