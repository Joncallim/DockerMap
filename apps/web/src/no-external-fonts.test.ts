import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import document from "../index.html?raw";

const hearthTokens = readFileSync(new URL("./hearth-tokens.css", import.meta.url), "utf8");
const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

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

  it("exports geometry and AI roles without widening the public boundary", () => {
    for (const role of [
      "--hearth-radius-sm",
      "--hearth-space-4",
      "--hearth-type-body",
      "--hearth-shadow",
      "--hearth-ai-strong",
      "--hearth-on-ai"
    ]) expect(hearthTokens).toContain(role);

    expect(styles).toContain("--r-md: var(--hearth-radius-md)");
    expect(styles).toContain("--s4: var(--hearth-space-4)");
    expect(styles).toContain("--type-body: var(--hearth-type-body)");
    expect(styles).toContain("--shadow: var(--hearth-shadow)");
  });
});
