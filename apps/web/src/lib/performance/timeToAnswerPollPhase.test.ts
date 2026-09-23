/**
 * RED-checks for the stage-5 deterministic poll-phase design (#335, methodology
 * revision 2).
 *
 * The design replaced a uniform random trigger delay with a declared phase grid,
 * because baseline 3's raw samples proved the jitter did not move the phase: the
 * reference-25 samples occupied a 120 ms band of a 2000 ms interval. These tests
 * pin the design (grid shape, assignment, bucketing, normalisation) and, above
 * all, pin the guards: a sweep confined to a narrow band, a missing phase, an
 * uncontrolled publication, an observation that did not travel the real API poller
 * path, or a sample that observed no new revision must all be REJECTED.
 */
import { describe, expect, it } from "vitest";
import {
  POLL_PHASE_CONTROL_TOLERANCE_MS,
  POLL_PHASE_DIVISIONS,
  POLL_PHASE_MIN_SAMPLES_PER_PHASE,
  assertPollPhaseSweep,
  declaredPhaseForSample,
  intendedLatencyMs,
  observedPhaseBucketMs,
  phaseMediansMs,
  phaseNormalizedP95Ms,
  pollPhaseGridMs,
  type PollPhaseSweep
} from "./timeToAnswerPollPhase";
import { TIME_TO_ANSWER_CONTROLLED_RUNS, TIME_TO_ANSWER_WARMED_SAMPLES } from "./timeToAnswerEvidence";

const INTERVAL = 2000;

/**
 * A sweep that satisfies the declared design: every phase present, each run
 * sweeping the grid ascending, observed latency equal to the intended value with a
 * small, deterministic error so the samples are not identical.
 */
function goodSweep(intervalMs = INTERVAL, errorMs = 4): PollPhaseSweep[] {
  const samples: PollPhaseSweep[] = [];
  for (let run = 0; run < TIME_TO_ANSWER_CONTROLLED_RUNS; run += 1) {
    for (let index = 0; index < POLL_PHASE_DIVISIONS; index += 1) {
      const declaredPhaseMs = declaredPhaseForSample(run, index, intervalMs);
      const intended = intendedLatencyMs(declaredPhaseMs, intervalMs);
      const observed = intended + errorMs + run;
      samples.push({
        runIndex: run,
        sampleIndex: index,
        declaredPhaseMs,
        intendedLatencyMs: intended,
        connectedAtMs: 0,
        predictedPublicationAtMs: 1000,
        observedPublicationAtMs: 1000,
        observedObservationAtMs: 1000 + observed,
        observedLatencyMs: observed,
        observedPhaseBucketMs: observedPhaseBucketMs(observed, intervalMs),
        phaseErrorMs: observed - intended,
        observedVia: "api-sse",
        observedRevision: `rev-${run}-${index}`,
        previousRevision: `rev-${run}-${index}-prev`
      });
    }
  }
  return samples;
}

describe("stage-5 declared phase grid", () => {
  it("divides the poll interval into the declared number of phases", () => {
    const grid = pollPhaseGridMs(INTERVAL);
    expect(grid).toHaveLength(POLL_PHASE_DIVISIONS);
    expect(grid).toHaveLength(TIME_TO_ANSWER_WARMED_SAMPLES);
    expect([...grid].sort((left, right) => left - right)).toEqual(grid);
    expect(new Set(grid).size).toBe(grid.length);
    // Every phase sits strictly inside the interval: a publication landing exactly
    // on a tick is inherently ambiguous and is deliberately not declared.
    expect(grid[0]!).toBeGreaterThan(0);
    expect(grid[grid.length - 1]!).toBeLessThan(INTERVAL);
    // The declared phases cover essentially the whole interval.
    const span = grid[grid.length - 1]! - grid[0]!;
    expect(span / INTERVAL).toBeGreaterThan(0.8);
  });

  it("maps each declared phase to a strictly decreasing intended latency", () => {
    const latencies = pollPhaseGridMs(INTERVAL).map((phase) => intendedLatencyMs(phase, INTERVAL));
    for (let index = 1; index < latencies.length; index += 1) {
      expect(latencies[index]!).toBeLessThan(latencies[index - 1]!);
    }
    expect(latencies[0]!).toBeLessThan(INTERVAL);
    expect(latencies[latencies.length - 1]!).toBeGreaterThan(0);
  });

  it("assigns one declared phase per sample, identical across runs", () => {
    for (let index = 0; index < POLL_PHASE_DIVISIONS; index += 1) {
      const runZero = declaredPhaseForSample(0, index, INTERVAL);
      expect(declaredPhaseForSample(1, index, INTERVAL)).toBe(runZero);
      expect(declaredPhaseForSample(2, index, INTERVAL)).toBe(runZero);
      expect(runZero).toBe(pollPhaseGridMs(INTERVAL)[index]);
    }
    expect(() => declaredPhaseForSample(0, POLL_PHASE_DIVISIONS, INTERVAL)).toThrow();
    expect(() => declaredPhaseForSample(0, -1, INTERVAL)).toThrow();
  });

  it("buckets an observed latency to the nearest declared latency", () => {
    const grid = pollPhaseGridMs(INTERVAL).map((phase) => intendedLatencyMs(phase, INTERVAL));
    for (const candidate of grid) {
      expect(observedPhaseBucketMs(candidate + 3, INTERVAL)).toBe(candidate);
      expect(observedPhaseBucketMs(candidate - 3, INTERVAL)).toBe(candidate);
    }
  });
});

describe("stage-5 phase sweep validity", () => {
  it("accepts a sweep that covers the declared grid with a controlled phase", () => {
    const verdict = assertPollPhaseSweep(goodSweep(), INTERVAL);
    expect(verdict.divisions).toBe(POLL_PHASE_DIVISIONS);
    expect(verdict.samples).toBe(POLL_PHASE_DIVISIONS * TIME_TO_ANSWER_CONTROLLED_RUNS);
    expect(verdict.samplesPerPhase.every((count) => count >= POLL_PHASE_MIN_SAMPLES_PER_PHASE)).toBe(true);
    expect(verdict.spanShare).toBeGreaterThan(0.5);
    expect(verdict.directionShare).toBeGreaterThan(0.5);
    expect(verdict.worstPhaseErrorMs).toBeLessThanOrEqual(POLL_PHASE_CONTROL_TOLERANCE_MS);
  });

  it("REJECTS a narrow-band sweep — the defect that invalidated baseline 3", () => {
    // Every sample clustered near one latency: the sample set a random-jitter
    // harness produced for reference-25 (120 ms of a 2000 ms interval). Which guard
    // fires first depends on the shape — the declared design is contradicted either
    // because the phase was not driven or because the spread is too small — but it
    // is always REJECTED.
    const narrow = goodSweep().map((sample) => ({ ...sample, observedLatencyMs: 800 + (sample.sampleIndex % 5) }));
    expect(() => assertPollPhaseSweep(narrow, INTERVAL)).toThrow(
      /narrow band|phase response|not controlled/
    );
  });

  it("REJECTS a sweep that does not show a phase response", () => {
    const flat = goodSweep(INTERVAL, 0).map((sample) => ({ ...sample, observedLatencyMs: 900 }));
    expect(() => assertPollPhaseSweep(flat, INTERVAL)).toThrow(
      /narrow band|phase response|not controlled/
    );
  });

  it("REJECTS a missing or thin declared phase", () => {
    // One run is not a sweep: every declared phase would have a single sample.
    const singleRun = goodSweep().filter((sample) => sample.runIndex === 0);
    expect(() => assertPollPhaseSweep(singleRun, INTERVAL)).toThrow(/declared phase|thin/);
    // A run that lost a phase fails structurally rather than silently reindexing.
    const gap = goodSweep().filter((sample) => !(sample.runIndex === 0 && sample.sampleIndex === 3));
    expect(() => assertPollPhaseSweep(gap, INTERVAL)).toThrow(/declared phase/);
  });

  it("REJECTS a publication phase that was not controlled", () => {
    const uncontrolled = goodSweep().map((sample) =>
      sample.sampleIndex === 7
        ? { ...sample, observedLatencyMs: sample.intendedLatencyMs + 300, phaseErrorMs: 300 }
        : sample
    );
    expect(() => assertPollPhaseSweep(uncontrolled, INTERVAL)).toThrow(/not controlled/);
  });

  it("REJECTS an observation that did not travel the real API poller path", () => {
    const shortcut = goodSweep().map((sample) =>
      sample.sampleIndex === 2
        ? { ...sample, observedVia: "document-title-poll" }
        : sample
    );
    expect(() => assertPollPhaseSweep(shortcut, INTERVAL)).toThrow(/real API poller path/);
  });

  it("REJECTS a sample that observed no new revision", () => {
    const idle = goodSweep().map((sample) =>
      sample.sampleIndex === 5 ? { ...sample, observedRevision: sample.previousRevision } : sample
    );
    expect(() => assertPollPhaseSweep(idle, INTERVAL)).toThrow(/not a publication observation/);
  });

  it("REJECTS a publication that does not correspond to the controlled trigger", () => {
    const unrelated = goodSweep().map((sample) =>
      sample.sampleIndex === 1
        ? { ...sample, observedPublicationAtMs: sample.predictedPublicationAtMs - INTERVAL }
        : sample
    );
    expect(() => assertPollPhaseSweep(unrelated, INTERVAL)).toThrow(/controlled trigger/);
  });

  it("REJECTS a declared phase that is not on the declared grid", () => {
    const offGrid = goodSweep().map((sample) =>
      sample.sampleIndex === 4 ? { ...sample, declaredPhaseMs: 12.5 } : sample
    );
    expect(() => assertPollPhaseSweep(offGrid, INTERVAL)).toThrow(/declared grid|design requires/);
  });
});

describe("stage-5 phase-normalized summary", () => {
  it("reports a median per declared phase and normalises over the uniform grid", () => {
    const grid = pollPhaseGridMs(INTERVAL);
    const runs = [10, 20, 30].map((offset) =>
      grid.map((phase) => intendedLatencyMs(phase, INTERVAL) + offset)
    );
    const medians = phaseMediansMs(runs, INTERVAL);
    expect(medians).toHaveLength(POLL_PHASE_DIVISIONS);
    // Each phase's median is its 20 ms sample, and the phases are ordered by
    // intended latency: the earliest declared phase is the SLOWEST.
    expect(medians[0]).toBeGreaterThan(medians[medians.length - 1]!);
    const normalized = phaseNormalizedP95Ms(runs, INTERVAL);
    // Nearest-rank p95 over 15 phase medians is the largest phase median, so the
    // normalized figure equals the slowest declared phase's median.
    expect(normalized).toBe(Math.max(...medians));
    expect(normalized).toBe(medians[0]);
  });
});
