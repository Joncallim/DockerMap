/**
 * Full-capture Stage-5 plumbing integration guard (#335).
 *
 * Unlike the phase-control gate, this exercises capture's own Stage-5 control
 * entrypoint against the controller and a real observer request. It proves the
 * capture path reaches the same arm -> mark -> trigger -> exact-ack mechanism.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { armCaptureStageFivePublication } from "./stageFiveCaptureControl.mjs";
import { startStageFivePublicationController } from "./stageFivePublicationControl.mjs";

async function upstream() {
 let revision = "before";
 const server = createServer((_request, response) => response.end(JSON.stringify({ modelRevision: revision })));
 await new Promise((done) => server.listen(0, "127.0.0.1", done));
 return {
 url: `http://127.0.0.1:${server.address().port}`,
 set: (next) => { revision = next; },
 close: () => new Promise((done) => server.close(done))
 };
}

test("capture Stage-5 control reaches the shared exact-ack mechanism after its observer connects", async () => {
 const daemon = await upstream();
 const controller = await startStageFivePublicationController({ upstream: daemon.url });
 try {
 // Capture opens the observer after arming and before its trigger/release.
 await fetch(`${controller.url}/daemon/health`);
 const publication = await armCaptureStageFivePublication({
 controllerUrl: controller.url,
 triggerId: "capture-stage-five-1",
 requestedPhaseMs: 20,
 previousRevision: "before",
 timeoutMs: 1_000
 });
 let observedRevision = "";
 const ackPromise = publication.release(() => daemon.set("capture-triggered"));
 // This is the controller-facing equivalent of capture's live API-SSE reader:
 // it witnesses only the exact revision released by the shared mechanism.
 await new Promise((done) => setTimeout(done, 5));
 await fetch(`${controller.url}/daemon/health`);
 const ack = await ackPromise;
 observedRevision = (await (await fetch(`${controller.url}/daemon/health`)).json()).modelRevision;
 assert.equal(ack.triggerId, "capture-stage-five-1");
 assert.equal(ack.revision, "capture-triggered");
 assert.equal(observedRevision, ack.revision);
 } finally {
 await controller.close();
 await daemon.close();
 }
});
