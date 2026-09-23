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
      "Daemon publication until the Node/SSE layer observes that revision. The trigger is jittered by a uniform sub-interval delay per sample so the measurement describes the real poll-wait distribution rather than one fixed phase offset between the daemon's refresh cycle and the API's poller.",
    doesNotProve:
      "Not browser work, not render, and not a claim about network distance to a remote operator. It also does not prove the daemon and poller are phase-independent at any single observed sample: samples are de-correlated by the harness, and the underlying mechanism still runs on two fixed 2 s cycles.",
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
      "Browser notification until the app commits a change that alters rendered text, i.e. model-derived content actually reaching the DOM rather than an attribute-only or churn-only mutation.",
    doesNotProve:
      "Not a health judgement and not a statement that every evidence domain is current; it ends when coherent model content is committed, not when the model is complete. It is not attribution to a specific revision — the probe cannot see which revision produced the commit.",
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
      "Browser notification until the Home content region repaints with changed rendered text — a distinct boundary from stage 6, which ends on the first text-changing commit anywhere in the document.",
    doesNotProve:
      "Not a visual-quality or accessibility claim, and not a claim that the operator found the answer. It is declared only for fixtures whose published change demonstrably repaints Home; a provider-only or provider-unavailable revision is not guaranteed to repaint it, so measuring it there would be an empty number.",
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

export const TIME_TO_ANSWER_BASELINE = "dockermap-v1/time-to-answer-baseline-1";
export const TIME_TO_ANSWER_WARMED_SAMPLES = 15;
export const TIME_TO_ANSWER_CONTROLLED_RUNS = 3;

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
  harnessRevision: string;
  browserEngine: "chromium";
  browserRevision: string;
  browserFlags: readonly string[];
  fontEnvironment: string;
  buildMode: "production";
  fixtureRevision: string;
  sourceRevision: string;
};

export interface TimeToAnswerRecord {
  fixture: string;
  stage: TimeToAnswerStageId;
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
  "browserEngine",
  "browserRevision",
  "browserFlags",
  "fontEnvironment",
  "buildMode",
  "fixtureRevision",
  "sourceRevision"
] as const;
const evidenceKeys = ["baseline", "environment", "records"] as const;
const recordKeys = ["fixture", "stage", "runs"] as const;
const safeValue = /^[A-Za-z0-9._/@:+=-]{1,160}$/;
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
  return { runP95Ms, medianOfThreeRunP95Ms: ordered[1]! };
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
      environment.browserRevision,
      environment.fontEnvironment,
      environment.fixtureRevision,
      environment.sourceRevision
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
      !Array.isArray(raw.runs)
    ) {
      throw new Error("Time-to-answer record has an unsafe or incomplete shape.");
    }
    const key = `${raw.fixture}\u0000${raw.stage}`;
    if (!expected.delete(key)) {
      throw new Error("Time-to-answer evidence has a duplicate or unsupported fixture/stage record.");
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
    return { fixture: raw.fixture, stage: raw.stage as TimeToAnswerStageId, runs };
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
    evidence.records.map((record) => [
      `${record.fixture}\u0000${record.stage}`,
      summarizeTimeToAnswerStage(record.runs)
    ])
  );
}

/** Source revision deliberately differs between a baseline and its candidate. */
export function compatibleTimeToAnswerEnvironment(
  baseline: TimeToAnswerEnvironment,
  candidate: TimeToAnswerEnvironment
): boolean {
  return environmentKeys
    // sourceRevision differs by design between a baseline and its candidate.
    // dockerRevision is INFORMATIONAL: no measured stage exercises the host
    // Docker daemon (the capture runs against the deterministic fixture daemon),
    // so requiring it to match would fail a comparison for a dimension this
    // benchmark never touches. It is still recorded and still pinned.
    .filter((key) => key !== "sourceRevision" && key !== "dockerRevision")
    .every((key) => JSON.stringify(baseline[key]) === JSON.stringify(candidate[key]));
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
        baselineSummary.medianOfThreeRunP95Ms,
        candidateSummary.medianOfThreeRunP95Ms
      )
    ) {
      throw new Error(`Time-to-answer candidate exceeds the reviewed promotion limit for ${key}.`);
    }
  }
}
