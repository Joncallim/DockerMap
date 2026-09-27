import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { httpListenerReady } from "./listenerReadiness.mjs";

async function serverFor(handler) {
const server = createServer(handler);
await new Promise((done) => server.listen(0, "127.0.0.1", done));
return {
url: `http://127.0.0.1:${server.address().port}`,
close: () => new Promise((done) => server.close(done))
};
}

test("listener readiness accepts a truthful HTTP 503", async () => {
const server = await serverFor((_request, response) => response.writeHead(503).end());
try {
assert.equal(await httpListenerReady(server.url, 150), true);
} finally {
await server.close();
}
});

test("listener readiness accepts an HTTP 200 JSON response", async () => {
const server = await serverFor((_request, response) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ready: true })));
try {
assert.equal(await httpListenerReady(server.url, 150), true);
} finally {
await server.close();
}
});

test("listener readiness rejects a closed port", async () => {
const server = await serverFor((_request, response) => response.end());
const url = server.url;
await server.close();
assert.equal(await httpListenerReady(url, 150), false);
});

test("listener readiness rejects a listener that never responds before its timeout", async () => {
const server = await serverFor(() => {});
try {
const startedAt = Date.now();
assert.equal(await httpListenerReady(server.url, 150), false);
assert.ok(Date.now() - startedAt < 1_000, "listener probe should use its explicit timeout");
} finally {
await server.close();
}
});
