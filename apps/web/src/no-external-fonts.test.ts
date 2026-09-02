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

function customProperty(block: string, name: string) {
  const match = block.match(new RegExp(`\\s${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`Missing ${name}`);
  return match[1].trim();
}

function declaration(block: string, property: string) {
  const match = block.match(new RegExp(`\\s${property}:\\s*([^;]+);`));
  if (!match) throw new Error(`Missing ${property}`);
  return match[1].trim();
}
function expectCustomProperties(block: string, expected: Record<string, string>) {
  for (const [name, value] of Object.entries(expected)) {
    expect(customProperty(block, name), name).toBe(value);
  }
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

  it("exports the public roles used by common controls without importing a private design system", () => {
    for (const role of [
      "--hearth-radius-sm",
      "--hearth-space-2",
      "--hearth-type-sm",
      "--hearth-on-azure",
      "--hearth-ai-strong",
      "--hearth-on-ai"
    ]) expect(hearthTokens).toContain(role);

    for (const alias of [
      "--control-radius: var(--hearth-radius-sm)",
      "--control-pad-block: var(--hearth-space-2)",
      "--control-font-size: var(--hearth-type-sm)",
      "--action-gap: var(--hearth-space-2)"
    ]) expect(styles).toContain(alias);
  });

  it("keeps ordinary form and action geometry on the shared control roles", () => {
    for (const selector of [".auth-card input", ".auth-card button", ".topbar-search", ".service-select", ".copilot-input button", ".cmdk-item"]) {
      const rule = styles.slice(styles.indexOf(selector), styles.indexOf("}", styles.indexOf(selector)) + 1);
      expect(rule).toContain("var(--control-");
    }
    expect(styles).toContain(".map-controls button,");
    expect(styles).toContain("width: 30px;"); // topology canvas target: documented exception
  });

  it("keeps the shell and brand mark on public Azure and surface roles", () => {
    const rail = cssBlock(styles, ".rail");
    const brand = cssBlock(styles, ".brand-mark");

    expect(declaration(rail, "background")).toBe("var(--bg-2)");
    expect(declaration(rail, "border-right")).toBe("1px solid var(--border)");
    expect(declaration(brand, "background")).toBe("var(--hearth-azure-strong)");
    expect(declaration(brand, "color")).toBe("var(--hearth-on-azure)");
    expect(brand).not.toContain("gradient");
    expect(styles).not.toContain("#14b8a6");
  });

  it("keeps every shared dark and light surface, border, geometry, type, and AI role exact", () => {
    const dark = cssBlock(hearthTokens, ":root");
    const light = cssBlock(hearthTokens, ':root[data-theme="light"]');
    const appRoot = cssBlock(styles, ":root");
    const appLight = cssBlock(styles, ':root[data-theme="light"]');

    expectCustomProperties(dark, {
      "--hearth-canvas": "#0b0f1a",
      "--hearth-canvas-raised": "#141b23",
      "--hearth-surface": "#1b232c",
      "--hearth-surface-raised": "#202a33",
      "--hearth-surface-sunken": "#2b3443",
      "--hearth-border": "rgb(220 228 234 / 16%)",
      "--hearth-border-strong": "rgb(220 228 234 / 26%)",
      "--hearth-azure": "#168bff",
      "--hearth-azure-strong": "#006fd6",
      "--hearth-azure-text": "#a7d7fb",
      "--hearth-azure-soft": "rgb(22 139 255 / 18%)",
      "--hearth-on-azure": "#ffffff",
      "--hearth-ai": "#b9a4ff",
      "--hearth-ai-strong": "#7054b8",
      "--hearth-ai-soft": "#231c3a",
      "--hearth-on-ai": "#ffffff",
      "--hearth-shadow": "0 8px 24px rgb(0 0 0 / 20%)",
      "--hearth-radius-sm": "7px",
      "--hearth-radius-md": "11px",
      "--hearth-radius-lg": "16px",
      "--hearth-space-1": "4px",
      "--hearth-space-2": "8px",
      "--hearth-space-3": "12px",
      "--hearth-space-4": "16px",
      "--hearth-space-5": "24px",
      "--hearth-space-6": "32px",
      "--hearth-type-xs": "11px",
      "--hearth-type-sm": "12px",
      "--hearth-type-body": "14px",
      "--hearth-type-title": "26px"
    });
    expectCustomProperties(light, {
      "--hearth-canvas": "#f7f7fb",
      "--hearth-canvas-raised": "#f2f4f6",
      "--hearth-surface": "rgb(255 255 255 / 94%)",
      "--hearth-surface-raised": "rgb(250 251 253 / 94%)",
      "--hearth-surface-sunken": "#e2e8f0",
      "--hearth-border": "rgb(23 33 42 / 14%)",
      "--hearth-border-strong": "rgb(23 33 42 / 22%)",
      "--hearth-azure": "#0067b8",
      "--hearth-azure-strong": "#004f8f",
      "--hearth-azure-text": "#0067b8",
      "--hearth-azure-soft": "rgb(22 139 255 / 20%)",
      "--hearth-on-azure": "#ffffff",
      "--hearth-ai": "#6f42c1",
      "--hearth-ai-strong": "#5d32aa",
      "--hearth-ai-soft": "#f2ecff",
      "--hearth-on-ai": "#ffffff",
      "--hearth-shadow": "0 8px 24px rgb(27 36 43 / 8%)"
    });
    expectCustomProperties(appRoot, {
      "--surface": "var(--hearth-surface)",
      "--surface-2": "var(--hearth-surface-raised)",
      "--surface-3": "var(--hearth-surface-sunken)",
      "--border": "var(--hearth-border)",
      "--border-strong": "var(--hearth-border-strong)",
      "--r-sm": "var(--hearth-radius-sm)",
      "--r-md": "var(--hearth-radius-md)",
      "--r-lg": "var(--hearth-radius-lg)",
      "--s1": "var(--hearth-space-1)",
      "--s2": "var(--hearth-space-2)",
      "--s3": "var(--hearth-space-3)",
      "--s4": "var(--hearth-space-4)",
      "--s5": "var(--hearth-space-5)",
      "--s6": "var(--hearth-space-6)",
      "--type-xs": "var(--hearth-type-xs)",
      "--type-sm": "var(--hearth-type-sm)",
      "--type-body": "var(--hearth-type-body)",
      "--type-title": "var(--hearth-type-title)",
      "--control-radius": "var(--hearth-radius-sm)",
      "--control-pad-block": "var(--hearth-space-2)",
      "--control-pad-inline": "var(--hearth-space-3)",
      "--control-font-size": "var(--hearth-type-sm)",
      "--control-background": "var(--hearth-surface)",
      "--control-border": "var(--hearth-border)",
      "--action-gap": "var(--hearth-space-2)"
    });
    expectCustomProperties(appLight, {
      "--surface": "var(--hearth-surface)",
      "--surface-2": "var(--hearth-surface-raised)",
      "--surface-3": "var(--hearth-surface-sunken)",
      "--border": "var(--hearth-border)",
      "--border-strong": "var(--hearth-border-strong)",
      "--shadow": "var(--hearth-shadow)"
    });
    expect(appLight).not.toMatch(/--control-(?:background|border|radius|pad|font)/);
  });

  it("leaves operational state and map variables DockerMap-local", () => {
    const dark = cssBlock(styles, ":root");
    const light = cssBlock(styles, ':root[data-theme="light"]');
    const map = cssBlock(styles, ".map");

    expectCustomProperties(dark, {
      "--s-healthy": "#50df95",
      "--s-warning": "#ffd166",
      "--s-degraded": "#ff9f43",
      "--s-offline": "#ff6b6b",
      "--s-updating": "#7db4ff",
      "--s-unknown": "#9ba7b8"
    });
    expectCustomProperties(light, {
      "--s-healthy": "#08783e",
      "--s-warning": "#7a4b00",
      "--s-degraded": "#984500",
      "--s-offline": "#b42318",
      "--s-updating": "#1d4ed8",
      "--s-unknown": "#526174"
    });
    expectCustomProperties(map, {
      "--map-ink": "#f8fafc",
      "--map-ink-soft": "#dce7f3",
      "--map-muted": "#a9b6c7",
      "--map-panel": "rgba(14, 17, 22, 0.9)"
    });
    expect(map).not.toContain("--hearth-");
  });

  it("uses Hearth AI roles for Copilot focus and its primary action", () => {
    const input = cssBlock(styles, ".copilot-input");
    const focus = cssBlock(styles, ".copilot-input input:focus-visible");
    const action = cssBlock(styles, ".copilot-input button");

    expect(declaration(input, "border")).toBe("1px solid color-mix(in srgb, var(--hearth-ai) 42%, var(--border-strong))");
    expect(declaration(input, "background")).toBe("color-mix(in srgb, var(--hearth-ai-soft) 62%, var(--surface))");
    expect(declaration(focus, "outline")).toBe("2px solid var(--hearth-ai)");
    expect(declaration(action, "background")).toBe("var(--hearth-ai-strong)");
    expect(declaration(action, "color")).toBe("var(--hearth-on-ai)");
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
