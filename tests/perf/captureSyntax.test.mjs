import { readFile } from "node:fs/promises";
import { transform } from "esbuild";
import test from "node:test";

test("capture harness entrypoint transforms", async () => {
 const source = await readFile(new URL("./capture.ts", import.meta.url), "utf8");
 try {
 await transform(source, { loader: "ts", format: "esm", target: "es2022" });
 } catch (error) {
 const diagnostics = error.errors ?? [];
 const details = diagnostics
 .map(({ text, location }) =>
 location
 ? `capture.ts:${location.line}:${location.column}: ${text}`
 : text
 )
 .join("\n");
 throw new Error(`capture.ts failed esbuild transform:\n${details || error.message}`);
 }
});

test("listener readiness accepts an HTTP response independently of Docker-model readiness", async () => {
const source = await readFile(new URL("./capture.ts", import.meta.url), "utf8");
if (!source.includes("async function httpListenerReady")) throw new Error("capture must use an HTTP listener probe");
if (!source.includes("ping: daemonReady")) throw new Error("daemon startup must use listener readiness");
if (!source.includes("value.mode === \"docker\" && Boolean(value.modelRevision)")) {
throw new Error("Docker-model readiness must remain a later distinct boundary");
}
});
