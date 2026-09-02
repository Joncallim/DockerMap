import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

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

function expectAlias(block: string, name: string, value: string) {
  expect(customProperty(block, name)).toBe(value);
  expect(block.match(new RegExp(`\\s${name}:`, "g")), `${name} must not be redefined`).toHaveLength(1);
}

describe("shared panel and metric typography", () => {
  it("uses defined Hearth-aligned geometry and type aliases", () => {
    const root = cssBlock(":root");

    expectAlias(root, "--s1", "var(--hearth-space-1)");
    expectAlias(root, "--type-xs", "var(--hearth-type-xs)");
    expectAlias(root, "--type-sm", "var(--hearth-type-sm)");
    expectAlias(root, "--type-body", "var(--hearth-type-body)");
    expectAlias(root, "--type-title", "var(--hearth-type-title)");
    expectAlias(root, "--r-md", "var(--hearth-radius-md)");

    expect(cssBlock(".metric")).toContain("gap: var(--s1)");
    expect(cssBlock(".metric")).toContain("border-radius: var(--r-md)");
    expect(cssBlock(".metric-label")).toContain("font-size: var(--type-xs)");
    expect(cssBlock(".metric-value")).toContain("font-size: var(--type-title)");
    expect(cssBlock(".metric-sub")).toContain("font-size: var(--type-sm)");
    expect(cssBlock(".panel-title")).toContain("font-size: var(--type-body)");
    expect(cssBlock(".panel-hint")).toContain("font-size: var(--type-xs)");
  });

  it("leaves operational and topology styling separate", () => {
    expect(cssBlock(".state-pill")).toContain("color: var(--c, var(--s-unknown))");
    expect(cssBlock(".map")).toContain("--map-panel");
    expect(cssBlock(".suggest-chip")).toContain("border-radius: 999px");
  });
});
