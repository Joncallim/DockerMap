import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import document from "../index.html?raw";

const hearthTokens = readFileSync(new URL("./hearth-tokens.css", import.meta.url), "utf8");
const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

function cssBlock(selector: string) {
  const start = styles.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Missing CSS rule for ${selector}`);
  const end = styles.indexOf("}", start);
  if (end < 0) throw new Error(`Unclosed CSS rule for ${selector}`);
  return styles.slice(start, end + 1);
}

function customProperty(block: string, name: string) {
  const match = block.match(new RegExp(`\\s${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`Missing ${name}`);
  return match[1].trim();
}

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

  it("keeps neutral metadata capsules on the public Hearth scale", () => {
    const root = cssBlock(":root");
    const tag = cssBlock(".tag");
    const tagWrap = cssBlock(".tag-wrap");
    const reference = cssBlock(".ref-chip");

    for (const rule of [tag, reference]) {
      expect(rule).toContain("gap: var(--s1)");
      expect(rule).toContain("font-size: var(--type-xs)");
    }
    expect(tag).toContain("padding: 2px var(--s2)");
    expect(tag).toContain("border-radius: var(--r-sm)");
    expect(tagWrap).toContain("gap: var(--s1)");
    expect(reference).toContain("padding: var(--s1) var(--s2)");
    expect(reference).toContain("border-radius: 999px");
    expect(customProperty(root, "--s1")).toBe("4px");
    expect(customProperty(root, "--s2")).toBe("8px");
    expect(customProperty(root, "--r-sm")).toBe("7px");
    expect(customProperty(root, "--type-xs")).toBe("11px");
  });

  it("keeps state, topology selection, and AI suggestion capsules distinct", () => {
    const state = cssBlock(".state-pill");
    const filter = cssBlock(".filter-chip");
    const suggestion = cssBlock(".suggest-chip");

    expect(state).toContain("color: var(--c, var(--s-unknown))");
    expect(filter).toContain("text-transform: capitalize");
    expect(suggestion).toContain("border-radius: 999px");
  });
});
