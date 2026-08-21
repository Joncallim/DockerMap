import assert from "node:assert/strict";
import { test } from "node:test";
import { publishApiPayload, publishLogsResponse } from "../src/publication.js";

test("publication boundary redacts nested payloads and hostile display scalars", () => {
  const sentinel = "DOCKERMAP_TEST_FAKE_API_PUBLICATION_SECRET";
  const hostile = `token=${sentinel}\u202e\u200b\u001b\u2028\ufdd0`;
  const published = publishApiPayload({
    message: hostile,
    nested: { values: [hostile, null], message: hostile }
  });
  const serialized = JSON.stringify(published);

  assert.doesNotMatch(serialized, new RegExp(sentinel));
  assert.doesNotMatch(serialized, /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufdd0-\ufdef\ufeff]/u);
});

test("log publication sanitizes before filtering and compound cursor calculation", () => {
  const sentinel = "DOCKERMAP_TEST_FAKE_API_MOCK_LOG_SECRET";
  const hostile = `token=${sentinel}\u202e\u200b`;
  const page = publishLogsResponse(
    null,
    [
      { id: hostile, timestamp: 100, container: hostile, level: "info", message: hostile },
      { id: `${hostile}-2`, timestamp: 100, container: hostile, level: "info", message: hostile },
      { id: "older", timestamp: 99, container: "safe", level: "info", message: "safe redacted message" }
    ],
    "redacted",
    null,
    1
  );

  assert.equal(page.entries.length, 1, "filtering runs on published text");
  assert.equal(page.nextCursor, "100:1", "cursor follows the sanitized same-ms stream");
  assert.doesNotMatch(JSON.stringify(page), new RegExp(sentinel));
  assert.doesNotMatch(JSON.stringify(page), /[\u200b\u202e]/u);

  const rawSecretQuery = publishLogsResponse(
    null,
    [{ id: hostile, timestamp: 100, container: hostile, level: "info", message: hostile }],
    sentinel,
    null,
    10
  );
  assert.equal(rawSecretQuery.entries.length, 0, "raw secrets cannot influence filtering");

  const futureCursor = publishLogsResponse(
    null,
    [
      { id: "new", timestamp: 100, container: "safe", level: "info", message: "redacted" },
      { id: "older", timestamp: 99, container: "safe", level: "info", message: "redacted" }
    ],
    "redacted",
    "1000:9",
    1
  );
  assert.equal(futureCursor.nextCursor, "100:1", "cursor millis uses numeric equality, not a string prefix");
});
