/**
 * Benchmark-only daemon proxy for the Stage-5 phase sweep.  It is deliberately
 * in tests/perf: product processes never import, start, or route to it.
 *
 * The proxy learns the API poller from its real /daemon/health requests.  Once
 * the fixture-triggered daemon revision is witnessed, it keeps that exact
 * response unavailable until the requested offset after an observed poll, then
 * makes it available to the following real poll.  Thus the controller changes
 * neither the API timer nor the daemon; it only supplies a deterministic test
 * fixture publication barrier.
 */
import { createServer, request as httpRequest } from "node:http";

const json = (response, status, body) => {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  response.end(payload);
};

function upstreamGet(origin, path) {
  return new Promise((resolve, reject) => {
    const target = new URL(path, origin);
    const call = httpRequest(target, { method: "GET" }, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => {
        if ((response.statusCode ?? 500) >= 400) reject(new Error(`upstream ${response.statusCode} ${path}`));
        else resolve({ status: response.statusCode ?? 200, headers: response.headers, body });
      });
    });
    call.on("error", reject);
    call.end();
  });
}

/**
 * The only client protocol for a controlled Stage-5 publication. Keeping this
 * beside the test-only controller makes the runnable phase gate and the full
 * capture use the identical arm -> mark -> trigger -> exact-ack mechanism.
 *
 * `armStageFivePublication()` intentionally does not release immediately:
 * capture must connect its real API-SSE observer after arming but before the
 * trigger. `release()` marks first, so no triggered publication can enter the
 * controller's forbidden unmarked window.
 */
async function postControl(url, body) {
 const response = await fetch(url, {
 method: "POST",
 headers: { "content-type": "application/json" },
 body: JSON.stringify(body)
 });
 const payload = await response.json();
 if (!response.ok) throw new Error(`stage-5 publication controller rejected ${url}: ${JSON.stringify(payload)}`);
 return payload;
}

export async function armStageFivePublication({ controllerUrl, triggerId, requestedPhaseMs, previousRevision, timeoutMs }) {
 await postControl(`${controllerUrl}/__stage-five-control/arm`, { triggerId, requestedPhaseMs, previousRevision });
 return {
 async release(trigger) {
 await postControl(`${controllerUrl}/__stage-five-control/mark`, { triggerId });
 await trigger();
 const deadline = Date.now() + timeoutMs;
 while (Date.now() < deadline) {
 const response = await fetch(`${controllerUrl}/__stage-five-control/ack`);
 if (response.status === 200) {
 const ack = await response.json();
 if (ack.triggerId !== triggerId) throw new Error("stage-5 publication acknowledgement has the wrong trigger identity");
 if (ack.revision === previousRevision) throw new Error("stage-5 publication acknowledgement did not identify a new revision");
 return ack;
 }
 if (response.status >= 400) throw new Error(`stage-5 publication controller rejected ${triggerId}: ${await response.text()}`);
 await new Promise((done) => setTimeout(done, 2));
 }
 throw new Error(`stage-5 publication controller did not acknowledge ${triggerId}`);
 }
 };
}

export function startStageFivePublicationController({ upstream, port = 0, now = () => performance.now() }) {
  let stale = null;
  let armed = null;
  let failure = null;
  let timer = null;

  function fail(message) {
    failure = message;
    if (armed) armed.failure = message;
  }
  function arm(body) {
    if (armed && !armed.ack) throw new Error("a stage-5 publication is already armed");
    if (!body?.triggerId || !Number.isFinite(body.requestedPhaseMs) || !body.previousRevision) {
      throw new Error("arm requires triggerId, requestedPhaseMs and previousRevision");
    }
    failure = null;
    armed = { triggerId: String(body.triggerId), requestedPhaseMs: Number(body.requestedPhaseMs), previousRevision: String(body.previousRevision), marked: false, exact: null, pollAtMs: 0, releasedAtMs: 0, ack: null, failure: null };
    return armed;
  }
  function mark(body) {
    if (!armed || armed.triggerId !== body?.triggerId) throw new Error("the marked trigger is not the armed stage-5 publication");
    if (armed.failure) throw new Error(armed.failure);
    armed.marked = true;
    return armed;
  }
  async function health(response) {
    const upstreamResponse = await upstreamGet(upstream, "/daemon/health");
    const revision = JSON.parse(upstreamResponse.body).modelRevision;
    if (!stale) stale = upstreamResponse;
    if (!armed) return writeProxy(response, upstreamResponse);
    if (armed.failure) return json(response, 409, { error: armed.failure });
    if (revision !== armed.previousRevision && !armed.exact) {
      if (!armed.marked) {
        fail(`wrong publication ${revision} arrived before trigger ${armed.triggerId} was marked`);
        return json(response, 409, { error: failure });
      }
      armed.exact = { revision, response: upstreamResponse };
      // A changed response belongs to the trigger only after mark().  It is
      // retained, never substituted by a later revision.
    } else if (armed.exact && revision !== armed.previousRevision && revision !== armed.exact.revision) {
      fail(`wrong publication ${revision} followed trigger ${armed.triggerId}; exact revision is ${armed.exact.revision}`);
      return json(response, 409, { error: failure });
    }
    if (armed.exact && !armed.pollAtMs) {
      armed.pollAtMs = now();
      timer = setTimeout(() => {
        if (!armed || armed.failure || !armed.exact) return;
        armed.releasedAtMs = now();
        armed.ack = { triggerId: armed.triggerId, revision: armed.exact.revision, requestedPhaseMs: armed.requestedPhaseMs, pollAtMs: armed.pollAtMs, releasedAtMs: armed.releasedAtMs };
      }, armed.requestedPhaseMs);
      return writeProxy(response, stale);
    }
    if (armed.ack) return writeProxy(response, armed.exact.response);
    return writeProxy(response, stale);
  }
  function writeProxy(response, proxied) {
    response.writeHead(proxied.status, proxied.headers);
    response.end(proxied.body);
  }
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/__stage-five-control/arm" && request.method === "POST") {
        let text = "";
        for await (const chunk of request) text += chunk;
        json(response, 200, arm(JSON.parse(text || "{}")));
      } else if (request.url === "/__stage-five-control/mark" && request.method === "POST") {
        let text = "";
        for await (const chunk of request) text += chunk;
        json(response, 200, mark(JSON.parse(text || "{}")));
      } else if (request.url === "/__stage-five-control/ack") {
        if (!armed) json(response, 404, { error: "no armed stage-5 publication" });
        else if (armed.failure) json(response, 409, { error: armed.failure });
        else if (!armed.ack) json(response, 202, { pending: true });
        else json(response, 200, armed.ack);
      } else if (request.url?.startsWith("/daemon/health")) await health(response);
      else writeProxy(response, await upstreamGet(upstream, request.url ?? "/"));
    } catch (error) {
      json(response, 500, { error: String(error) });
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => { if (timer) clearTimeout(timer); server.close(done); })
  })));
}
