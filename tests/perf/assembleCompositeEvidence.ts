/** Composite Baseline-4 assembly.  Sections remain separate until validation. */
import { readFileSync, writeFileSync } from "node:fs";
import { TIME_TO_ANSWER_BASELINE, TIME_TO_ANSWER_MATRIX, TIME_TO_ANSWER_METHODOLOGY, validateTimeToAnswerEvidence } from "../../apps/web/src/lib/performance/timeToAnswerEvidence";

export function assembleCompositeEvidence(general: any, stageFive: any, stageSixSeven: any, sources: { general: string; stageFive: string; stageSixSeven: string }) {
if (general.environment?.methodologyVersion !== TIME_TO_ANSWER_METHODOLOGY || stageFive.methodologyVersion !== TIME_TO_ANSWER_METHODOLOGY || stageSixSeven.methodologyVersion !== TIME_TO_ANSWER_METHODOLOGY) throw new Error("raw sections do not share the Baseline-4 methodology");
if (!stageFive.checkpointSha || stageFive.checkpointSha !== stageSixSeven.checkpointSha || general.environment?.sourceRevision !== stageFive.checkpointSha) throw new Error("raw sections do not share a committed checkpoint");
const stageFiveRecords = Object.entries(stageFive.cells ?? {}).map(([fixture, samples]: [string, any]) => ({
 fixture, stage: "publicationToNodeObservationMs", measurementProtocol: "controlled-poll-phase", sourceEvidenceFile: sources.stageFive, checkpointSha: stageFive.checkpointSha,
 runs: Array.from({ length: 3 }, (_, run) => samples.filter((sample: any) => sample.run === run).sort((a: any, b: any) => a.sample - b.sample).map((sample: any) => sample.observedLatencyMs))
}));
const controlledFixtures = new Set(TIME_TO_ANSWER_MATRIX.filter((cell) => cell.stage === "notificationToCoherentModelMs").map((cell) => cell.fixture).filter((fixture) => TIME_TO_ANSWER_MATRIX.some((cell) => cell.fixture === fixture && cell.stage === "coherentModelToUsefulRenderMs")));
for (const record of general.records ?? []) {
 if (controlledFixtures.has(record.fixture) && (record.stage === "notificationToCoherentModelMs" || record.stage === "coherentModelToUsefulRenderMs")) throw new Error(`general evidence is contaminated with controlled Stage-6/7 samples for ${record.fixture}`);
}
const generalRecords = (general.records ?? []).filter((record: any) => record.stage !== "publicationToNodeObservationMs").map((record: any) => ({ ...record, measurementProtocol: "end-to-end", sourceEvidenceFile: sources.general, checkpointSha: stageFive.checkpointSha }));
 if (stageSixSeven.measurementProtocol !== "controlled-stage6-stage7-independence" || !Array.isArray(stageSixSeven.cells) || !stageSixSeven.independenceEvidence || stageSixSeven.independenceEvidence.verdict !== "PASS") throw new Error("Stage-6/7 independence evidence is missing or invalid; composite authority is incomplete");
const expectedFixtures = [...controlledFixtures].sort();
const receivedFixtures = stageSixSeven.cells.map((cell: any) => cell.fixture).sort();
if (JSON.stringify(receivedFixtures) !== JSON.stringify(expectedFixtures)) throw new Error("Stage-6/7 independence evidence does not cover the required fixtures exactly once");
for (const cell of stageSixSeven.cells) {
 if (!Array.isArray(cell.normalStageSixRuns) || !Array.isArray(cell.normalStageSevenRuns) || !cell.controlEvidence || cell.controlEvidence.delayMs !== 250 || cell.controlEvidence.acceptanceSeam !== "observed" || !cell.controlEvidence.triggerRevision || cell.controlEvidence.triggerRevision !== cell.controlEvidence.acceptedRevision || !Array.isArray(cell.controlEvidence.samples) || cell.controlEvidence.samples.some((sample: any) => sample.triggerRevision !== sample.acceptedRevision || sample.delayAppliedAfterAcceptance !== true)) throw new Error(`Stage-6/7 independence evidence is incomplete for ${cell.fixture}`);
}
const independenceRecords = (stageSixSeven.cells ?? []).flatMap((cell: any) => [
 { fixture: cell.fixture, stage: "notificationToCoherentModelMs", measurementProtocol: "controlled-stage6-stage7-independence", sourceEvidenceFile: sources.stageSixSeven, checkpointSha: stageFive.checkpointSha, runs: cell.normalStageSixRuns },
 { fixture: cell.fixture, stage: "coherentModelToUsefulRenderMs", measurementProtocol: "controlled-stage6-stage7-independence", sourceEvidenceFile: sources.stageSixSeven, checkpointSha: stageFive.checkpointSha, runs: cell.normalStageSevenRuns }
]);
return validateTimeToAnswerEvidence({ baseline: TIME_TO_ANSWER_BASELINE, environment: general.environment, records: [...generalRecords, ...stageFiveRecords, ...independenceRecords] });
}

const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, all) => value.startsWith("--") ? [[value.slice(2), all[index + 1] ?? ""]] : []));
if (!args.general || !args.stageFive || !args.stageSixSeven || !args.output) throw new Error("--general, --stageFive, --stageSixSeven and --output are required");
const general = JSON.parse(readFileSync(args.general, "utf8"));
const stageFive = JSON.parse(readFileSync(args.stageFive, "utf8"));
const stageSixSeven = JSON.parse(readFileSync(args.stageSixSeven, "utf8"));
writeFileSync(args.output, `${JSON.stringify(assembleCompositeEvidence(general, stageFive, stageSixSeven, { general: args.general, stageFive: args.stageFive, stageSixSeven: args.stageSixSeven }), null, 2)}\n`);
