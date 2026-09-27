#!/usr/bin/env node
/** Read-only promotion comparison for two closed composite evidence artifacts. */
import { readFileSync } from "node:fs";
import {
assertTimeToAnswerPromotion,
derivedTimeToAnswerSummaries,
timeToAnswerLimit,
validateTimeToAnswerEvidence
} from "../../apps/web/src/lib/performance/timeToAnswerEvidence";

type Paths = { baseline: string; candidate: string };

function paths(arguments_: readonly string[]): Paths {
const values: Partial<Paths> = {};
for (let index = 0; index < arguments_.length; index += 1) {
const flag = arguments_[index]!;
if (flag !== "--baseline" && flag !== "--candidate") throw new Error(`Unknown flag: ${flag}`);
const value = arguments_[index + 1];
if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
const key = flag.slice(2) as keyof Paths;
if (values[key]) throw new Error(`Duplicate flag: ${flag}`);
values[key] = value;
index += 1;
}
if (!values.baseline || !values.candidate) {
throw new Error("Usage: npm run perf:promote -- --baseline <composite.json> --candidate <composite.json>");
}
return values as Paths;
}

function readEvidence(path: string): unknown {
try {
return JSON.parse(readFileSync(path, "utf8"));
} catch (error) {
throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
}
}

function format(value: number): string { return value.toFixed(2); }

function main(): void {
const input = paths(process.argv.slice(2));
const baselineRaw = readEvidence(input.baseline);
const candidateRaw = readEvidence(input.candidate);
const baseline = validateTimeToAnswerEvidence(baselineRaw);
const candidate = validateTimeToAnswerEvidence(candidateRaw);
const baselineSummaries = derivedTimeToAnswerSummaries(baseline);
const candidateSummaries = derivedTimeToAnswerSummaries(candidate);
const regressions: string[] = [];
const violations: string[] = [];
process.stdout.write("| fixture | stage | protocol | baseline reviewed (ms) | limit (ms) | candidate reviewed (ms) | delta (ms) | verdict |\n");
process.stdout.write("| --- | --- | --- | ---: | ---: | ---: | ---: | --- |\n");
for (const record of candidate.records) {
const key = `${record.fixture}\u0000${record.stage}`;
const before = baselineSummaries.get(key)!;
const after = candidateSummaries.get(key)!;
const limit = timeToAnswerLimit(before.reviewedMs);
const delta = after.reviewedMs - before.reviewedMs;
if (delta > 0) regressions.push(`${record.fixture}/${record.stage}`);
if (after.reviewedMs > limit) violations.push(key);
process.stdout.write(`| ${record.fixture} | ${record.stage} | ${record.measurementProtocol} | ${format(before.reviewedMs)} | ${format(limit)} | ${format(after.reviewedMs)} | ${format(delta)} | ${after.reviewedMs <= limit ? "PASS" : "FAIL"} |\n`);
}
process.stdout.write(`Slower than baseline: ${regressions.join(", ") || "none"}\n`);
try {
assertTimeToAnswerPromotion(baselineRaw, candidateRaw);
process.stdout.write("PROMOTION: PASS\n");
} catch (error) {
if (violations.length > 0) process.stdout.write(`Offending keys: ${violations.join(", ")}\n`);
const reason = error instanceof Error ? error.message : String(error);
process.stdout.write(`PROMOTION: FAIL:${reason}\n`);
process.exitCode = 1;
}
}

try {
main();
} catch (error) {
const reason = error instanceof Error ? error.message : String(error);
process.stderr.write(`PROMOTION: FAIL:${reason}\n`);
process.exitCode = 1;
}
