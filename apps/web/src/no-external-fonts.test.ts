import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import document from "../index.html?raw";

const hearthTokens = readFileSync(new URL("./hearth-tokens.css", import.meta.url), "utf8");

describe("production typography boundary", () => {
  it("does not require an external font CDN", () => {
    expect(document).not.toMatch(/fonts\.(googleapis|gstatic)\.com/i);
    expect(document).not.toMatch(/<link[^>]+rel=["']preconnect["']/i);
  });

  it("uses a committed public-safe Hearth token export", () => {
    expect(hearthTokens).toContain("04f32a9a48530142189bb6ec4c4209da8ffa71bc");
    expect(hearthTokens).toContain("--hearth-azure");
    expect(hearthTokens).not.toMatch(/url\(|https?:\/\/|@import/i);
  });
});
