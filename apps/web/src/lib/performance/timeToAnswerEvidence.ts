import { phaseMediansMs, phaseNormalizedP95Ms } from "./timeToAnswerPollPhase";

/**
 * DockerMap time-to-answer performance contract (#335).
 *
 * This module is the CLOSED schema and math for the controlled
 * time-to-answer benchmark. It deliberately contains no timings and performs
 * no measurement: the benchmark job runs on a pinned runner, writes a JSON
 * artifact that stores RAW samples only, and this contract validates that
 * artifact and derives every summary during review.
 *
 * Ordinary unit tests exercise this file's shape/math only. They must never
 * compare elapsed time, be used as a performance gate, or be treated as
 * evidence that DockerMap is fast.
 */

/**
 * Closed list of the stages the benchmark measures, in the order the operator
 * path experiences them. `measures` is the number's meaning; `doesNotProve`
 * is the part a reader must not infer from it.
 */
export const TIME_TO_ANSWER_STAGES = [
  {
    id: "daemonStartToListenerMs",
    bucket: "backend-collection",
    measures: "Daemon process start until its HTTP listener accepts a request.",
    doesNotProve:
      "Nothing about collection. A fast listener with a slow first answer is still a slow product.",
    fixtures: ["reference-25", "reference-100", "reference-250"]
  },
  {
    id: "listenerToFirstDockerModelMs",
    bucket: "backend-collection",
    measures:
      "Listener readiness until the first authoritative Docker model is observable to a reader.",
    doesNotProve:
      "Does not include anything the browser does, and does not prove the model is complete: optional provider evidence may still be absent.",
    fixtures: ["reference-25", "reference-100", "reference-250"]
  },
  {
    id: "dockerObservationMs",
    bucket: "backend-collection",
    measures: "One Docker inventory observation pass against the pinned fixture host.",
    doesNotProve:
      "Not a claim about a real Docker daemon's latency, host load, or image size; the fixture daemon is deterministic and local.",
    fixtures: ["reference-25", "reference-100", "reference-250"]
  },
  {
    id: "composeEnrichmentMs",
    bucket: "backend-collection",
    measures: "Compose filesystem correlation for one publication, timed separately from the Docker observation.",
    doesNotProve:
      "Not a claim about a real Compose project tree; and while the stages are still coupled this number is measured, not removed (see #336).",
    fixtures: ["reference-25", "reference-100", "reference-250", "slow-bounded-compose-projection"]
  },
  {
    id: "publicationToNodeObservationMs",
    bucket: "transport-notification",
    measures:
      "Daemon publication until the Node/SSE layer observes that revision through TODAY'S real polling mechanism, poll wait included. The publication phase within the poll interval is DRIVEN, not hoped for: each recorded sample is assigned a declared phase on an explicit grid spanning the interval, the harness places the publication at that phase relative to its observation stream's poll ticks, and the observed phase is verified against the declared one before the sample is accepted.",
    doesNotProve:
      "Not browser work, not render, and not a claim about network distance to a remote operator. It is a phase response, not an observed user-traffic distribution: the reported phase-normalized summary weights the declared phases uniformly to characterise the latency the fixed polling mechanism imposes, and it does NOT claim that real host publications occur uniformly across poll phase.",
    fixtures: [
      "reference-25",
      "reference-100",
      "reference-250",
      "provider-only-revision-change",
      "docker-topology-change",
      "unavailable-optional-provider"
    ]
  },
  {
    id: "notificationToCoherentModelMs",
    bucket: "browser-model",
    measures:
      "Browser notification until the REAL application seam accepts one coherent model: the instant the fetched snapshot/runtime pair becomes the model the UI renders. It is observed at the application's own acceptance point, never derived from a DOM mutation.",
    doesNotProve:
      "Not a health judgement and not a statement that every evidence domain is current: it ends when a coherent model is accepted, not when the model is complete. It contains no rendering and says nothing about whether the operator saw anything.",
    fixtures: [
      "reference-25",
      "reference-100",
      "reference-250",
      "provider-only-revision-change",
      "docker-topology-change",
      "unavailable-optional-provider"
    ]
  },
  {
    id: "coherentModelToUsefulRenderMs",
    bucket: "rendering",
    measures:
      "From coherent-model acceptance until the accepted model's expected Home content is present — in a commit the application stamped with that accepted revision — followed by a bounded render/presentation confirmation (the probe observes the commit from an animation-frame loop and then awaits a bounded frame after it), and no sleeps. It shares no clock with the stage before it.",
    doesNotProve:
      "Not a visual-quality or accessibility claim, and not a claim that the operator found the answer. It is declared only for fixtures whose published change demonstrably repaints the Home content region; a provider-only or provider-unavailable revision is not guaranteed to repaint it, so measuring it there would be an empty number.",
    fixtures: ["reference-25", "reference-100", "reference-250", "docker-topology-change"]
  },
  {
    id: "buildModelMs",
    bucket: "browser-model",
    measures: "One `buildModel()` composition for the fixture model.",
    doesNotProve: "Nothing about rendering, network, or findings derivation.",
    fixtures: ["reference-25", "reference-100", "reference-250"]
  },
  {
    id: "findingsDerivationMs",
    bucket: "backend-collection",
    measures:
      "Findings derivation for the fixture's representative topology and evidence sizes. This runs in the daemon during publication, not in the browser.",
    doesNotProve:
      "Not a rule-quality claim, and it says nothing about a host with conditions the fixture does not contain. The fixture topology derives no findings, so this measures the empty-derivation path at its resolution floor.",
    fixtures: ["reference-25", "reference-100", "reference-250"]
  },
  {
    id: "legacyTopologyLayoutMs",
    bucket: "rendering",
    measures: "The legacy Home topology layout (force-layout preview) for the fixture model.",
    doesNotProve:
      "Not a claim about Atlas, and it does not by itself justify removing the preview; #338 decides that from this evidence.",
    fixtures: ["reference-25", "reference-100", "reference-250"]
  },
  {
    id: "commandQueryMs",
    bucket: "search",
    measures: "Cmd-K open plus query-to-results for the fixture's representative query classes.",
    doesNotProve:
      "Not a claim about answer quality, and the query set is a fixed representative sample, not operator behaviour.",
    fixtures: ["reference-25", "reference-100", "reference-250"]
  },
  {
    id: "productionBundleMs",
    bucket: "rendering",
    measures: "Production bundle/loading cost for the pinned production build.",
    doesNotProve:
      "Not a transfer-time claim for a real network; it is measured against the pinned local build and recorded in the pinned environment.",
    fixtures: ["reference-25", "reference-100", "reference-250"]
  }
] as const;

export type TimeToAnswerStage = (typeof TIME_TO_ANSWER_STAGES)[number];
export type TimeToAnswerStageId = TimeToAnswerStage["id"];
export type TimeToAnswerBucket = TimeToAnswerStage["bucket"];
export type TimeToAnswerFixture = TimeToAnswerStage["fixtures"][number];

export const TIME_TO_ANSWER_BASELINE = "dockermap-v1/time-to-answer-baseline-4";
export const TIME_TO_ANSWER_WARMED_SAMPLES = 15;
export const TIME_TO_ANSWER_CONTROLLED_RUNS = 3;

/**
 * The measurement design this contract describes. The baseline id names the
 * CLOSED ARTIFACT SHAPE; the methodology version names HOW the numbers are
 * produced — stage-5 deterministic phase control, the fixed warm-up policy, the
 * stationarity guard, and the provenance/compatibility split. A candidate may
 * only be compared against a baseline captured under the same methodology
 * version, because a different design produces a different number for the same
 * product.
 */
export const TIME_TO_ANSWER_METHODOLOGY = "dockermap-v1/time-to-answer-methodology-5";

/**
 * Fixed, predeclared warm-up observations per warmed daemon cell per run.
 *
 * This is a conservative protocol revision after the fixed-five protocol proved
 * marginal at its stationarity gate. Ten is fixed before capture and is never
 * adjusted afterwards to make data look stationary; historical artifacts do not
 * retain enough warm-up evidence to claim that ten was statistically derived
 * from Baseline 3.
 */
/**
 * Calibration is a separate, retained evidence exercise.  Its constants are
 * declared here (rather than in the runner) so a command cannot quietly tune
 * them after it has seen an observation.
 */
export const TIME_TO_ANSWER_CALIBRATION_OBSERVATIONS = 30;
export const TIME_TO_ANSWER_WARM_UP_SAFETY_MARGIN = 2;

/**
 * Declared stationarity band: the median of the final two warm-up observations
 * against the median of the measured window. This validity check is unchanged
 * by the fixed-ten protocol revision.
 */
export const TIME_TO_ANSWER_STATIONARITY_MIN_RATIO = 0.5;
export const TIME_TO_ANSWER_STATIONARITY_MAX_RATIO = 1.5;

/**
 * Metric-level warm-up counts produced by the methodology-5 calibration.
 * This starts empty deliberately: Baseline-4 capture is forbidden until the
 * separately retained calibration artifact has supplied every warmed metric.
 * Do not replace a missing key with a global fallback.
 */
export const TIME_TO_ANSWER_FROZEN_WARM_UP_COUNTS: Readonly<Record<string, number>> = Object.freeze({});

/** Reference fixtures (25/100/250 containers) plus the four scenario fixtures. */
export const TIME_TO_ANSWER_REFERENCE_FIXTURES = [
  { name: "reference-25", containers: 25, kind: "reference" },
  { name: "reference-100", containers: 100, kind: "reference" },
  { name: "reference-250", containers: 250, kind: "reference" },
  { name: "provider-only-revision-change", containers: 100, kind: "scenario" },
  { name: "docker-topology-change", containers: 100, kind: "scenario" },
  { name: "slow-bounded-compose-projection", containers: 100, kind: "scenario" },
  { name: "unavailable-optional-provider", containers: 100, kind: "scenario" }
] as const;

/** The closed fixture × stage matrix, derived from each stage's fixture list. */
export const TIME_TO_ANSWER_MATRIX = TIME_TO_ANSWER_STAGES.flatMap((stage) =>
  stage.fixtures.map((fixture) => ({ fixture, stage: stage.id as TimeToAnswerStageId }))
);

/**
 * Every pinned dimension of a controlled run. A missing field, or a candidate
 * whose pinned environment differs from the baseline, invalidates the record;
 * it never justifies retrying until a preferred duration appears.
 */
export type TimeToAnswerEnvironment = {
  runnerClass: string;
  cpuClass: string;
  osImage: string;
  osKernel: string;
  nodeRevision: string;
  rustRevision: string;
  dockerRevision: string;
  /**
   * The effective `DOCKERMAP_SSE_INTERVAL_MS` the API ran with. Stage 5
   * measures today's real publication-observation mechanism, poll wait
   * included, so the interval is part of the pinned environment: a candidate
   * that changed it has not been measured against the same mechanism.
   */
  ssePollIntervalMs: string;
  /**
   * The revision of the benchmark harness itself (latest commit touching
   * `tests/perf` and the performance contract). A baseline is only reproducible
   * if both the product and the harness that measured it are identified: a
   * number produced by an uncommitted harness cannot be re-derived by anyone.
   */
  /** sha256 of the exact release daemon executable this capture ran. */
  daemonBinarySha256: string;
  /** The command and profile that produced that binary. */
  daemonBinaryBuild: string;
  cargoRevision: string;
  harnessRevision: string;
  browserEngine: "chromium";
  browserRevision: string;
  browserFlags: readonly string[];
  fontEnvironment: string;
  buildMode: "production";
  fixtureRevision: string;
  sourceRevision: string;
  /** The measurement design (see TIME_TO_ANSWER_METHODOLOGY). Required to match. */
  methodologyVersion: string;
};

export interface TimeToAnswerRecord {
fixture: string;
stage: TimeToAnswerStageId;
/** Stage 5 is captured only by the controlled sub-benchmark. */
measurementProtocol: "controlled-poll-phase" | "end-to-end";
/** Raw evidence section that produced this one cell. */
sourceEvidenceFile: string;
/** Committed source/harness checkpoint that produced this cell. */
checkpointSha: string;
/** Each inner array is one complete controlled run of warmed samples. */
runs: readonly (readonly number[])[];
}

export interface TimeToAnswerEvidence {
  baseline: typeof TIME_TO_ANSWER_BASELINE;
  environment: TimeToAnswerEnvironment;
  records: readonly TimeToAnswerRecord[];
}

export interface TimeToAnswerStageSummary {
 runP95Ms: readonly number[];
 medianOfThreeRunP95Ms: number;
 /** The authority used for review and promotion of this record. */
 reviewedMs: number;
 reviewedAggregation: "median-of-three-run-p95" | "phase-normalized-p95";
}

const environmentKeys = [
  "runnerClass",
  "cpuClass",
  "osImage",
  "osKernel",
  "nodeRevision",
  "rustRevision",
  "dockerRevision",
  "ssePollIntervalMs",
  "harnessRevision",
  "daemonBinarySha256",
  "daemonBinaryBuild",
  "cargoRevision",
  "browserEngine",
  "browserRevision",
  "browserFlags",
  "fontEnvironment",
  "buildMode",
  "fixtureRevision",
  "sourceRevision",
  "methodologyVersion"
] as const;
const evidenceKeys = ["baseline", "environment", "records"] as const;
const recordKeys = ["fixture", "stage", "measurementProtocol", "sourceEvidenceFile", "checkpointSha", "runs"] as const;
const safeValue = /^[A-Za-z0-9._/@:+=-]{1,160}$/;
const checkpointSha = /^[0-9a-f]{7,40}$/;
const stageIds = new Set<string>(TIME_TO_ANSWER_STAGES.map((stage) => stage.id));

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeString(value: unknown): value is string {
  return typeof value === "string" && safeValue.test(value);
}

/** Nearest-rank percentile: for 15 samples, p95 is the largest observed value. */
export function timeToAnswerP95(samples: readonly number[]): number {
  if (
    samples.length !== TIME_TO_ANSWER_WARMED_SAMPLES ||
    samples.some((sample) => typeof sample !== "number" || !Number.isFinite(sample) || sample < 0)
  ) {
    throw new Error(
      `Time-to-answer benchmark requires exactly ${TIME_TO_ANSWER_WARMED_SAMPLES} finite non-negative warmed samples.`
    );
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}

export function summarizeTimeToAnswerStage(
  runs: readonly (readonly number[])[]
): TimeToAnswerStageSummary {
  if (runs.length !== TIME_TO_ANSWER_CONTROLLED_RUNS) {
    throw new Error(
      `Time-to-answer benchmark requires exactly ${TIME_TO_ANSWER_CONTROLLED_RUNS} complete controlled runs.`
    );
  }
  const runP95Ms = runs.map(timeToAnswerP95);
  const ordered = [...runP95Ms].sort((left, right) => left - right);
 return {
 runP95Ms,
 medianOfThreeRunP95Ms: ordered[1]!,
 reviewedMs: ordered[1]!,
 reviewedAggregation: "median-of-three-run-p95"
 };
}

export function assertTimeToAnswerEnvironment(
  environment: unknown
): asserts environment is TimeToAnswerEnvironment {
  if (
    !isObject(environment) ||
    !hasExactKeys(environment, environmentKeys) ||
    environment.browserEngine !== "chromium" ||
    environment.buildMode !== "production" ||
    ![
      environment.runnerClass,
      environment.cpuClass,
      environment.osImage,
      environment.osKernel,
      environment.nodeRevision,
      environment.rustRevision,
      environment.dockerRevision,
      environment.ssePollIntervalMs,
      environment.harnessRevision,
      environment.daemonBinarySha256,
      environment.daemonBinaryBuild,
      environment.cargoRevision,
      environment.browserRevision,
      environment.fontEnvironment,
      environment.fixtureRevision,
      environment.sourceRevision,
      environment.methodologyVersion
    ].every(safeString) ||
    !Array.isArray(environment.browserFlags) ||
    environment.browserFlags.length === 0 ||
    environment.browserFlags.length > 16 ||
    !environment.browserFlags.every(safeString)
  ) {
    throw new Error(
      "Time-to-answer benchmark environment must use exactly the closed safe metadata fields for pinned runner/CPU/OS/kernel, Node/Rust/Docker revisions, Chromium revision and flags, fonts, production build, and fixture/source revision."
    );
  }
}

/**
 * Reject untrusted JSON before deriving summaries. The artifact stores raw
 * samples only; a supplied summary is not accepted as input.
 */
export function validateTimeToAnswerEvidence(value: unknown): TimeToAnswerEvidence {
  if (
    !isObject(value) ||
    !hasExactKeys(value, evidenceKeys) ||
    value.baseline !== TIME_TO_ANSWER_BASELINE ||
    !Array.isArray(value.records)
  ) {
    throw new Error("Time-to-answer evidence must use the closed baseline/environment/records schema.");
  }
  assertTimeToAnswerEnvironment(value.environment);
  const expected = new Set(TIME_TO_ANSWER_MATRIX.map(({ fixture, stage }) => `${fixture}\u0000${stage}`));
  if (value.records.length !== expected.size) {
    throw new Error("Time-to-answer evidence must contain the exact fixture × stage matrix.");
  }
  const records = value.records.map((raw) => {
    if (
!isObject(raw) ||
!hasExactKeys(raw, recordKeys) ||
typeof raw.fixture !== "string" ||
typeof raw.stage !== "string" ||
!stageIds.has(raw.stage) ||
typeof raw.measurementProtocol !== "string" ||
typeof raw.sourceEvidenceFile !== "string" ||
typeof raw.checkpointSha !== "string" ||
!Array.isArray(raw.runs)
    ) {
      throw new Error("Time-to-answer record has an unsafe or incomplete shape.");
    }
    const key = `${raw.fixture}\u0000${raw.stage}`;
if (!expected.delete(key)) {
throw new Error("Time-to-answer evidence has a duplicate or unsupported fixture/stage record.");
}
const requiredProtocol = raw.stage === "publicationToNodeObservationMs"
? "controlled-poll-phase"
: "end-to-end";
if (raw.measurementProtocol !== requiredProtocol) {
throw new Error(`Time-to-answer record ${raw.fixture}/${raw.stage} has the wrong measurement protocol.`);
}
if (!safeString(raw.sourceEvidenceFile) || !checkpointSha.test(raw.checkpointSha)) {
throw new Error("Time-to-answer record provenance must contain safe source evidence and checkpoint identifiers.");
}
    if (
      raw.runs.length !== TIME_TO_ANSWER_CONTROLLED_RUNS ||
      !raw.runs.every((run) => Array.isArray(run))
    ) {
      throw new Error("Time-to-answer evidence requires exactly three raw runs per stage.");
    }
    const runs = raw.runs.map((run) =>
      (run as unknown[]).map((sample) => {
        if (typeof sample !== "number") throw new Error("Time-to-answer samples must be numeric.");
        return sample;
      })
    );
    // Executes the finite/non-negative/sample-count checks so summaries cannot
    // be trusted input, and so a fabricated summary field cannot survive.
    summarizeTimeToAnswerStage(runs);
return {
fixture: raw.fixture,
stage: raw.stage as TimeToAnswerStageId,
measurementProtocol: raw.measurementProtocol as TimeToAnswerRecord["measurementProtocol"],
sourceEvidenceFile: raw.sourceEvidenceFile,
checkpointSha: raw.checkpointSha,
runs
};
  });
  if (expected.size !== 0) {
    throw new Error("Time-to-answer evidence is missing a required fixture/stage record.");
  }
  return { baseline: TIME_TO_ANSWER_BASELINE, environment: value.environment, records };
}

export function derivedTimeToAnswerSummaries(
 evidence: TimeToAnswerEvidence
): ReadonlyMap<string, TimeToAnswerStageSummary> {
 return new Map(
 evidence.records.map((record) => {
 const summary = summarizeTimeToAnswerStage(record.runs);
if (record.measurementProtocol === "controlled-poll-phase") {
 const normalized = derivedTimeToAnswerPhaseNormalized(record.runs, evidence.environment.ssePollIntervalMs);
 return [
 `${record.fixture}\u0000${record.stage}`,
 {
 ...summary,
 reviewedMs: normalized.phaseNormalizedP95Ms,
 reviewedAggregation: "phase-normalized-p95" as const
 }
 ];
 }
 return [`${record.fixture}\u0000${record.stage}`, summary];
 })
 );
}

/** Source revision deliberately differs between a baseline and its candidate. */
/**
 * What kind of measurement each stage is. The distinction is load-bearing, not
 * descriptive: a warmed stage is a repeated steady-state operation whose first
 * observation is a cold start, so that observation is recorded separately as
 * warm-up and never enters the summary. A cold-start stage is the opposite —
 * its first observation IS the measurement. Scenario-specific stages are only
 * declared for fixtures that deliberately construct the scenario.
 */
export const TIME_TO_ANSWER_STAGE_KIND: Record<string, "cold-start" | "warmed-repeated" | "scenario-specific"> = {
  daemonStartToListenerMs: "cold-start",
  listenerToFirstDockerModelMs: "cold-start",
  dockerObservationMs: "warmed-repeated",
  composeEnrichmentMs: "warmed-repeated",
  publicationToNodeObservationMs: "warmed-repeated",
  notificationToCoherentModelMs: "warmed-repeated",
  coherentModelToUsefulRenderMs: "warmed-repeated",
  buildModelMs: "warmed-repeated",
  findingsDerivationMs: "warmed-repeated",
  legacyTopologyLayoutMs: "warmed-repeated",
  commandQueryMs: "warmed-repeated",
  productionBundleMs: "warmed-repeated"
};

/** A stage measured on a scenario fixture is scenario-specific for that cell. */
export function isScenarioCell(fixture: string, stage: string): boolean {
  const declared = TIME_TO_ANSWER_REFERENCE_FIXTURES.find((entry) => entry.name === fixture);
  return declared?.kind === "scenario" && TIME_TO_ANSWER_STAGE_KIND[stage] === "warmed-repeated";
}

/** Return the pre-calibrated count for one metric, never a global default. */
export function frozenWarmUpCount(metric: string): number {
 const count = TIME_TO_ANSWER_FROZEN_WARM_UP_COUNTS[metric];
 if (!Number.isInteger(count) || count < 0) {
 throw new Error(`Baseline-4 cannot start: ${metric} has no frozen calibrated warm-up count`);
 }
 return count;
}

export type WarmUpCalibrationCell = {
 fixture: string;
 metric: string;
 observations: readonly number[];
};

export type WarmUpCalibrationDerivation = {
 metric: string;
 fixtureCounts: Readonly<Record<string, number>>;
 frozenWarmUpCount: number;
};

/**
 * The calibration population is closed independently of the baseline matrix:
 * only the three size reference fixtures determine a warmed metric's count.
 * Scenario cells are deliberately not a source of conditioning evidence.
 */
export const TIME_TO_ANSWER_CALIBRATION_REFERENCE_FIXTURES = TIME_TO_ANSWER_REFERENCE_FIXTURES
 .filter((fixture) => fixture.kind === "reference")
 .map((fixture) => fixture.name);

/** Every repeated end-to-end stage must be calibrated before baseline capture. */
export const TIME_TO_ANSWER_WARM_UP_METRICS = TIME_TO_ANSWER_STAGES
 .filter((stage) => TIME_TO_ANSWER_STAGE_KIND[stage.id] === "warmed-repeated")
 .map((stage) => stage.id);

/** Median used by the existing stationarity semantics. */
function median(values: readonly number[]): number {
 if (values.length === 0) return Number.NaN;
 const ordered = [...values].sort((left, right) => left - right);
 const middle = Math.floor(ordered.length / 2);
 return ordered.length % 2 === 0 ? (ordered[middle - 1]! + ordered[middle]!) / 2 : ordered[middle]!;
}

/**
 * Derive one metric's frozen count from its complete 30-observation reference
 * fixture cells. Candidate `w` compares obs[w-2:w] to obs[w:w+15]. The first
 * candidate whose ratio stays inside the declared band at every later eligible
 * position is selected for each fixture; the metric receives their maximum plus
 * the fixed safety margin. The margin itself must still be evidence-backed.
 */
export function deriveFrozenWarmUpCount(cells: readonly WarmUpCalibrationCell[]): WarmUpCalibrationDerivation {
 if (cells.length === 0) throw new Error("warm-up calibration needs at least one relevant reference fixture");
 const metric = cells[0]!.metric;
 if (cells.some((cell) => cell.metric !== metric)) throw new Error("warm-up calibration derives one metric at a time");
 if (!TIME_TO_ANSWER_WARM_UP_METRICS.includes(metric as TimeToAnswerStageId)) {
 throw new Error(`${metric} is not a warmed end-to-end metric`);
 }
 const expectedFixtures = new Set<string>(TIME_TO_ANSWER_CALIBRATION_REFERENCE_FIXTURES);
 if (cells.length !== expectedFixtures.size) {
 throw new Error(`${metric} calibration must retain every declared reference fixture`);
 }
 const fixtureCounts: Record<string, number> = {};
 const latestEligible = TIME_TO_ANSWER_CALIBRATION_OBSERVATIONS - TIME_TO_ANSWER_WARMED_SAMPLES;
 for (const cell of cells) {
 if (!cell.fixture || fixtureCounts[cell.fixture] !== undefined || !expectedFixtures.delete(cell.fixture)) {
 throw new Error("warm-up calibration fixtures must be the unique declared reference fixtures");
 }
 if (cell.observations.length !== TIME_TO_ANSWER_CALIBRATION_OBSERVATIONS || cell.observations.some((value) => !Number.isFinite(value) || value < 0)) {
 throw new Error(`${cell.fixture}/${metric} must retain exactly ${TIME_TO_ANSWER_CALIBRATION_OBSERVATIONS} finite non-negative calibration observations`);
 }
 const stableAt = (candidate: number) => {
 for (let position = candidate; position <= latestEligible; position += 1) {
 const ratio = median(cell.observations.slice(position - 2, position)) / median(cell.observations.slice(position, position + TIME_TO_ANSWER_WARMED_SAMPLES));
 if (!Number.isFinite(ratio) || ratio <= 0 || ratio < TIME_TO_ANSWER_STATIONARITY_MIN_RATIO || ratio > TIME_TO_ANSWER_STATIONARITY_MAX_RATIO) return false;
 }
 return true;
 };
 const earliest = Array.from({ length: latestEligible - 1 }, (_, index) => index + 2).find(stableAt);
 if (earliest === undefined) throw new Error(`${cell.fixture}/${metric} never reaches sustained stationarity in the retained calibration window`);
 fixtureCounts[cell.fixture] = earliest;
 }
 if (expectedFixtures.size !== 0) {
 throw new Error(`${metric} calibration is missing declared reference fixtures: ${[...expectedFixtures].join(", ")}`);
 }
 const frozenWarmUpCount = Math.max(...Object.values(fixtureCounts)) + TIME_TO_ANSWER_WARM_UP_SAFETY_MARGIN;
 if (frozenWarmUpCount > latestEligible) {
 throw new Error(`${metric} calibration conflict: safety margin ${TIME_TO_ANSWER_WARM_UP_SAFETY_MARGIN} moves warm-up count ${frozenWarmUpCount} beyond the evidence-backed 30-observation window`);
 }
 return { metric, fixtureCounts, frozenWarmUpCount };
}

/**
 * Split one warmed daemon measurement window into the discarded warm-up
 * observations and the recorded samples.
 *
 * The daemon's first-ever refresh runs before its listener binds, so its first
 * passes through the collection path are cold. The count is FIXED by protocol
 * (`TIME_TO_ANSWER_WARM_UP_OBSERVATIONS`), never chosen by looking at the data:
 * with 15 recorded samples, nearest-rank p95 is the maximum, so a surviving cold
 * observation would otherwise *become* the published number. Every warm-up
 * observation is returned for the raw audit trail, and none of them enters the
 * summary.
 */
export function splitWarmedObservations(
observations: readonly number[],
count = TIME_TO_ANSWER_WARMED_SAMPLES,
warmUpCount: number
): { warmUps: number[]; recorded: number[] } {
 const required = count + warmUpCount;
  if (observations.length < required) {
    throw new Error(
 `a warmed stage needs at least ${required} observations: ${warmUpCount} declared ` +
        `warm-up observations plus ${count} recorded samples`
    );
  }
 const warmUps = observations.slice(0, warmUpCount);
  if (
    [...warmUps, ...observations.slice(0, required)].some(
      (value) => typeof value !== "number" || !Number.isFinite(value) || value < 0
    )
  ) {
    throw new Error("warm-up and recorded observations must be finite non-negative numbers");
  }
 return { warmUps: [...warmUps], recorded: observations.slice(warmUpCount, required) as number[] };
}

/**
 * Declared stationarity check for one warmed cell/run. Compares the FINAL
 * warm-up observations against the measured window using the predeclared band,
 * and returns the ratio for the audit trail. A window whose warm-ups have not
 * settled is INVALID — it is never repaired by discarding further samples,
 * because choosing how many samples to drop after seeing the values would turn
 * benchmark conditioning into result selection.
 */
export function assertWarmUpStationarity(input: {
  label: string;
warmUps: readonly number[];
recorded: readonly number[];
 warmUpCount: number;
}): number {
 const { label, warmUps, recorded, warmUpCount } = input;
 if (warmUps.length !== warmUpCount) {
 throw new Error(`${label} must retain exactly ${warmUpCount} warm-up observations`);
  }
  if (recorded.length !== TIME_TO_ANSWER_WARMED_SAMPLES) {
    throw new Error(`${label} must record exactly ${TIME_TO_ANSWER_WARMED_SAMPLES} measured samples`);
  }
 const ratio = warmUpStationarityCalculation(warmUps, recorded).ratio;
  if (!Number.isFinite(ratio) || ratio <= 0) {
    throw new Error(`${label} has no usable warm-up/measured ratio`);
  }
  if (ratio > TIME_TO_ANSWER_STATIONARITY_MAX_RATIO || ratio < TIME_TO_ANSWER_STATIONARITY_MIN_RATIO) {
    throw new Error(
      `${label} is not stationary: the final warm-up observations sit at ${ratio.toFixed(2)}x the measured ` +
        `median, outside the declared ${TIME_TO_ANSWER_STATIONARITY_MIN_RATIO}–` +
        `${TIME_TO_ANSWER_STATIONARITY_MAX_RATIO}x band`
    );
  }
 return ratio;
}

/** The audit calculation used by the unchanged warm-up stationarity validity check. */
export function warmUpStationarityCalculation(
 warmUps: readonly number[],
 recorded: readonly number[]
): { finalWarmUpMedian: number; measuredMedian: number; ratio: number } {
 const finalWarmUpMedian = median(warmUps.slice(-2));
 const measuredMedian = median(recorded);
 return { finalWarmUpMedian, measuredMedian, ratio: finalWarmUpMedian / measuredMedian };
}

/**
 * Bind the executed daemon binary to the recorded source revision. The benchmark
 * does not claim bit-for-bit reproducible Rust builds across machines; it proves
 * which binary THIS capture executed.
 */
export function assertDaemonBinaryProvenance(input: {
  expectedSha256: string;
  observedSha256: string;
  phase: string;
}): void {
  if (!/^[0-9a-f]{64}$/.test(input.expectedSha256) || !/^[0-9a-f]{64}$/.test(input.observedSha256)) {
    throw new Error("daemon binary provenance requires two lowercase sha256 digests");
  }
  if (input.expectedSha256 !== input.observedSha256) {
    throw new Error(
      `daemon binary provenance failed ${input.phase}: the executable is not the binary this capture pinned`
    );
  }
}

/**
 * Provenance/identity keys: recorded so a baseline identifies exactly what was
 * measured, but never a comparison REQUIREMENT. The executable digest and the
 * source/harness revisions differ by construction for any legitimate candidate
 * that changes the product or the harness, so requiring them to match would make
 * comparison impossible — and the daemon binary is rebuilt from the candidate
 * checkout, so a byte-identical digest is not even reproducible across a changed
 * `CARGO_HOME`.
 */
export const TIME_TO_ANSWER_PROVENANCE_KEYS = [
  "sourceRevision",
  "harnessRevision",
  "daemonBinarySha256"
] as const;

/**
 * Recorded but informational: no measured stage exercises the host Docker daemon
 * (the capture runs against the deterministic fixture daemon), so requiring this
 * to match would fail a comparison for a dimension this benchmark never touches.
 */
export const TIME_TO_ANSWER_INFORMATIONAL_KEYS = ["dockerRevision"] as const;

/**
 * The keys a candidate must share with the baseline to be comparable at all:
 * runner/CPU/OS/kernel, Node/Rust toolchain, cargo, browser engine/revision/
 * flags, fonts, production build mode, fixture revision, the polling
 * configuration, the daemon build command, and the benchmark methodology
 * version. A time-to-answer number is only comparable to another number produced
 * by the same design in the same environment.
 */
export const timeToAnswerCompatibilityKeys = environmentKeys.filter(
  (key) =>
    !(TIME_TO_ANSWER_PROVENANCE_KEYS as readonly string[]).includes(key) &&
    !(TIME_TO_ANSWER_INFORMATIONAL_KEYS as readonly string[]).includes(key)
);

export function compatibleTimeToAnswerEnvironment(
  baseline: TimeToAnswerEnvironment,
  candidate: TimeToAnswerEnvironment
): boolean {
  return timeToAnswerCompatibilityKeys.every(
    (key) => JSON.stringify(baseline[key]) === JSON.stringify(candidate[key])
  );
}

/**
 * The phase-normalized stage-5 figure (methodology revision 2): the observed
 * latency median at each DECLARED phase, then nearest-rank p95 over those phase
 * medians. Uniform weighting over the declared grid is a statement about the
 * polling MECHANISM — never about real host publication phase or network
 * distance.
 */
export function derivedTimeToAnswerPhaseNormalized(
  runs: readonly (readonly number[])[],
  ssePollIntervalMs: string
): { phaseMediansMs: readonly number[]; phaseNormalizedP95Ms: number } {
  const intervalMs = Number(ssePollIntervalMs);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("the pinned SSE poll interval must be a positive number of milliseconds");
  }
  if (runs.length !== TIME_TO_ANSWER_CONTROLLED_RUNS) {
    throw new Error(`stage 5 requires exactly ${TIME_TO_ANSWER_CONTROLLED_RUNS} controlled runs to normalise by phase`);
  }
  return {
    phaseMediansMs: phaseMediansMs(runs, intervalMs),
    phaseNormalizedP95Ms: phaseNormalizedP95Ms(runs, intervalMs)
  };
}

/**
 * Regression limits are derived from the measured baseline with the same
 * reviewed rule the Atlas evidence uses; no aspirational absolute millisecond
 * budget is invented before a baseline exists.
 */
export function timeToAnswerLimit(baselineMs: number): number {
  if (!Number.isFinite(baselineMs) || baselineMs < 0) {
    throw new Error("Time-to-answer baseline must be a finite non-negative duration.");
  }
  return Math.max(baselineMs * 1.25, baselineMs + 2);
}

export function withinTimeToAnswerPromotionLimit(baselineMs: number, candidateMs: number): boolean {
  return Number.isFinite(candidateMs) && candidateMs >= 0 && candidateMs <= timeToAnswerLimit(baselineMs);
}

/** The benchmark job calls this after reading two closed JSON artifacts. */
export function assertTimeToAnswerPromotion(baselineRaw: unknown, candidateRaw: unknown): void {
  const baseline = validateTimeToAnswerEvidence(baselineRaw);
  const candidate = validateTimeToAnswerEvidence(candidateRaw);
  if (!compatibleTimeToAnswerEnvironment(baseline.environment, candidate.environment)) {
    throw new Error("Time-to-answer candidate does not match the pinned baseline environment.");
  }
  const baselineSummaries = derivedTimeToAnswerSummaries(baseline);
  for (const [key, candidateSummary] of derivedTimeToAnswerSummaries(candidate)) {
    const baselineSummary = baselineSummaries.get(key);
    if (
      !baselineSummary ||
      !withinTimeToAnswerPromotionLimit(
 baselineSummary.reviewedMs,
 candidateSummary.reviewedMs
      )
    ) {
      throw new Error(`Time-to-answer candidate exceeds the reviewed promotion limit for ${key}.`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Stage 6 / stage 7 independence control (#335)
 *
 * Stage 6 ends when the APPLICATION accepts a coherent model; stage 7 begins
 * at that instant and ends when the accepted model's expected Home content has
 * rendered (and one bounded frame has confirmed presentation). If the two
 * numbers came from one clock, an artificial presentation delay injected AFTER
 * acceptance would move both. The control therefore arms exactly that delay and
 * requires stage 6 to stay put while stage 7 grows by the injected amount.
 * ------------------------------------------------------------------ */

/** The artificial presentation delay injected after coherent-model acceptance. */
export const TIME_TO_ANSWER_INDEPENDENCE_DELAY_MS = 250;
/** Control samples per fixture that declares stages 6 and 7. */
export const TIME_TO_ANSWER_INDEPENDENCE_SAMPLES = 3;
/**
 * Stage 6 must not move more than this. The allowance is generous relative to
 * the delay: it exists to absorb ordinary run-to-run variance in a number that
 * the control cannot legitimately affect, not to permit a shared clock.
 */
export const TIME_TO_ANSWER_INDEPENDENCE_STAGE_SIX_TOLERANCE_MS = 30;
/** Stage 7 must absorb at least this share of the injected delay. */
export const TIME_TO_ANSWER_INDEPENDENCE_STAGE_SEVEN_SHARE = 0.7;
export interface StageSixSevenIndependence {
  fixture: string;
  delayMs: number;
  normalStageSixMs: readonly number[];
  normalStageSevenMs: readonly number[];
  controlStageSixMs: readonly number[];
  controlStageSevenMs: readonly number[];
  stageSixMedianMs: number;
  stageSixControlMedianMs: number;
  stageSevenMedianMs: number;
  stageSevenControlMedianMs: number;
  stageSixDeltaMs: number;
  stageSevenDeltaMs: number;
}

function assertSampleSet(label: string, values: readonly number[]): void {
  if (values.length === 0) throw new Error(`${label} requires at least one sample`);
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
    throw new Error(`${label} requires finite non-negative samples`);
  }
}

/**
 * Enforce the independence control. Throws when the injected presentation delay
 * fails to move stage 7 (the seam is measuring something other than
 * presentation) or when it also moves stage 6 (both stages share a clock). A
 * capture that cannot demonstrate this must not produce a baseline.
 */
export function assertStageSixSevenIndependence(input: {
  fixture: string;
  delayMs?: number;
  normalStageSixMs: readonly number[];
  normalStageSevenMs: readonly number[];
  controlStageSixMs: readonly number[];
  controlStageSevenMs: readonly number[];
}): StageSixSevenIndependence {
  const delayMs = input.delayMs ?? TIME_TO_ANSWER_INDEPENDENCE_DELAY_MS;
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    throw new Error("the independence control requires a positive injected delay");
  }
  assertSampleSet("stage 6 normal samples", input.normalStageSixMs);
  assertSampleSet("stage 7 normal samples", input.normalStageSevenMs);
  assertSampleSet("stage 6 control samples", input.controlStageSixMs);
  assertSampleSet("stage 7 control samples", input.controlStageSevenMs);

  const stageSixMedianMs = median(input.normalStageSixMs);
  const stageSixControlMedianMs = median(input.controlStageSixMs);
  const stageSevenMedianMs = median(input.normalStageSevenMs);
  const stageSevenControlMedianMs = median(input.controlStageSevenMs);
  const stageSixDeltaMs = stageSixControlMedianMs - stageSixMedianMs;
  const stageSevenDeltaMs = stageSevenControlMedianMs - stageSevenMedianMs;

  const stageSixAllowance = Math.max(
    TIME_TO_ANSWER_INDEPENDENCE_STAGE_SIX_TOLERANCE_MS,
    stageSixMedianMs * 0.25
  );
  if (stageSixDeltaMs > stageSixAllowance) {
    throw new Error(
      `stage 6 moved by ${stageSixDeltaMs.toFixed(1)} ms under an artificial delay injected AFTER acceptance ` +
        `(allowance ${stageSixAllowance.toFixed(1)} ms): stage 6 is not independent of presentation`
    );
  }
  const requiredStageSevenDelta = delayMs * TIME_TO_ANSWER_INDEPENDENCE_STAGE_SEVEN_SHARE;
  if (stageSevenDeltaMs < requiredStageSevenDelta) {
    throw new Error(
      `stage 7 only moved by ${stageSevenDeltaMs.toFixed(1)} ms for a ${delayMs} ms artificial delay ` +
        `(required at least ${requiredStageSevenDelta.toFixed(1)} ms): stage 7 does not measure presentation of the accepted model`
    );
  }
  if (input.controlStageSevenMs.some((value) => value < delayMs)) {
    throw new Error("a control stage-7 sample is shorter than the injected delay, so the delay was not applied");
  }
  return {
    fixture: input.fixture,
    delayMs,
    normalStageSixMs: input.normalStageSixMs,
    normalStageSevenMs: input.normalStageSevenMs,
    controlStageSixMs: input.controlStageSixMs,
    controlStageSevenMs: input.controlStageSevenMs,
    stageSixMedianMs,
    stageSixControlMedianMs,
    stageSevenMedianMs,
    stageSevenControlMedianMs,
    stageSixDeltaMs,
    stageSevenDeltaMs
  };
}
