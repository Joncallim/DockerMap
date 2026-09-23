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
