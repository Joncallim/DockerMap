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

describe("shared technical evidence rows", () => {
  it("uses existing shared spacing and typography roles", () => {
    const row = cssBlock(".kv");
    const label = cssBlock(".kv-label");
    const value = cssBlock(".kv-value");

    expect(row).toContain("gap: var(--s4)");
    expect(row).toContain("padding: var(--s2) 0");
    expect(row).toContain("border-bottom: 1px solid var(--border)");
    expect(label).toContain("color: var(--muted)");
    expect(label).toContain("font-size: var(--type-sm)");
    expect(value).toContain("color: var(--ink)");
    expect(value).toContain("text-align: right");
  });

  it("preserves long technical-value recovery at narrow widths", () => {
    expect(styles).toMatch(/\.svc-name,[\s\S]*?\.kv-value,[\s\S]*?\.screen-title\s*\{\s*min-width:\s*0;\s*overflow-wrap:\s*anywhere;\s*\}/);
  });
});
