import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { armStageFivePublication, startStageFivePublicationController } from "./stageFivePublicationControl.mjs";

async function upstream() {
  let revision = "before";
  const server = createServer((_request, response) => response.end(JSON.stringify({ modelRevision: revision })));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${server.address().port}`, set: (value) => (revision = value), close: () => new Promise((done) => server.close(done)) };
}
async function post(url, body) { return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }

test("shared release helper marks before it triggers and returns the exact acknowledged publication", async () => {
  const daemon = await upstream();
  const control = await startStageFivePublicationController({ upstream: daemon.url });
  try {
    assert.equal((await fetch(`${control.url}/daemon/health`)).status, 200);
 const publication = await armStageFivePublication({
 controllerUrl: control.url,
 triggerId: "generation-1",
 requestedPhaseMs: 20,
 previousRevision: "before",
 timeoutMs: 1_000
 });
 let triggered = false;
 const ackPromise = publication.release(() => { triggered = true; daemon.set("triggered"); });
 assert.equal((await (await fetch(`${control.url}/daemon/health`)).json()).modelRevision, "before");
 const ack = await ackPromise;
 assert.equal(triggered, true);
    assert.equal(ack.triggerId, "generation-1");
    assert.equal(ack.revision, "triggered");
    assert.equal((await (await fetch(`${control.url}/daemon/health`)).json()).modelRevision, "triggered");
  } finally { await control.close(); await daemon.close(); }
});

test("wrong publication before the marked trigger is RED", async () => {
  const daemon = await upstream();
  const control = await startStageFivePublicationController({ upstream: daemon.url });
  try {
    await fetch(`${control.url}/daemon/health`);
    await post(`${control.url}/__stage-five-control/arm`, { triggerId: "generation-2", requestedPhaseMs: 20, previousRevision: "before" });
    daemon.set("wrong-publication");
    assert.equal((await fetch(`${control.url}/daemon/health`)).status, 409);
    const ack = await fetch(`${control.url}/__stage-five-control/ack`);
    assert.equal(ack.status, 409);
  } finally { await control.close(); await daemon.close(); }
});
