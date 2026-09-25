/**
 * Full-capture Stage-5 plumbing integration guard (#335).
 *
 * The controller protocol is separately exercised with an HTTP fixture. This
 * guard binds that proven client helper to capture's actual Stage-5 function,
 * so a future local arm/mark/ack copy cannot silently put capture back on a
 * different ordering from `perf:phase-control`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("../..", import.meta.url).pathname);
const read = (path) => readFileSync(resolve(root, path), "utf8");

test("full capture Stage-5 routes arm, release, exact identity, and SSE witness through the phase-control helper", () => {
 const capture = read("tests/perf/capture.ts");
 const gate = read("tests/perf/phaseControl.ts");
 assert.match(capture, /import \{ armStageFivePublication, startStageFivePublicationController \} from "\.\/stageFivePublicationControl\.mjs"/);
 assert.match(gate, /import \{ armStageFivePublication, startStageFivePublicationController \} from "\.\/stageFivePublicationControl\.mjs"/);
 assert.match(capture, /const publication = phaseControlled\s*\? await armStageFivePublication\(/);
 assert.match(capture, /const actualPublication = await publication!\.release\(trigger\)/);
 assert.match(capture, /actualPublication\.revision !== observed\.revisions\[0\]/);
 assert.doesNotMatch(capture, /__stage-five-control\/(?:arm|mark|ack)/);
 assert.doesNotMatch(capture, /function (?:postControl|waitForPublicationAcknowledgement)/);
});
