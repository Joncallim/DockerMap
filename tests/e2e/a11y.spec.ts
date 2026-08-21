import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { startMockStack, type Stack } from "./dockermapHarness";

type Theme = "dark" | "light";

const themes: Theme[] = ["dark", "light"];
const coreRoutes = [
  ["home", "/"],
  ["map", "/map"],
  ["runtime", "/runtime"],
  ["changes", "/changes"],
  ["copilot", "/copilot"],
  ["networking", "/networking"],
  ["network-detail", "/networks/application"],
  ["storage", "/storage"],
  ["volume-detail", "/volumes/postgres_data"],
  ["images", "/images"],
  ["image-detail", "/images/python%3A3.11-slim"],
  ["logs", "/logs"],
  ["compose", "/compose"],
  ["diagnostics", "/diagnostics"],
  ["settings", "/settings"],
  ["service-detail", "/services/postgres"],
  ["not-found", "/not-a-real-route"]
] as const;

let stack: Stack;

test.describe("responsive and accessibility matrix", () => {
  test.beforeAll(async () => {
    stack = await startMockStack();
  });
  test.afterAll(async () => {
    await stack.stop();
  });

  async function withPage(browser: Browser, theme: Theme, run: (page: Page) => Promise<void>) {
    const context = await browser.newContext({ colorScheme: theme });
    const page = await context.newPage();
    try {
      await run(page);
    } finally {
      await context.close();
    }
  }

  async function openRoute(page: Page, route: string, theme: Theme) {
    await page.goto(`${stack.webUrl}${route}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.locator("main h1").first()).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  }

  async function attachAxe(page: Page, testInfo: TestInfo, target: string) {
    const results = await new AxeBuilder({ page }).analyze();
    const sorted = {
      ...results,
      violations: [...results.violations].sort((left, right) => left.id.localeCompare(right.id))
    };
    await testInfo.attach(`axe-${target}.json`, { body: JSON.stringify(sorted, null, 2), contentType: "application/json" });
    const details = sorted.violations
      .flatMap((violation) => violation.nodes.map((node) => `${target} | ${violation.impact ?? "unknown"} | ${violation.id} | ${node.target.join(", ")}`))
      .join("\n");
    expect(sorted.violations, details || `${target}: no violations`).toEqual([]);
  }

  for (const theme of themes) {
    for (const [name, route] of coreRoutes) {
      test(`axe core ${theme}: ${name}`, async ({ browser }, testInfo) => {
        await withPage(browser, theme, async (page) => {
          await openRoute(page, route, theme);
          await attachAxe(page, testInfo, `${theme}-${name}`);
        });
      });
    }

    test(`axe ${theme}: token screen`, async ({ browser }, testInfo) => {
      await withPage(browser, theme, async (page) => {
        await page.goto(stack.webUrl, { waitUntil: "domcontentloaded" });
        await page.evaluate(() => window.dispatchEvent(new Event("dockermap:bearer-unauthorized")));
        await expect(page.getByRole("heading", { name: "Enter your API token" })).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await attachAxe(page, testInfo, `${theme}-token`);
      });
    });

    test(`axe ${theme}: service tabs and configuration states`, async ({ browser }, testInfo) => {
      await withPage(browser, theme, async (page) => {
        await openRoute(page, "/services/postgres", theme);
        for (const tab of ["Overview", "Dependencies", "Resources", "Logs", "Configuration"]) {
          await page.getByRole("tab", { name: tab }).click();
          const activeId = await page.getByRole("tab", { name: tab }).getAttribute("id");
          await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", activeId);
          await attachAxe(page, testInfo, `${theme}-service-${tab.toLowerCase()}`);
        }
        const internals = page.getByRole("button", { name: "Show service internals" });
        await internals.click();
        await expect(page.getByRole("button", { name: "Hide service internals" })).toHaveAttribute("aria-expanded", "true");
        await attachAxe(page, testInfo, `${theme}-service-configuration-expanded`);
      });
    });

    for (const [name, route] of [["network", "/networks/application"], ["volume", "/volumes/postgres_data"], ["image", "/images/python%3A3.11-slim"]] as const) {
      test(`axe ${theme}: ${name} disclosure states`, async ({ browser }, testInfo) => {
        await withPage(browser, theme, async (page) => {
          await openRoute(page, route, theme);
          const disclosure = page.locator("[aria-controls]").first();
          await expect(disclosure).toHaveAttribute("aria-expanded", "false");
          await attachAxe(page, testInfo, `${theme}-${name}-collapsed`);
          await disclosure.click();
          await expect(disclosure).toHaveAttribute("aria-expanded", "true");
          await attachAxe(page, testInfo, `${theme}-${name}-expanded`);
        });
      });
    }

    test(`axe ${theme}: command palette`, async ({ browser }, testInfo) => {
      await withPage(browser, theme, async (page) => {
        await openRoute(page, "/", theme);
        await page.keyboard.press("Control+k");
        await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
        await attachAxe(page, testInfo, `${theme}-command-palette`);
      });
    });
  }

  test("keyboard focus, selections, and aria controls", async ({ browser }) => {
    await withPage(browser, "dark", async (page) => {
      await openRoute(page, "/", "dark");
      await page.keyboard.press("Tab");
      await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("main")).toBeFocused();

      await page.getByRole("link", { name: "Service Map", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Service Map" })).toBeFocused();
      await page.getByRole("button", { name: "postgres, healthy" }).focus();
      await page.keyboard.press("Space");
      const clear = page.getByRole("button", { name: /Clear postgres service selection/ });
      await expect(clear).toBeVisible();
      await clear.click();
      await expect(page.getByRole("button", { name: "postgres, healthy" })).toBeFocused();
      await page.getByRole("button", { name: "Attention" }).click();
      await expect(page.getByRole("button", { name: /Clear postgres service selection/ })).toBeHidden();
      await page.getByRole("button", { name: "All", exact: true }).click();

      await openRoute(page, "/services/postgres", "dark");
      const overview = page.getByRole("tab", { name: "Overview" });
      await overview.focus();
      await page.keyboard.press("ArrowRight");
      await expect(page.getByRole("tab", { name: "Dependencies" })).toBeFocused();
      await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("tab", { name: "Dependencies" })).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("End");
      await expect(page.getByRole("tab", { name: "Configuration" })).toBeFocused();
      await page.keyboard.press(" ");
      const disclosure = page.getByRole("button", { name: "Show service internals" });
      await expect(disclosure).toBeVisible();
      await disclosure.press("Enter");
      await expect(page.getByRole("button", { name: "Hide service internals" })).toHaveAttribute("aria-expanded", "true");

      await page.keyboard.press("Control+k");
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await expect(palette.getByRole("combobox")).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(palette.getByRole("combobox")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(palette).toBeHidden();
      await expect(page.getByRole("button", { name: "Hide service internals" })).toBeFocused();

      await page.keyboard.press("Control+k");
      await page.getByRole("combobox").fill("Runtime Map");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { name: "Runtime Map" })).toBeFocused();
      const runtimeNode = page.locator("button.runtime-node-btn").first();
      await runtimeNode.click();
      await expect(runtimeNode).toHaveAttribute("aria-pressed", "true");
      const runtimeClear = page.getByRole("button", { name: /Clear .* runtime selection/ });
      await runtimeClear.click();
      await expect(runtimeNode).toBeFocused();

      for (const control of await page.locator("[aria-controls]").all()) {
        const id = await control.getAttribute("aria-controls");
        expect(id && await page.locator(`[id="${id}"]`).count()).toBe(1);
      }
    });
  });

  for (const width of [800, 640]) {
    test(`responsive ${width}px has no page overflow or clipped controls`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: "light" });
      const page = await context.newPage();
      try {
        for (const [, route] of coreRoutes) {
          await openRoute(page, route, "light");
          const layout = await page.locator(".map-layout").evaluateAll((layouts) => layouts.map((layout) => getComputedStyle(layout).gridTemplateColumns));
          for (const columns of layout) expect(columns.split(" ").length).toBe(1);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          expect(overflow, `${route} overflow at ${width}px`).toBeLessThanOrEqual(1);
        }
        await openRoute(page, "/services/postgres", "light");
        await page.getByRole("tab", { name: "Configuration" }).click();
        await page.getByRole("button", { name: "Show service internals" }).click();
        await openRoute(page, "/logs", "light");
        await openRoute(page, "/compose", "light");
        await openRoute(page, "/diagnostics", "light");
        await openRoute(page, "/settings", "light");
      } finally {
        await context.close();
      }
    });
  }

  test("non-text contrast keeps state dots, focus rings, and map tracks at 3:1", async ({ browser }) => {
    for (const theme of themes) {
      await withPage(browser, theme, async (page) => {
        await openRoute(page, "/map", theme);
        const ratios = await page.evaluate(() => {
          const rgb = (value: string) => {
            const hex = value.trim();
            if (/^#[0-9a-f]{6}$/i.test(hex)) return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
            return hex.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number) ?? [];
          };
          const luminance = (color: number[]) => {
            const [red, green, blue] = color.map((channel) => {
              const normalized = channel / 255;
              return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
          };
          const contrast = (foreground: number[], background: number[]) => {
            const [light, dark] = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
            return (light + 0.05) / (dark + 0.05);
          };
          const blend = (foreground: number[], background: number[], alpha: number) => foreground.map((channel, index) => channel * alpha + background[index] * (1 - alpha));
          const root = getComputedStyle(document.documentElement);
          const surface = rgb(root.getPropertyValue("--surface"));
          const focus = rgb(root.getPropertyValue("--focus-ring"));
          const healthy = rgb(root.getPropertyValue("--s-healthy"));
          const track = document.querySelector<SVGLineElement>(".network-edge");
          const trackStyle = track ? getComputedStyle(track) : null;
          const mapBase = [17, 21, 27];
          const trackColor = trackStyle ? rgb(trackStyle.stroke) : mapBase;
          return {
            focus: contrast(focus, surface),
            state: contrast(healthy, surface),
            track: contrast(blend(trackColor, mapBase, Number(trackStyle?.opacity ?? 1)), mapBase)
          };
        });
        expect(ratios.focus, `${theme} focus ring`).toBeGreaterThanOrEqual(3);
        expect(ratios.state, `${theme} state dot`).toBeGreaterThanOrEqual(3);
        expect(ratios.track, `${theme} map track`).toBeGreaterThanOrEqual(3);
      });
    }
  });

  test("reduced motion disables every visible infinite animation", async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: "dark" });
    const page = await context.newPage();
    try {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await openRoute(page, "/map", "dark");
      const infinite = await page.locator("body *").evaluateAll((elements) => elements
        .filter((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && style.animationName !== "none" && style.animationIterationCount === "infinite";
        })
        .map((element) => ({ className: element.className, animation: getComputedStyle(element).animation })));
      expect(infinite).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
