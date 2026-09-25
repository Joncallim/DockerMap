/** Composite Baseline-4 assembly.  Sections remain separate until validation. */
import { readFileSync, writeFileSync } from "node:fs";
import { TIME_TO_ANSWER_BASELINE, TIME_TO_ANSWER_MATRIX, TIME_TO_ANSWER_METHODOLOGY, validateTimeToAnswerEvidence } from "../../apps/web/src/lib/performance/timeToAnswerEvidence";

const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, all) => value.startsWith("--") ? [[value.slice(2), all[index + 1] ?? ""]] : []));
if (!args.general || !args.stageFive || !args.stageSixSeven || !args.output) throw new Error("--general, --stageFive, --stageSixSeven and --output are required");
const general = JSON.parse(readFileSync(args.general, "utf8"));
const stageFive = JSON.parse(readFileSync(args.stageFive, "utf8"));
const stageSixSeven = JSON.parse(readFileSync(args.stageSixSeven, "utf8"));
if (general.environment?.methodologyVersion !== TIME_TO_ANSWER_METHODOLOGY || stageFive.methodologyVersion !== TIME_TO_ANSWER_METHODOLOGY || stageSixSeven.methodologyVersion !== TIME_TO_ANSWER_METHODOLOGY) throw new Error("raw sections do not share the Baseline-4 methodology");
if (!stageFive.checkpointSha || stageFive.checkpointSha !== stageSixSeven.checkpointSha || general.environment?.sourceRevision !== stageFive.checkpointSha) throw new Error("raw sections do not share a committed checkpoint");
const stageFiveRecords = Object.entries(stageFive.cells ?? {}).map(([fixture, samples]: [string, any]) => ({
 fixture, stage: "publicationToNodeObservationMs", measurementProtocol: "controlled-poll-phase", sourceEvidenceFile: args.stageFive, checkpointSha: stageFive.checkpointSha,
 runs: Array.from({ length: 3 }, (_, run) => samples.filter((sample: any) => sample.run === run).sort((a: any, b: any) => a.sample - b.sample).map((sample: any) => sample.observedLatencyMs))
}));
const generalRecords = (general.records ?? []).filter((record: any) => record.stage !== "publicationToNodeObservationMs").map((record: any) => ({ ...record, measurementProtocol: "end-to-end", sourceEvidenceFile: args.general, checkpointSha: stageFive.checkpointSha }));
const independenceRecords = (stageSixSeven.cells ?? []).flatMap((cell: any) => [
{ fixture: cell.fixture, stage: "notificationToCoherentModelMs", measurementProtocol: "controlled-stage6-stage7-independence", sourceEvidenceFile: args.stageSixSeven, checkpointSha: stageFive.checkpointSha, runs: cell.normalStageSixRuns },
{ fixture: cell.fixture, stage: "coherentModelToUsefulRenderMs", measurementProtocol: "controlled-stage6-stage7-independence", sourceEvidenceFile: args.stageSixSeven, checkpointSha: stageFive.checkpointSha, runs: cell.normalStageSevenRuns }
]);
const hasBothControlledStages = (fixture: string) =>
TIME_TO_ANSWER_MATRIX.some((cell) => cell.fixture === fixture && cell.stage === "notificationToCoherentModelMs") &&
TIME_TO_ANSWER_MATRIX.some((cell) => cell.fixture === fixture && cell.stage === "coherentModelToUsefulRenderMs");
const uncontaminatedGeneral = generalRecords.filter((record: any) => !hasBothControlledStages(record.fixture) || (record.stage !== "notificationToCoherentModelMs" && record.stage !== "coherentModelToUsefulRenderMs"));
writeFileSync(args.output, `${JSON.stringify(validateTimeToAnswerEvidence({ baseline: TIME_TO_ANSWER_BASELINE, environment: general.environment, records: [...uncontaminatedGeneral, ...stageFiveRecords, ...independenceRecords] }), null, 2)}\n`);
