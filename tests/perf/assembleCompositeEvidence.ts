/** Composite Baseline-4 assembly.  Sections remain separate until validation. */
import { readFileSync, writeFileSync } from "node:fs";
import { TIME_TO_ANSWER_BASELINE, TIME_TO_ANSWER_METHODOLOGY, validateTimeToAnswerEvidence } from "../../apps/web/src/lib/performance/timeToAnswerEvidence";

const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, all) => value.startsWith("--") ? [[value.slice(2), all[index + 1] ?? ""]] : []));
if (!args.general || !args.stageFive || !args.output) throw new Error("--general, --stageFive and --output are required");
const general = JSON.parse(readFileSync(args.general, "utf8"));
const stageFive = JSON.parse(readFileSync(args.stageFive, "utf8"));
if (general.environment?.methodologyVersion !== TIME_TO_ANSWER_METHODOLOGY || stageFive.methodologyVersion !== TIME_TO_ANSWER_METHODOLOGY) throw new Error("raw sections do not share the Baseline-4 methodology");
if (!stageFive.checkpointSha || general.environment?.sourceRevision !== stageFive.checkpointSha) throw new Error("raw sections do not share a committed checkpoint");
const stageFiveRecords = Object.entries(stageFive.cells ?? {}).map(([fixture, samples]: [string, any]) => ({
 fixture, stage: "publicationToNodeObservationMs", measurementProtocol: "controlled-poll-phase", sourceEvidenceFile: args.stageFive, checkpointSha: stageFive.checkpointSha,
 runs: Array.from({ length: 3 }, (_, run) => samples.filter((sample: any) => sample.run === run).sort((a: any, b: any) => a.sample - b.sample).map((sample: any) => sample.observedLatencyMs))
}));
const generalRecords = (general.records ?? []).filter((record: any) => record.stage !== "publicationToNodeObservationMs").map((record: any) => ({ ...record, measurementProtocol: "end-to-end", sourceEvidenceFile: args.general, checkpointSha: stageFive.checkpointSha }));
writeFileSync(args.output, `${JSON.stringify(validateTimeToAnswerEvidence({ baseline: TIME_TO_ANSWER_BASELINE, environment: general.environment, records: [...generalRecords, ...stageFiveRecords] }), null, 2)}\n`);
