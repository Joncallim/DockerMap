import { describe, expect, it } from "vitest";
import { ATLAS_HYBRID_BENCHMARK_FIXTURES, ATLAS_HYBRID_CONTROLLED_RUNS, ATLAS_HYBRID_PERFORMANCE_BASELINE, ATLAS_HYBRID_WARMED_SAMPLES, assertAtlasHybridPerformancePromotion, atlasPerformanceLimit, compatibleAtlasBenchmarkEnvironment, derivedAtlasHybridSummaries, p95, validateAtlasHybridPerformanceEvidence, withinAtlasPerformancePromotionLimit } from "./performanceEvidence";
import { ATLAS_RENDERER_POLICY } from "./policy";

const environment = {
  runnerClass: "dedicated-linux-x64", cpuClass: "pinned-4-vcpu", osImage: "ubuntu-24.04@sha256:fixture",
  browserEngine: "chromium", browserRevision: "1234567", browserFlags: ["--disable-background-networking"],
  fontEnvironment: "Noto-Sans-1.0", buildMode: "production", fixtureRevision: "atlas-v1/hybrid-fixtures-1",
  rendererPolicyVersion: ATLAS_RENDERER_POLICY.version, sourceRevision: "candidate"
};

function rawEvidence() {
  return {
    baseline: ATLAS_HYBRID_PERFORMANCE_BASELINE,
    environment,
    records: ATLAS_HYBRID_BENCHMARK_FIXTURES.flatMap((fixture) => ["mountMs", "selectedSubjectUpdateMs"].map((operation) => ({
      fixture: fixture.name, operation,
      runs: Array.from({ length: ATLAS_HYBRID_CONTROLLED_RUNS }, (_, run) => Array.from({ length: ATLAS_HYBRID_WARMED_SAMPLES }, (_, sample) => run * 20 + sample + 1))
    })))
  };
}

describe("Atlas hybrid certification evidence contract", () => {
  it("requires the exact 25/100/250 fixture × operation matrix and recomputes summaries from raw samples", () => {
    const evidence = validateAtlasHybridPerformanceEvidence(rawEvidence());
    const summaries = derivedAtlasHybridSummaries(evidence);
    expect(ATLAS_HYBRID_CONTROLLED_RUNS).toBe(3);
    expect(p95(Array.from({ length: 15 }, (_, index) => index))).toBe(14);
    expect(summaries.get("atlas-v1/chain-dependency-25\u0000mountMs")).toEqual({ runP95Ms: [15, 35, 55], medianOfThreeRunP95Ms: 35 });
    expect(() => validateAtlasHybridPerformanceEvidence({ ...rawEvidence(), summary: "fabricated" })).toThrow("closed baseline/environment/records schema");
    expect(() => validateAtlasHybridPerformanceEvidence({ ...rawEvidence(), records: rawEvidence().records.slice(1) })).toThrow("exact fixture × operation matrix");
    const missingSamples = rawEvidence();
    missingSamples.records[0]!.runs[0] = [1];
    expect(() => validateAtlasHybridPerformanceEvidence(missingSamples)).toThrow("exactly 15");
  });

  it("rejects unsafe or arbitrary benchmark metadata and only compares equivalent pinned environments", () => {
    expect(() => validateAtlasHybridPerformanceEvidence({ ...rawEvidence(), environment: { ...environment, rawHostPath: "/private/host" } })).toThrow("closed safe metadata fields");
    expect(() => validateAtlasHybridPerformanceEvidence({ ...rawEvidence(), environment: { ...environment, fontEnvironment: "font with spaces" } })).toThrow("closed safe metadata fields");
    const baseline = validateAtlasHybridPerformanceEvidence(rawEvidence()).environment;
    expect(compatibleAtlasBenchmarkEnvironment(baseline, { ...baseline, sourceRevision: "baseline" })).toBe(true);
    expect(compatibleAtlasBenchmarkEnvironment(baseline, { ...baseline, browserRevision: "different" })).toBe(false);
    const candidate = rawEvidence();
    candidate.environment = { ...candidate.environment, sourceRevision: "different-source" };
    expect(() => assertAtlasHybridPerformancePromotion(rawEvidence(), candidate)).not.toThrow();
    candidate.environment = { ...candidate.environment, browserRevision: "different" };
    expect(() => assertAtlasHybridPerformancePromotion(rawEvidence(), candidate)).toThrow("does not match the pinned baseline environment");
  });

  it("uses the documented max(baseline × 1.25, baseline + 2 ms) gate without making local timings a test threshold", () => {
    expect(atlasPerformanceLimit(4)).toBe(6);
    expect(atlasPerformanceLimit(20)).toBe(25);
    expect(withinAtlasPerformancePromotionLimit(20, 25)).toBe(true);
    expect(withinAtlasPerformancePromotionLimit(20, 25.01)).toBe(false);
  });
});
