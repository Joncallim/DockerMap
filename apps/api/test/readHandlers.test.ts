import assert from "node:assert/strict";
import test from "node:test";
import {
  buildComposeEditPlanPath,
  buildComposeScanPath,
  buildLogsPath,
  containerStatusKind,
} from "../src/readHandlers.js";

test("read-handler query builders preserve bounded daemon paths", () => {
  assert.equal(
    buildLogsPath({ service: "api", q: "timeout", cursor: "123:4", limit: "50" }),
    "/daemon/logs?service=api&q=timeout&cursor=123%3A4&limit=50",
  );
  assert.equal(
    buildComposeScanPath({ file: ["compose.yml", "compose.override.yml"] }),
    "/daemon/compose/scan?file=compose.yml&file=compose.override.yml",
  );
  assert.equal(
    buildComposeEditPlanPath({ file: "compose.yml", service: "api", mount: "0", target: "/data" }),
    "/daemon/compose/edit-plan?file=compose.yml&service=api&mount=0&target=%2Fdata",
  );
});

test("read-handler query builders reject widened or malformed values", () => {
  assert.throws(() => buildLogsPath({ service: "api/../../etc" }), { message: "Query parameter service must be a Docker container name" });
  assert.throws(() => buildLogsPath({ cursor: "1:2:3" }), { message: "Query parameter cursor must be `millis` or `millis:offset`" });
  assert.throws(() => buildComposeScanPath({ file: "\0" }), { message: "Compose scan file query values must be 512 characters or fewer" });
  assert.throws(() => buildComposeScanPath({ file: "" }), { message: "Compose scan file query values must be non-empty strings" });
  assert.throws(() => buildComposeEditPlanPath({ file: "compose.yml", service: "api", mount: "-1" }), { message: "Query parameter mount must be a zero-based integer" });
  assert.throws(
    () => buildComposeEditPlanPath({ file: "compose.yml", service: "a".repeat(129), mount: "0" }),
    { message: "Query parameter service must be 128 characters or fewer" },
  );
  assert.throws(() => buildLogsPath({ unexpected: "value" }), { message: "Query parameter unexpected is not supported" });
  assert.throws(() => buildLogsPath({ toString: "value" }), { message: "Query parameter toString is not supported" });
  assert.throws(() => buildComposeScanPath({ "file[]": "compose.yml" }), { message: "Query parameter file[] is not supported" });
});

test("status classifier lets explicit health evidence override an Up prefix", () => {
  assert.equal(containerStatusKind("Up 3 hours (healthy)"), "running");
  assert.equal(containerStatusKind("Up 3 hours (unhealthy)"), "attention");
  assert.equal(containerStatusKind("Exited (0) 2 hours ago"), "offline");
  assert.equal(containerStatusKind("custom provider text"), "attention");
});
