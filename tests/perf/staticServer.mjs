/**
 * Minimal deterministic static file server for the benchmark (#335).
 *
 * It serves a built directory on a private port with SPA history fallback. It
 * exists so the capture harness does not depend on a dev server's caching,
 * HMR, or transform behaviour: the numbers must come from built artifacts.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

export async function startStaticServer({ directory, port, host = "127.0.0.1" }) {
  const root = resolve(directory);
  const server = createServer(async (request, response) => {
    const requested = (request.url ?? "/").split("?")[0];
    const decoded = decodeURIComponent(requested);
    const relative = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
    let target = join(root, relative);
    // Path traversal must never escape the served root.
    if (!target.startsWith(root)) target = join(root, "index.html");
    try {
      const info = await stat(target);
      if (info.isDirectory()) target = join(target, "index.html");
    } catch {
      target = join(root, "index.html");
    }
    try {
      const body = await readFile(target);
      response.writeHead(200, {
        "content-type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream",
        "content-length": body.byteLength,
        // No caching: every benchmark run must load the same bytes from cold.
        "cache-control": "no-store"
      });
      response.end(body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
    }
  });
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, host, done);
  });
  return {
    port,
    url: `http://${host}:${port}`,
    async close() {
      await new Promise((done) => server.close(done));
    }
  };
}

/** Ask the OS for a free port so parallel benchmark runs cannot collide. */
export async function reservePort() {
  const { createServer: create } = await import("node:net");
  const probe = create();
  await new Promise((done) => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}
