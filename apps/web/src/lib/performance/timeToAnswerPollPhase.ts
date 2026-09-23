/**
 * Stage-5 poll-phase design (#335, methodology revision 2).
 *
 * Stage 5 measures: authoritative daemon publication -> the Node/SSE layer
 * observes that revision, through the CURRENT production polling mechanism
 * (a fixed `DOCKERMAP_SSE_INTERVAL_MS` poller; 2000 ms today).
 *
 * The mechanism's latency is a sawtooth in the phase of the publication within a
 * poll interval, so a capture that lets the phase fall where it likes cannot
 * characterise it: baseline 3's reference-25 samples occupied a 120 ms band
 * (6.0 % of the interval) even though the harness slept a uniform sub-interval
 * delay before each trigger, because both the daemon's refresh loop and the
 * API's poller are fixed 2 s loops and the measured gap was their phase offset.
 *
 * This module therefore declares an EXPLICIT deterministic phase sweep instead
 * of an assumed uniform random distribution:
 *
 * - the poll interval is divided into `POLL_PHASE_DIVISIONS` equal parts, giving
 *   one declared phase per recorded sample per run (15 phases, 15 samples);
 * - phase `p` places the publication at `(p + 0.5) * interval / divisions`, so the
 *   intended latency is `interval - that offset`: the sweep covers the interval
 *   from half a division to `divisions - 0.5` divisions, and no phase sits on a
 *   poll tick boundary, where a publication would be inherently ambiguous;
 * - each controlled run sweeps the phases in ascending order, so each phase has
 *   exactly `TIME_TO_ANSWER_CONTROLLED_RUNS` samples per cell and the phase of
 *   every raw sample is recoverable from its position in the run;
 * - the phase is DRIVEN, not hoped for: the harness connects its observation
 *   stream at a computed instant so that the next poll tick after the predicted
 *   publication falls at the intended latency, then verifies the result.
 *
 * The summary derived from this design is a PHASE-NORMALIZED figure: it weights
 * the declared phases uniformly to characterise the latency imposed by the fixed
 * polling mechanism. It is not an observed user-traffic distribution and not
 * network latency.
 */

/** Equal parts the poll interval is divided into; one declared phase per sample per run. */
/**
 * Declared divisions of the poll interval. Ten gives a 200 ms grid step, which is
 * what the mechanism allows: the observation tick is a Node timer that drifts under
 * load (measured +52 ms at 250 containers), so the step must exceed the achievable
 * control precision by a margin or neighbouring phases blur together. Ten divisions
 * still sweep 90% of the interval (latencies 100–1900 ms).
 */
export const POLL_PHASE_DIVISIONS = 10;

/**
 * How far an observed sample may sit from its declared phase before the cell is
 * invalid. The grid spacing is `interval / divisions` (133.3 ms at 2000 ms), so
 * the tolerance keeps adjacent phases distinguishable while absorbing the few
 * milliseconds of publication-grid drift and detection delay.
 */
/**
 * Declared control tolerance: how far the observed latency may sit from the intended
 * one before a controlled sample is rejected as uncontrolled. Half the grid step
 * (100 ms) is the mathematical limit — anything larger could bucket into a
 * neighbouring phase — and 90 ms leaves room for the poll timer's real drift.
 */
export const POLL_PHASE_CONTROL_TOLERANCE_MS = 90;

/**
 * The observed sweep must span at least this share of the poll interval, and the
 * smallest publication offset must be at least this much slower than the largest
 * one. A sweep confined to a narrow band cannot satisfy either, which is exactly
 * the defect that invalidated baseline 3's reference cells.
 */
export const POLL_PHASE_MIN_SPAN_SHARE = 0.5;
export const POLL_PHASE_MIN_DIRECTION_SHARE = 0.5;

/** Every declared phase must appear at least this many times in a controlled cell. */
export const POLL_PHASE_MIN_SAMPLES_PER_PHASE = 2;

/**
 * Cells whose publication the harness can actually trigger, and which therefore get
 * the declared phase sweep.
 *
 * The two provider-state fixtures are NOT here on purpose. Their revisions advance
 * from the daemon's own host provider collection — the harness has no input that
 * makes the daemon publish at a chosen instant — so their stage-5 samples are
 * FREE-RUNNING: the phase each sample achieved is recorded, the sweep's coverage and
 * direction guards do not apply, and no phase-normalized figure is derived for them.
 * They still measure today's real poll wait, and they are still declared in the
 * matrix; what they cannot do is place the publication.
 */
export const POLL_PHASE_CONTROLLED_FIXTURES = [
  "reference-25",
  "reference-100",
  "reference-250",
  "docker-topology-change"
] as const;

export function isPhaseControlledFixture(fixture: string): boolean {
  return (POLL_PHASE_CONTROLLED_FIXTURES as readonly string[]).includes(fixture);
}

export interface PollPhaseSweep {
  runIndex: number;
  sampleIndex: number;
  /** Declared publication offset after the enclosing poll tick. */
  declaredPhaseMs: number;
  /** Latency the declared phase should produce. */
  intendedLatencyMs: number;
  /** When the harness connected its observation stream, relative to the run clock. */
  connectedAtMs: number;
  /** Predicted publication instant for this sample, relative to the run clock. */
  predictedPublicationAtMs: number;
  /** Observed publication instant, relative to the run clock. */
  observedPublicationAtMs: number;
  /** Observed poll tick that carried the revision, relative to the run clock. */
  observedObservationAtMs: number;
  observedLatencyMs: number;
  /** The declared phase whose intended latency is nearest to the observed latency. */
  observedPhaseBucketMs: number;
  /** Observed minus intended latency. */
  phaseErrorMs: number;
  /** How the observation reached the harness. Only the real poller path is valid. */
  observedVia: string;
  /** The revision observed, and the revision that was current before the sample. */
  observedRevision: string;
  previousRevision: string;
  /**
   * Whether the harness drove this sample's publication phase. Free-running cells
   * (the provider-state fixtures) record the phase they achieved instead, and are
   * excluded from the sweep's coverage and direction guards.
   */
  phaseControlled: boolean;
}

export interface PollPhaseValidity {
  divisions: number;
  intervalMs: number;
  samples: number;
  declaredPhasesMs: readonly number[];
  observedPhasesMs: readonly number[];
  minObservedLatencyMs: number;
  maxObservedLatencyMs: number;
  spanMs: number;
  spanShare: number;
  slowestPhaseMedianMs: number;
  fastestPhaseMedianMs: number;
  directionShare: number;
  worstPhaseErrorMs: number;
  samplesPerPhase: readonly number[];
}

function assertInterval(intervalMs: number): void {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("the poll interval must be a finite positive number of milliseconds");
  }
}

/**
 * Declared publication offsets within the poll interval, ascending.
 *
 * Phase `p` places the publication at `(p + 0.5) * interval / divisions`, so every
 * declared phase sits at the CENTRE of its division: never on a poll tick boundary
 * (where a publication is inherently ambiguous) and never at the very end of the
 * interval.
 */
export function pollPhaseGridMs(intervalMs: number): number[] {
  assertInterval(intervalMs);
  const step = intervalMs / POLL_PHASE_DIVISIONS;
  return Array.from({ length: POLL_PHASE_DIVISIONS }, (_, index) => (index + 0.5) * step);
}

/** Declared latency for a publication offset: the wait until the next poll tick. */
export function intendedLatencyMs(phaseMs: number, intervalMs: number): number {
  assertInterval(intervalMs);
  if (!Number.isFinite(phaseMs) || phaseMs <= 0 || phaseMs >= intervalMs) {
    throw new Error("a declared phase must sit strictly inside the poll interval");
  }
  return intervalMs - phaseMs;
}

/** The declared phase for a sample: run `r` sweeps the grid ascending from index 0. */
export function declaredPhaseIndexForSample(_runIndex: number, sampleIndex: number): number {
  if (!Number.isInteger(sampleIndex) || sampleIndex < 0) {
    throw new Error("a stage-5 sample index must be a non-negative integer");
  }
  // Fifteen recorded samples against ten declared divisions: each run walks the whole
  // grid and then repeats its first five phases, so across the three controlled runs
  // every declared phase carries at least three samples.
  return sampleIndex % POLL_PHASE_DIVISIONS;
}

/** The declared phase a raw sample must have produced, from its position in its run. */
export function declaredPhaseForSample(runIndex: number, sampleIndex: number, intervalMs: number): number {
  return pollPhaseGridMs(intervalMs)[declaredPhaseIndexForSample(runIndex, sampleIndex)]!;
}

/** Nearest declared latency for an observed latency: the observed phase bucket. */
export function observedPhaseBucketMs(observedLatencyMs: number, intervalMs: number): number {
  const grid = pollPhaseGridMs(intervalMs).map((phase) => intendedLatencyMs(phase, intervalMs));
  let best = grid[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of grid) {
    const distance = Math.abs(candidate - observedLatencyMs);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

/**
 * Nearest-rank p95 over the declared-phase medians: the phase-normalized figure.
 * Each declared phase is weighted equally, which is a statement about the
 * MECHANISM under uniformly sampled phase offsets — never about observed
 * user-traffic distribution, and never about network distance.
 */
export function phaseNormalizedP95Ms(runs: readonly (readonly number[])[], intervalMs: number): number {
  const perPhaseMedians = phaseMediansMs(runs, intervalMs);
  const ordered = [...perPhaseMedians].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1]!;
}

/** Median observed latency per declared phase, ascending by phase. */
export function phaseMediansMs(runs: readonly (readonly number[])[], intervalMs: number): number[] {
 const grid = pollPhaseGridMs(intervalMs);
 return grid.map((_phase, phaseIndex) => {
 const samples = runs.flatMap((run, runIndex) =>
 run.filter(
 (value, sampleIndex): value is number =>
 declaredPhaseIndexForSample(runIndex, sampleIndex) === phaseIndex &&
 typeof value === "number" &&
 Number.isFinite(value)
 )
 );
    if (samples.length === 0) {
      throw new Error(`no samples exist for declared phase ${phaseIndex + 1}/${POLL_PHASE_DIVISIONS}`);
    }
    return median(samples);
  });
}

/**
 * Enforce the declared experimental design on one stage-5 cell. Throws when the
 * sweep does not cover the interval, when a declared phase is missing, when the
 * phase was not actually driven to its declared offset, when an observation did
 * not arrive through the real API poller path, or when the observed spread is
 * too narrow to characterise a sawtooth whose range is one poll interval.
 */
export function assertPollPhaseSweep(
  samples: readonly PollPhaseSweep[],
  intervalMs: number,
  minSamplesPerPhase = POLL_PHASE_MIN_SAMPLES_PER_PHASE
): PollPhaseValidity {
  assertInterval(intervalMs);
  if (samples.length === 0) throw new Error("the stage-5 phase sweep has no samples");
  const grid = pollPhaseGridMs(intervalMs);

  const declaredPhasesMs: number[] = [];
  const observedPhasesMs: number[] = [];
  const samplesPerPhase = grid.map(() => 0);
  let worstPhaseErrorMs = 0;
  let minObservedLatencyMs = Number.POSITIVE_INFINITY;
  let maxObservedLatencyMs = Number.NEGATIVE_INFINITY;

  for (const sample of samples) {
    if (!Number.isFinite(sample.observedLatencyMs) || sample.observedLatencyMs < 0) {
      throw new Error("a stage-5 sample has a non-finite observed latency");
    }
    if (!sample.phaseControlled) {
      throw new Error(
        "the declared phase sweep was applied to a sample the harness did not drive; " +
          "free-running cells use the free-running guard instead"
      );
    }
    if (sample.observedVia !== "api-sse") {
      throw new Error(
        `a stage-5 sample was observed via ${sample.observedVia} instead of the real API poller path`
      );
    }
    if (!sample.observedRevision || sample.observedRevision === sample.previousRevision) {
      throw new Error("a stage-5 sample did not observe a new revision, so it is not a publication observation");
    }
    if (sample.observedPublicationAtMs < sample.predictedPublicationAtMs - intervalMs / 2) {
      throw new Error("a stage-5 sample's observed publication does not correspond to the controlled trigger");
    }
    const expectedPhase = declaredPhaseForSample(sample.runIndex, sample.sampleIndex, intervalMs);
    if (Math.abs(expectedPhase - sample.declaredPhaseMs) > 1e-6) {
      throw new Error(
        `stage-5 sample ${sample.sampleIndex} of run ${sample.runIndex} declares phase ${sample.declaredPhaseMs} ` +
          `but the design requires ${expectedPhase}`
      );
    }
    const phaseErrorMs = sample.observedLatencyMs - sample.intendedLatencyMs;
    worstPhaseErrorMs = Math.max(worstPhaseErrorMs, Math.abs(phaseErrorMs));
    if (Math.abs(phaseErrorMs) > POLL_PHASE_CONTROL_TOLERANCE_MS) {
      throw new Error(
        `stage-5 phase ${sample.declaredPhaseMs.toFixed(1)} ms produced ${sample.observedLatencyMs.toFixed(1)} ms ` +
          `instead of ${sample.intendedLatencyMs.toFixed(1)} ms (error ${phaseErrorMs.toFixed(1)} ms exceeds the ` +
          `${POLL_PHASE_CONTROL_TOLERANCE_MS} ms tolerance): the publication phase was not controlled`
      );
    }
    const bucket = observedPhaseBucketMs(sample.observedLatencyMs, intervalMs);
    const declaredPhaseIndex = declaredPhaseIndexOfValue(sample.declaredPhaseMs, grid);
    if (declaredPhaseIndex < 0) {
      throw new Error(`stage-5 declared phase ${sample.declaredPhaseMs} is not on the declared grid`);
    }
    declaredPhasesMs.push(sample.declaredPhaseMs);
    observedPhasesMs.push(bucket);
    samplesPerPhase[declaredPhaseIndex] = (samplesPerPhase[declaredPhaseIndex] ?? 0) + 1;
    minObservedLatencyMs = Math.min(minObservedLatencyMs, sample.observedLatencyMs);
    maxObservedLatencyMs = Math.max(maxObservedLatencyMs, sample.observedLatencyMs);
  }

  const sparse = samplesPerPhase
    .map((count, index) => ({ count, index }))
    .filter((entry) => entry.count < minSamplesPerPhase);
  if (sparse.length > 0) {
    throw new Error(
      `the stage-5 sweep must cover every declared phase at least ${minSamplesPerPhase} times; ` +
        `missing or thin phases: ${sparse.map((entry) => entry.index + 1).join(", ")}`
    );
  }

  const spanMs = maxObservedLatencyMs - minObservedLatencyMs;
  const spanShare = spanMs / intervalMs;
  if (spanShare < POLL_PHASE_MIN_SPAN_SHARE) {
    throw new Error(
      `the stage-5 sweep spans only ${spanMs.toFixed(1)} ms (${(spanShare * 100).toFixed(1)} % of the ` +
        `${intervalMs} ms interval): a narrow band cannot characterise the polling mechanism's phase response`
    );
  }

  const perPhase = phaseMediansMs(
    groupRunsByPhase(samples, intervalMs),
    intervalMs
  );
  const slowestPhaseMedianMs = perPhase[0]!;
  const fastestPhaseMedianMs = perPhase[perPhase.length - 1]!;
  const directionShare = (slowestPhaseMedianMs - fastestPhaseMedianMs) / intervalMs;
  if (directionShare < POLL_PHASE_MIN_DIRECTION_SHARE) {
    throw new Error(
      `the stage-5 sweep does not show a phase response: the earliest declared phase median ` +
        `(${slowestPhaseMedianMs.toFixed(1)} ms) is only ${(directionShare * 100).toFixed(1)} % of an interval ` +
        `above the latest (${fastestPhaseMedianMs.toFixed(1)} ms)`
    );
  }

  return {
    divisions: POLL_PHASE_DIVISIONS,
    intervalMs,
    samples: samples.length,
    declaredPhasesMs,
    observedPhasesMs,
    minObservedLatencyMs,
    maxObservedLatencyMs,
    spanMs,
    spanShare,
    slowestPhaseMedianMs,
    fastestPhaseMedianMs,
    directionShare,
    worstPhaseErrorMs,
    samplesPerPhase
  };
}

function declaredPhaseIndexOfValue(phaseMs: number, grid: readonly number[]): number {
  return grid.findIndex((candidate) => Math.abs(candidate - phaseMs) < 1e-6);
}

export interface FreeRunningPhaseValidity {
  samples: number;
  minObservedLatencyMs: number;
  maxObservedLatencyMs: number;
  spanMs: number;
  observedPhaseBucketsMs: readonly number[];
}

/**
 * Guard for FREE-RUNNING stage-5 cells — the provider-state fixtures, whose
 * publications the harness cannot place. Coverage and direction are NOT required
 * (the design does not claim to control the phase there), but the sample must still
 * be a real observation: a new revision, seen through the real API poller path, with
 * the phase it achieved recorded. A cell that recorded no usable samples, or that
 * saw a non-poller observation, is rejected.
 */
export function assertFreeRunningPhaseSamples(
  samples: readonly PollPhaseSweep[],
  minimumSamples = 10
): FreeRunningPhaseValidity {
  if (samples.length < minimumSamples) {
    throw new Error(
      `a free-running stage-5 cell needs at least ${minimumSamples} samples, got ${samples.length}`
    );
  }
  let minObservedLatencyMs = Number.POSITIVE_INFINITY;
  let maxObservedLatencyMs = Number.NEGATIVE_INFINITY;
  const observedPhaseBucketsMs: number[] = [];
  for (const sample of samples) {
    if (sample.phaseControlled) {
      throw new Error("a free-running cell must not contain phase-controlled samples");
    }
    if (sample.observedVia !== "api-sse") {
      throw new Error("a free-running stage-5 sample did not arrive through the real API poller path");
    }
    if (!sample.observedRevision || sample.observedRevision === sample.previousRevision) {
      throw new Error("a free-running stage-5 sample observed no new revision");
    }
    if (!Number.isFinite(sample.observedLatencyMs) || sample.observedLatencyMs < 0) {
      throw new Error("a free-running stage-5 sample has a non-finite observed latency");
    }
    observedPhaseBucketsMs.push(sample.observedPhaseBucketMs);
    minObservedLatencyMs = Math.min(minObservedLatencyMs, sample.observedLatencyMs);
    maxObservedLatencyMs = Math.max(maxObservedLatencyMs, sample.observedLatencyMs);
  }
  return {
    samples: samples.length,
    minObservedLatencyMs,
    maxObservedLatencyMs,
    spanMs: maxObservedLatencyMs - minObservedLatencyMs,
    observedPhaseBucketsMs
  };
}

/** Rebuild per-run sample arrays from sweep records, so the shared math can be reused. */
function groupRunsByPhase(samples: readonly PollPhaseSweep[], intervalMs: number): number[][] {
 const runIndexes = [...new Set(samples.map((sample) => sample.runIndex))].sort((left, right) => left - right);
 return runIndexes.map((runIndex) => {
 const run = samples
 .filter((sample) => sample.runIndex === runIndex)
 .sort((left, right) => left.sampleIndex - right.sampleIndex);
 const values: number[] = [];
 for (const sample of run) {
 if (sample.sampleIndex !== values.length) {
 throw new Error(`run ${runIndex} has a missing or duplicate declared phase sample index`);
 }
 // The sample's own recorded phase decides its slot, so the shared math cannot
 // silently disagree with the declaration the capture used.
 if (Math.abs(sample.declaredPhaseMs - declaredPhaseForSample(runIndex, sample.sampleIndex, intervalMs)) >= 1e-6) {
 throw new Error(`run ${runIndex} has an incorrectly declared stage-5 phase`);
 }
 values.push(sample.observedLatencyMs);
 }
 return values;
 });
}
