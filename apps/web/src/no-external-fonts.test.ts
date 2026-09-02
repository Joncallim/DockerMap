import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import document from "../index.html?raw";

const hearthTokens = readFileSync(new URL("./hearth-tokens.css", import.meta.url), "utf8");
const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

function cssBlock(source: string, selector: string, from = 0) {
  const start = source.indexOf(`${selector} {`, from);
  if (start < 0) throw new Error(`Missing CSS rule for ${selector}`);
  const end = source.indexOf("}", start);
  if (end < 0) throw new Error(`Unclosed CSS rule for ${selector}`);
  return source.slice(start, end + 1);
}

function declaration(block: string, property: string) {
  const match = block.match(new RegExp(`\\s${property}:\\s*([^;]+);`));
  if (!match) throw new Error(`Missing ${property}`);
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
    expect(hearthTokens.match(/--hearth-on-azure:/g)).toHaveLength(2);
    expect(hearthTokens).not.toMatch(/url\(|https?:\/\/|@import/i);
  });

  it("uses Hearth canvas, surface, and Azure roles for shell navigation", () => {
    const rail = cssBlock(styles, ".rail");
    const brand = cssBlock(styles, ".brand-mark");
    const hover = cssBlock(styles, ".nav-item:hover");
    const active = cssBlock(styles, ".nav-item.active");
    const activeIcon = cssBlock(styles, ".nav-item.active svg");
    const topbar = cssBlock(styles, ".topbar");

    expect(declaration(rail, "background")).toBe("var(--hearth-canvas-raised)");
    expect(declaration(brand, "background")).toBe("var(--hearth-azure-strong)");
    expect(declaration(brand, "color")).toBe("var(--hearth-on-azure)");
    expect(declaration(hover, "background")).toBe("var(--hearth-surface-raised)");
    expect(declaration(active, "background")).toBe("var(--hearth-azure-soft)");
    expect(declaration(activeIcon, "color")).toBe("var(--hearth-azure)");
    expect(declaration(topbar, "background")).toBe("var(--hearth-surface)");
    expect(styles).not.toContain("#14b8a6");
  });

  it("keeps narrow navigation scrollable without changing graph or operational colors", () => {
    const narrowNavigation = cssBlock(styles, ".nav", styles.indexOf("@media (max-width: 900px)"));
    const map = cssBlock(styles, ".map");
    const root = cssBlock(styles, ":root");

    expect(declaration(narrowNavigation, "overflow-x")).toBe("auto");
    expect(declaration(narrowNavigation, "overscroll-behavior-inline")).toBe("contain");
    expect(styles).toContain("var(--hearth-canvas-raised) 42%");
    expect(declaration(map, "--map-panel")).toBe("rgba(14, 17, 22, 0.9)");
    expect(declaration(root, "--s-healthy")).toBe("#50df95");
    expect(declaration(root, "--s-offline")).toBe("#ff6b6b");
  });
});
