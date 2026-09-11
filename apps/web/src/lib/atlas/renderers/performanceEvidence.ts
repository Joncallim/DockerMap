import { ATLAS_RENDERER_POLICY } from "./policy";

/** External controlled-job contract; shared tests validate only shape and math. */
export const ATLAS_HYBRID_PERFORMANCE_BASELINE = "atlas-v1/hybrid-perf-baseline-1";
export const ATLAS_HYBRID_BUNDLE_BASELINE = "atlas-v1/hybrid-bundle-baseline-1";
export const ATLAS_HYBRID_WARMED_SAMPLES = 15;
export const ATLAS_HYBRID_CONTROLLED_RUNS = 3;

export const ATLAS_HYBRID_BENCHMARK_FIXTURES = [
  { name: "atlas-v1/chain-dependency-25", subjects: 25 },
  { name: "atlas-v1/chain-dependency-100", subjects: 100 },
  { name: "atlas-v1/chain-dependency-250", subjects: 250 }
] as const;

export type AtlasHybridBenchmarkFixture = (typeof ATLAS_HYBRID_BENCHMARK_FIXTURES)[number];
export type AtlasHybridOperation = "mountMs" | "selectedSubjectUpdateMs";
export type AtlasSafeBenchmarkEnvironment = {
  runnerClass: string; cpuClass: string; osImage: string; browserEngine: "chromium";
  browserRevision: string; browserFlags: readonly string[]; fontEnvironment: string;
  buildMode: "production"; fixtureRevision: string;
  rendererPolicyVersion: typeof ATLAS_RENDERER_POLICY.version; sourceRevision: string;
};

export interface AtlasHybridPerformanceRecord {
  fixture: AtlasHybridBenchmarkFixture["name"];
  operation: AtlasHybridOperation;
  /** Each inner array is one complete controlled run of warmed samples. */
  runs: readonly (readonly number[])[];
}

export interface AtlasHybridPerformanceEvidence {
  baseline: typeof ATLAS_HYBRID_PERFORMANCE_BASELINE;
  environment: AtlasSafeBenchmarkEnvironment;
  records: readonly AtlasHybridPerformanceRecord[];
}

export interface AtlasHybridOperationSummary {
  runP95Ms: readonly number[];
  medianOfThreeRunP95Ms: number;
}

const environmentKeys = ["runnerClass", "cpuClass", "osImage", "browserEngine", "browserRevision", "browserFlags", "fontEnvironment", "buildMode", "fixtureRevision", "rendererPolicyVersion", "sourceRevision"] as const;
const evidenceKeys = ["baseline", "environment", "records"] as const;
const recordKeys = ["fixture", "operation", "runs"] as const;
const safeValue = /^[A-Za-z0-9._/@:+=-]{1,160}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function safeString(value: unknown): value is string {
  return typeof value === "string" && safeValue.test(value);
}

/** Nearest-rank percentile: for 15 samples, p95 is the largest observed value. */
export function p95(samples: readonly number[]): number {
  if (samples.length !== ATLAS_HYBRID_WARMED_SAMPLES || samples.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new Error(`Atlas benchmark requires exactly ${ATLAS_HYBRID_WARMED_SAMPLES} finite non-negative warmed samples.`);
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}

export function summarizeAtlasHybridOperation(runs: readonly (readonly number[])[]): AtlasHybridOperationSummary {
  if (runs.length !== ATLAS_HYBRID_CONTROLLED_RUNS) throw new Error(`Atlas benchmark requires exactly ${ATLAS_HYBRID_CONTROLLED_RUNS} complete controlled runs.`);
  const runP95Ms = runs.map(p95);
  const ordered = [...runP95Ms].sort((left, right) => left - right);
  return { runP95Ms, medianOfThreeRunP95Ms: ordered[1]! };
}

export function assertAtlasBenchmarkEnvironment(environment: unknown): asserts environment is AtlasSafeBenchmarkEnvironment {
  if (!isObject(environment) || !hasExactKeys(environment, environmentKeys)
    || environment.browserEngine !== "chromium" || environment.buildMode !== "production"
    || ![environment.runnerClass, environment.cpuClass, environment.osImage, environment.browserRevision, environment.fontEnvironment, environment.fixtureRevision, environment.rendererPolicyVersion, environment.sourceRevision].every(safeString)
    || !Array.isArray(environment.browserFlags) || environment.browserFlags.length === 0 || environment.browserFlags.length > 16 || !environment.browserFlags.every(safeString)) {
    throw new Error("Atlas benchmark environment must use exactly the closed safe metadata fields for pinned Chromium, flags, fonts, runner/CPU/OS, production build, fixture/policy, and source revision.");
  }
}

/** Reject untrusted JSON before deriving summaries: the artifact stores raw samples only. */
export function validateAtlasHybridPerformanceEvidence(value: unknown): AtlasHybridPerformanceEvidence {
  if (!isObject(value) || !hasExactKeys(value, evidenceKeys) || value.baseline !== ATLAS_HYBRID_PERFORMANCE_BASELINE || !Array.isArray(value.records)) {
    throw new Error("Atlas performance evidence must use the closed baseline/environment/records schema.");
  }
  assertAtlasBenchmarkEnvironment(value.environment);
  const expected = new Set(ATLAS_HYBRID_BENCHMARK_FIXTURES.flatMap((fixture) => ["mountMs", "selectedSubjectUpdateMs"].map((operation) => `${fixture.name}\u0000${operation}`)));
  if (value.records.length !== expected.size) throw new Error("Atlas performance evidence must contain the exact fixture × operation matrix.");
  const records = value.records.map((raw) => {
    if (!isObject(raw) || !hasExactKeys(raw, recordKeys) || typeof raw.fixture !== "string" || (raw.operation !== "mountMs" && raw.operation !== "selectedSubjectUpdateMs") || !Array.isArray(raw.runs)) {
      throw new Error("Atlas performance record has an unsafe or incomplete shape.");
    }
    const key = `${raw.fixture}\u0000${raw.operation}`;
    if (!expected.delete(key)) throw new Error("Atlas performance evidence has a duplicate or unsupported fixture/operation record.");
    if (raw.runs.length !== ATLAS_HYBRID_CONTROLLED_RUNS || !raw.runs.every((run) => Array.isArray(run))) throw new Error("Atlas performance evidence requires exactly three raw runs per operation.");
    const runs = raw.runs.map((run) => run.map((sample) => {
      if (typeof sample !== "number") throw new Error("Atlas timing samples must be numeric.");
      return sample;
    }));
    // Executes all finite/non-negative/15-sample checks and prevents summaries from being trusted input.
    summarizeAtlasHybridOperation(runs);
    return { fixture: raw.fixture as AtlasHybridBenchmarkFixture["name"], operation: raw.operation as AtlasHybridOperation, runs };
  });
  if (expected.size !== 0) throw new Error("Atlas performance evidence is missing a required fixture/operation record.");
  return { baseline: ATLAS_HYBRID_PERFORMANCE_BASELINE, environment: value.environment, records };
}

export function derivedAtlasHybridSummaries(evidence: AtlasHybridPerformanceEvidence): ReadonlyMap<string, AtlasHybridOperationSummary> {
  return new Map(evidence.records.map((record) => [`${record.fixture}\u0000${record.operation}`, summarizeAtlasHybridOperation(record.runs)]));
}

/** Source revision deliberately differs between a baseline and its candidate. */
export function compatibleAtlasBenchmarkEnvironment(baseline: AtlasSafeBenchmarkEnvironment, candidate: AtlasSafeBenchmarkEnvironment): boolean {
  return environmentKeys.filter((key) => key !== "sourceRevision").every((key) => JSON.stringify(baseline[key]) === JSON.stringify(candidate[key]));
}

export function atlasPerformanceLimit(baselineMs: number): number {
  if (!Number.isFinite(baselineMs) || baselineMs < 0) throw new Error("Atlas performance baseline must be a finite non-negative duration.");
  return Math.max(baselineMs * 1.25, baselineMs + 2);
}

export function withinAtlasPerformancePromotionLimit(baselineMs: number, candidateMs: number): boolean {
  return Number.isFinite(candidateMs) && candidateMs >= 0 && candidateMs <= atlasPerformanceLimit(baselineMs);
}

/** The dedicated benchmark job calls this after reading two closed JSON artifacts. */
export function assertAtlasHybridPerformancePromotion(baselineRaw: unknown, candidateRaw: unknown): void {
  const baseline = validateAtlasHybridPerformanceEvidence(baselineRaw);
  const candidate = validateAtlasHybridPerformanceEvidence(candidateRaw);
  if (!compatibleAtlasBenchmarkEnvironment(baseline.environment, candidate.environment)) {
    throw new Error("Atlas performance candidate does not match the pinned baseline environment.");
  }
  const baselineSummaries = derivedAtlasHybridSummaries(baseline);
  for (const [key, candidateSummary] of derivedAtlasHybridSummaries(candidate)) {
    const baselineSummary = baselineSummaries.get(key);
    if (!baselineSummary || !withinAtlasPerformancePromotionLimit(baselineSummary.medianOfThreeRunP95Ms, candidateSummary.medianOfThreeRunP95Ms)) {
      throw new Error(`Atlas performance candidate exceeds the reviewed promotion limit for ${key}.`);
    }
  }
}
