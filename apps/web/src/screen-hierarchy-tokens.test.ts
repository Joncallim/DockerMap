import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

function cssBlock(selector: string, from = 0) {
  const start = styles.indexOf(`${selector} {`, from);
  if (start < 0) throw new Error(`Missing CSS rule for ${selector}`);
  const end = styles.indexOf("}", start);
  if (end < 0) throw new Error(`Unclosed CSS rule for ${selector}`);
  return styles.slice(start, end + 1);
}

describe("shared screen hierarchy and supporting copy", () => {
  it("uses the established Hearth-aligned roles for primary, overline, and supporting text", () => {
    const eyebrow = cssBlock(".eyebrow");
    const mutedLine = cssBlock(".muted-line");
    const title = cssBlock(".screen-title");

    expect(title).toContain("font-size: var(--type-title)");
    expect(eyebrow).toContain("font-size: var(--type-xs)");
    expect(eyebrow).toContain("text-transform: uppercase");
    expect(eyebrow).toContain("color: var(--muted-deep)");
    expect(mutedLine).toContain("font-size: var(--type-sm)");
    expect(mutedLine).toContain("color: var(--muted)");
    expect(mutedLine).toContain("margin: 0");
  });

  it("keeps header spacing and narrow-screen recovery on the shared scaffold", () => {
    expect(cssBlock(".screen")).toContain("gap: var(--s5)");
    expect(cssBlock(".screen-head")).toContain("gap: var(--s4)");

    const narrow = cssBlock(".screen-head", styles.indexOf("@media (max-width: 900px)"));
    expect(narrow).toContain("align-items: flex-start");
    expect(narrow).toContain("flex-direction: column");
    expect(styles).toContain(".detail-id, .screen-title { min-width: 0; overflow-wrap: anywhere; }");
  });
});
