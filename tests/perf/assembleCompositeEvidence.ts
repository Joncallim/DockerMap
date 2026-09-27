/** Composite Baseline-4 assembly.  Sections remain separate until validation. */
import { readFileSync, writeFileSync } from "node:fs";
import { TIME_TO_ANSWER_BASELINE, TIME_TO_ANSWER_CONTROLLED_POLL_MATRIX, TIME_TO_ANSWER_END_TO_END_MATRIX, TIME_TO_ANSWER_METHODOLOGY, validateTimeToAnswerEvidence } from "../../apps/web/src/lib/performance/timeToAnswerEvidence";

export function assembleCompositeEvidence(general: any, stageFive: any, stageSixSeven: any | null, sources: { general: string; stageFive: string; stageSixSeven?: string }) {
 if (general.environment?.methodologyVersion !== TIME_TO_ANSWER_METHODOLOGY || stageFive.methodologyVersion !== TIME_TO_ANSWER_METHODOLOGY || (stageSixSeven && stageSixSeven.methodologyVersion !== TIME_TO_ANSWER_METHODOLOGY)) throw new Error("raw sections do not share the Baseline-4 methodology");
 if (!stageFive.checkpointSha || (stageSixSeven && stageFive.checkpointSha !== stageSixSeven.checkpointSha) || general.environment?.sourceRevision !== stageFive.checkpointSha) throw new Error("raw sections do not share a committed checkpoint");
 const stageFiveFixtures = new Set(TIME_TO_ANSWER_CONTROLLED_POLL_MATRIX.map((cell) => cell.fixture));
 const stageFiveRecords = Object.entries(stageFive.cells ?? {}).map(([fixture, samples]: [string, any]) => ({
 fixture, stage: "publicationToNodeObservationMs", measurementProtocol: "controlled-poll-phase", sourceEvidenceFile: sources.stageFive, checkpointSha: stageFive.checkpointSha,
 runs: Array.from({ length: 3 }, (_, run) => samples.filter((sample: any) => sample.run === run).sort((a: any, b: any) => a.sample - b.sample).map((sample: any) => sample.observedLatencyMs))
}));
 if (stageFiveRecords.length !== stageFiveFixtures.size || stageFiveRecords.some((record) => !stageFiveFixtures.delete(record.fixture))) throw new Error("Stage-5 controlled evidence does not cover the required fixtures exactly once");
 const controlledFixtures = new Set(TIME_TO_ANSWER_END_TO_END_MATRIX.filter((cell) => cell.stage === "notificationToCoherentModelMs").map((cell) => cell.fixture).filter((fixture) => TIME_TO_ANSWER_END_TO_END_MATRIX.some((cell) => cell.fixture === fixture && cell.stage === "coherentModelToUsefulRenderMs")));
 for (const record of general.records ?? []) {
 if (!TIME_TO_ANSWER_END_TO_END_MATRIX.some((cell) => cell.fixture === record.fixture && cell.stage === record.stage)) throw new Error(`general evidence contains a non-end-to-end cell: ${record.fixture}/${record.stage}`);
 }
 const generalRecords = (general.records ?? []).map((record: any) => ({ ...record, measurementProtocol: "end-to-end", sourceEvidenceFile: sources.general, checkpointSha: stageFive.checkpointSha }));
 if (stageSixSeven === null) return validateTimeToAnswerEvidence({ baseline: TIME_TO_ANSWER_BASELINE, environment: general.environment, records: [...generalRecords, ...stageFiveRecords] });
 if (stageSixSeven.measurementProtocol !== "controlled-stage6-stage7-seam-isolation" || !Array.isArray(stageSixSeven.cells) || !stageSixSeven.independenceEvidence || stageSixSeven.independenceEvidence.verdict !== "PASS" || stageSixSeven.independenceEvidence.limitation !== "publication-level causal identity unavailable" || stageSixSeven.independenceEvidence.validatesDaemonToBrowserAttribution !== false) throw new Error("Stage-6/7 seam-isolation evidence is invalid");
const expectedFixtures = [...controlledFixtures].sort();
const receivedFixtures = stageSixSeven.cells.map((cell: any) => cell.fixture).sort();
if (JSON.stringify(receivedFixtures) !== JSON.stringify(expectedFixtures)) throw new Error("Stage-6/7 independence evidence does not cover the required fixtures exactly once");
for (const cell of stageSixSeven.cells) {
 if (!Array.isArray(cell.normalStageSixRuns) || !Array.isArray(cell.normalStageSevenRuns) || !cell.controlEvidence || cell.controlEvidence.delayMs !== 250 || cell.controlEvidence.acceptanceSeam !== "observed" || !Array.isArray(cell.controlEvidence.samples) || "triggerRevision" in cell.controlEvidence || cell.controlEvidence.samples.some((sample: any) => !sample.acceptedRevision || sample.snapshotRevision !== sample.acceptedRevision || sample.runtimeMapRevision !== sample.acceptedRevision || sample.delayAppliedAfterAcceptance !== true || sample.delayStartedAfterAcceptance !== true || "triggerRevision" in sample || "triggerId" in sample || "acknowledgement" in sample)) throw new Error(`Stage-6/7 seam-isolation evidence is incomplete or makes a publication-attribution claim for ${cell.fixture}`);
}
 return validateTimeToAnswerEvidence({ baseline: TIME_TO_ANSWER_BASELINE, environment: general.environment, records: [...generalRecords, ...stageFiveRecords] });
}

const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, all) => value.startsWith("--") ? [[value.slice(2), all[index + 1] ?? ""]] : []));
if (!args.general || !args.stageFive || !args.output) throw new Error("--general, --stageFive and --output are required");
const general = JSON.parse(readFileSync(args.general, "utf8"));
const stageFive = JSON.parse(readFileSync(args.stageFive, "utf8"));
const stageSixSeven = args.stageSixSeven ? JSON.parse(readFileSync(args.stageSixSeven, "utf8")) : null;
writeFileSync(args.output, `${JSON.stringify(assembleCompositeEvidence(general, stageFive, stageSixSeven, { general: args.general, stageFive: args.stageFive, stageSixSeven: args.stageSixSeven }), null, 2)}\n`);
writeFileSync(`${args.output}.supporting-evidence.json`, `${JSON.stringify({ stageSixSevenSeamIsolation: stageSixSeven ? { verdict: stageSixSeven.independenceEvidence?.verdict ?? "FAIL", limitation: "publication-level causal identity unavailable", validatesDaemonToBrowserAttribution: false, sourceEvidenceFile: args.stageSixSeven } : { verdict: "FAIL", limitation: "publication-level causal identity unavailable", validatesDaemonToBrowserAttribution: false } }, null, 2)}\n`);
