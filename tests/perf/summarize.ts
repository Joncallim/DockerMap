#!/usr/bin/env node
/**
 * Recompute and print the time-to-answer summary from a closed artifact (#335).
 *
 *   npm run perf:summarize -- --artifact <artifact.json> [--markdown]
 *
 * Summaries are ALWAYS recomputed from the raw samples here; the artifact never
 * carries them. This is the same path a reviewer uses, so the numbers in the
 * interpretation document cannot drift from the evidence.
 */
import { readFileSync } from "node:fs";
import {
  TIME_TO_ANSWER_STAGES,
  derivedTimeToAnswerPhaseNormalized,
  derivedTimeToAnswerSummaries,
  validateTimeToAnswerEvidence
} from "../../apps/web/src/lib/performance/timeToAnswerEvidence";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .flatMap((value, index, all) => (value.startsWith("--") ? [[value.slice(2), all[index + 1] ?? ""]] : []))
);
const artifactPath = args.artifact;
if (!artifactPath || artifactPath.startsWith("--")) {
  throw new Error("Usage: npm run perf:summarize -- --artifact <artifact.json>");
}

const evidence = validateTimeToAnswerEvidence(JSON.parse(readFileSync(artifactPath, "utf8")));
const summaries = derivedTimeToAnswerSummaries(evidence);
const stageById = new Map(TIME_TO_ANSWER_STAGES.map((stage) => [stage.id, stage]));

const fixtures = [...new Set(evidence.records.map((record) => record.fixture))];
const order = [...new Set(evidence.records.map((record) => record.stage))];

const rows: string[] = [];
rows.push("| fixture | stage | run p95 (ms) | median (ms) | min | max |");
rows.push("| --- | --- | --- | --- | --- | --- |");
for (const fixture of fixtures) {
  for (const stage of order) {
    const summary = summaries.get(`${fixture}\u0000${stage}`);
    if (!summary) continue;
    const record = evidence.records.find((entry) => entry.fixture === fixture && entry.stage === stage)!;
    const all = record.runs.flat();
    rows.push(
      `| ${fixture} | ${stage} | ${summary.runP95Ms.map((value) => value.toFixed(2)).join(" / ")} | ${summary.medianOfThreeRunP95Ms.toFixed(2)} | ${Math.min(...all).toFixed(2)} | ${Math.max(...all).toFixed(2)} |`
    );
  }
}

process.stdout.write(`${rows.join("\n")}\n\n`);

// Stage 5: the declared-phase curve and the phase-normalized figure. Both are
// recomputed here from the raw samples, using the declared grid — never read from
// the artifact, which stores raw numbers only.
const stageFiveFixtures = fixtures.filter((fixture) =>
  evidence.records.some((record) => record.fixture === fixture && record.stage === "publicationToNodeObservationMs")
);
if (stageFiveFixtures.length > 0) {
  const intervalMs = Number(evidence.environment.ssePollIntervalMs);
  process.stdout.write(
    "### stage 5 — publication → Node observation, by declared poll phase\n\n" +
      "| fixture | declared phases | observed latency median per declared phase (ms, earliest→latest) | phase-normalized p95 (ms) | span (ms) |\n" +
      "| --- | --- | --- | --- | --- |\n"
  );
  for (const fixture of stageFiveFixtures) {
    const record = evidence.records.find(
      (entry) => entry.fixture === fixture && entry.stage === "publicationToNodeObservationMs"
    )!;
    const normalized = derivedTimeToAnswerPhaseNormalized(record.runs, evidence.environment.ssePollIntervalMs);
    const flat = record.runs.flat();
    process.stdout.write(
      `| ${fixture} | ${normalized.phaseMediansMs.length} | ${normalized.phaseMediansMs
        .map((value) => value.toFixed(0))
        .join(", ")} | ${normalized.phaseNormalizedP95Ms.toFixed(2)} | ${(Math.max(...flat) - Math.min(...flat)).toFixed(2)} |\n`
    );
  }
  process.stdout.write(
    "\nThe phase-normalized figure weights the DECLARED phases uniformly to characterise the latency the fixed " +
      `${intervalMs} ms polling mechanism imposes. It is not an observed user-traffic distribution and not network latency.\n\n`
  );
}

// Bucket roll-up per reference fixture: where the time actually goes.
const referenceFixtures = fixtures.filter((fixture) => fixture.startsWith("reference-"));
for (const fixture of referenceFixtures) {
  const bucketTotals = new Map<string, number>();
  let total = 0;
  for (const stage of TIME_TO_ANSWER_STAGES) {
    const summary = summaries.get(`${fixture}\u0000${stage.id}`);
    if (!summary) continue;
    const definition = stageById.get(stage.id)!;
    bucketTotals.set(definition.bucket, (bucketTotals.get(definition.bucket) ?? 0) + summary.medianOfThreeRunP95Ms);
    total += summary.medianOfThreeRunP95Ms;
  }
  process.stdout.write(`\n### ${fixture} buckets (sum of stage medians: ${total.toFixed(2)} ms)\n`);
  for (const [bucket, value] of [...bucketTotals.entries()].sort((left, right) => right[1] - left[1])) {
    process.stdout.write(
      `- ${bucket}: ${value.toFixed(2)} ms (${((value / total) * 100).toFixed(1)}%)\n`
    );
  }
}

process.stdout.write(
  `\nenvironment: ${JSON.stringify(evidence.environment, null, 2)}\n`
);
