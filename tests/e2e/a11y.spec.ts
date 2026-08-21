import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
const rawAxeDir = join(process.cwd(), "test-artifacts", "axe");

test.describe("responsive and accessibility matrix", () => {
  test.beforeAll(async () => {
    rmSync(join(process.cwd(), "test-artifacts"), { recursive: true, force: true });
    mkdirSync(rawAxeDir, { recursive: true });
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
    const serialized = JSON.stringify(sorted, null, 2);
    // Keep an exact raw mirror outside Playwright's transient success output so
    // CI can upload every target's attachment even when the matrix is green.
    writeFileSync(join(rawAxeDir, `${target}.json`), serialized);
    await testInfo.attach(`axe-${target}.json`, { body: serialized, contentType: "application/json" });
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
      await openRoute(page, "/copilot", "dark");
      const askCopilot = page.getByRole("textbox", { name: "Ask Copilot" });
      await askCopilot.fill("what changed recently?");
      await askCopilot.press("Enter");
      await expect(askCopilot).toBeFocused();

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
      await page.keyboard.press("Shift+Tab");
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

  /**
   * Width contract shared by every responsive cell: single-track Map/Runtime
   * layout, no document-level horizontal overflow, and no visible text that
   * is clipped (silently cut off by a non-scrollable overflow), truncated
   * with an ellipsis where the text is an identity or heading, or pushed out
   * of the viewport. Ellipsis remains acceptable on compact metadata columns
   * (e.g. the fixed-width log service column); identity/heading text must
   * reflow (the ≤800px stylesheet wraps those with overflow-wrap: anywhere).
   */
  async function assertUsableAtWidth(page: Page, label: string, width: number) {
    const layout = await page.locator(".map-layout").evaluateAll((layouts) => layouts.map((layout) => getComputedStyle(layout).gridTemplateColumns));
    for (const columns of layout) expect(columns.split(" ").length).toBe(1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${label} overflow at ${width}px`).toBeLessThanOrEqual(1);
    const clipped = await page.evaluate(() => {
      const identitySelector = "h1, h2, h3, .screen-title, .svc-name, .feed-text, .runtime-node-label, .runtime-edge-target span, .entity-detail-link, .ref-chip, .diag-file, .diag-message, .kv-value, .detail-id";
      const insideScrollable = (element: Element): boolean => {
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          if (style.overflowX === "auto" || style.overflowX === "scroll") return true;
        }
        return false;
      };
      const offenders: string[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0 || style.visibility === "hidden" || style.display === "none") continue;
        // Screen-reader-only text (1px clip for assistive tech) is not
        // "clipped" content — it is deliberately invisible for sighted users.
        const isSrOnly = el.classList.contains("sr-only") || style.clip === "rect(0px, 0px, 0px, 0px)" || (style.position === "absolute" && rect.width <= 1 && rect.height <= 1);
        if (isSrOnly) continue;
        const hasOwnText = Array.from(el.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "");
        if (rect.left < -1 || rect.right > window.innerWidth + 1) {
          if (hasOwnText && !insideScrollable(el)) {
            offenders.push(`off-viewport:${el.tagName}.${String(el.className).split(" ").join(".")}`);
          }
          continue;
        }
        if (!hasOwnText) continue;
        const clippedX = style.overflowX === "hidden" || style.overflowX === "clip" || style.textOverflow === "ellipsis";
        if (!clippedX) continue;
        const truncated = style.textOverflow === "ellipsis" ? el.scrollWidth > el.clientWidth + 1 : el.scrollWidth > el.clientWidth + 2;
        if (!truncated) continue;
        // Ellipsis is an intentional affordance on compact metadata; identity
        // and heading text must never truncate (it must reflow).
        if (style.textOverflow === "ellipsis" && !el.matches(identitySelector)) continue;
        offenders.push(`${style.textOverflow === "ellipsis" ? "ellipsis" : "clipped"}:${el.tagName}.${String(el.className).split(" ").join(".")}`);
      }
      return offenders;
    });
    expect(clipped, `${label} clipped text at ${width}px`).toEqual([]);
  }

  for (const width of [800, 640]) {
    test(`responsive ${width}px has no page overflow, clipped text, or clipped controls`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: "light" });
      const page = await context.newPage();
      try {
        for (const [name, route] of coreRoutes) {
          await openRoute(page, route, "light");
          await assertUsableAtWidth(page, `${name} ${route}`, width);
        }

        // TokenScreen at width: the real bearer-unauthorized event swaps in
        // the token gate; it must stay usable at both widths too.
        await page.goto(stack.webUrl, { waitUntil: "domcontentloaded" });
        await page.evaluate(() => window.dispatchEvent(new Event("dockermap:bearer-unauthorized")));
        await expect(page.getByRole("heading", { name: "Enter your API token" })).toBeVisible();
        await assertUsableAtWidth(page, "token screen", width);

        // Open palette at width: the dialog itself must not overflow/clip.
        await page.goto(`${stack.webUrl}/`, { waitUntil: "domcontentloaded" });
        await expect(page.locator("main h1").first()).toBeVisible();
        await page.keyboard.press("Control+k");
        const paletteDialog = page.getByRole("dialog", { name: "Command palette" });
        await expect(paletteDialog).toBeVisible();
        // Escape is handled by the dialog's keydown trap, so wait for the
        // autofocused combobox before dismissing (a race here flakes the
        // close assertion).
        await expect(paletteDialog.getByRole("combobox")).toBeFocused();
        await assertUsableAtWidth(page, "command palette open", width);
        await page.keyboard.press("Escape");
        await expect(paletteDialog).toBeHidden();

        // Map selected state at width.
        await openRoute(page, "/map", "light");
        await page.getByRole("button", { name: "postgres, healthy" }).click();
        await assertUsableAtWidth(page, "map selected state", width);
        await page.getByRole("button", { name: /Clear postgres service selection/ }).click();

        // Runtime selected and unselected states at width.
        await openRoute(page, "/runtime", "light");
        const runtimeNode = page.locator("button.runtime-node-btn").first();
        await runtimeNode.click();
        await assertUsableAtWidth(page, "runtime selected state", width);
        await page.getByRole("button", { name: /Clear .* runtime selection/ }).click();
        await assertUsableAtWidth(page, "runtime unselected state", width);

        // Stateful detail/config states.
        await openRoute(page, "/services/postgres", "light");
        await page.getByRole("tab", { name: "Configuration" }).click();
        await page.getByRole("button", { name: "Show service internals" }).click();
        await assertUsableAtWidth(page, "service configuration internals expanded", width);
        await openRoute(page, "/logs", "light");
        await assertUsableAtWidth(page, "logs", width);
        await openRoute(page, "/compose", "light");
        await assertUsableAtWidth(page, "compose", width);
        await openRoute(page, "/diagnostics", "light");
        await assertUsableAtWidth(page, "diagnostics", width);
        await openRoute(page, "/settings", "light");
        await assertUsableAtWidth(page, "settings", width);
      } finally {
        await context.close();
      }
    });
  }

  test("long, empty, and duplicate identities reflow instead of clipping at 640px", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 640, height: 900 }, colorScheme: "light" });
    const page = await context.newPage();
    try {
      const extraContainers = [
        { id: "c_long", name: "long-identity-".repeat(18), image: "busybox:latest", status: "unhealthy", role: "worker", networks: [], ports: [], mounts: [], dependsOn: [] },
        { id: "c_empty", name: "", image: "busybox:latest", status: "unhealthy", role: "worker", networks: [], ports: [], mounts: [], dependsOn: [] },
        { id: "c_dup1", name: "dup-svc", image: "busybox:latest", status: "unhealthy", role: "worker", networks: [], ports: [], mounts: [], dependsOn: [] },
        { id: "c_dup2", name: "dup-svc", image: "busybox:latest", status: "unhealthy", role: "worker", networks: [], ports: [], mounts: [], dependsOn: [] }
      ];
      await page.route("**/api/snapshot", async (route) => {
        const response = await route.fetch();
        const snapshot = (await response.json()) as { containers: Array<{ id: string }> };
        // Idempotent: the app refetches on its refresh tick, so only add the
        // fixture services once.
        for (const extra of extraContainers) {
          if (!snapshot.containers.some((container) => container.id === extra.id)) {
            snapshot.containers.push(extra as (typeof snapshot.containers)[number]);
          }
        }
        await route.fulfill({ response, json: snapshot });
      });

      await openRoute(page, "/", "light");

      // The long identity reflows (wraps) inside the viewport instead of
      // clipping or ellipsizing — the jsdom fixtures cannot prove reflow.
      const longName = page.locator(".svc-list .svc-name", { hasText: "long-identity-" }).first();
      await expect(longName).toBeVisible();
      const longBox = await longName.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return {
          left: rect.left,
          right: rect.right,
          innerWidth: window.innerWidth,
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          textOverflow: style.textOverflow,
          overflowX: style.overflowX
        };
      });
      expect(longBox.right).toBeLessThanOrEqual(longBox.innerWidth + 1);
      expect(longBox.left).toBeGreaterThanOrEqual(-1);
      expect(longBox.textOverflow).not.toBe("ellipsis");
      expect(longBox.overflowX).not.toBe("hidden");
      expect(longBox.scrollWidth).toBeLessThanOrEqual(longBox.clientWidth + 1);

      // The empty identity renders the explicit fallback, never a blank row.
      await expect(page.getByText("Unavailable service name").first()).toBeVisible();

      // Duplicate (redaction-collided) identities stay visible as distinct
      // non-routable rows in the attention list (the hash-based "Updates
      // available" panel may also list one of them, so scope to this list).
      const attentionList = page.locator(".svc-list").first();
      await expect(attentionList.locator(".svc-row", { hasText: "dup-svc" })).toHaveCount(2);

      await assertUsableAtWidth(page, "long/empty/duplicate identity home", 640);
    } finally {
      await context.close();
    }
  });

  test("async route heading is promoted without a late focus steal", async ({ browser }) => {
    // Every scanned route mounts its h1 immediately once the model is in
    // memory, so the RouteFocusManager MutationObserver path never runs under
    // the plain mock stack. This test forces it: a localStorage default route
    // redirects the fresh boot (Landing -> /map) and the /api/snapshot
    // response is delayed, so the destination h1 mounts only AFTER focus has
    // settled on the #main-content fallback.
    const delaySnapshot = (page: Page) =>
      page.route("**/api/snapshot", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        await route.continue();
      });
    const contextWithMapDefault = async () => {
      const context = await browser.newContext({ colorScheme: "dark" });
      // Set BEFORE the app boots so Landing redirects to /map immediately.
      await context.addInitScript((settings) => {
        window.localStorage.setItem("dockermap.settings.v1", settings);
      }, JSON.stringify({ defaultRoute: "/map" }));
      return context;
    };

    // Scenario 1 — promotion: the delayed h1 must receive focus once it mounts.
    {
      const context = await contextWithMapDefault();
      const page = await context.newPage();
      try {
        await delaySnapshot(page);
        await page.goto(stack.webUrl, { waitUntil: "domcontentloaded" });
        await expect(page.getByRole("heading", { name: "Service Map" })).toBeFocused();
      } finally {
        await context.close();
      }
    }

    // Scenario 2 — no late steal: the user moves focus (Tab to the skip link)
    // before the h1 mounts; the observer must NOT yank focus back afterwards.
    {
      const context = await contextWithMapDefault();
      const page = await context.newPage();
      try {
        await delaySnapshot(page);
        await page.goto(stack.webUrl, { waitUntil: "domcontentloaded" });
        // The heading must still be pending (snapshot delayed)…
        await expect(page.getByRole("heading", { name: "Service Map" })).toHaveCount(0);
        // …the fallback holds focus…
        await expect(page.locator("#main-content")).toBeFocused();
        // …the user moves focus before the h1 mounts…
        await page.keyboard.press("Tab");
        await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
        // …and the late h1 must not steal it back.
        await expect(page.getByRole("heading", { name: "Service Map" })).toBeVisible();
        await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
      } finally {
        await context.close();
      }
    }
  });

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
          // Read the .map canvas background instead of hardcoding it: the
          // track is blended over the map's own gradient, so the assertion
          // must track the computed base color or it silently drifts.
          const mapElement = document.querySelector<HTMLElement>(".map");
          const mapBackground = mapElement ? getComputedStyle(mapElement).backgroundImage : "";
          const gradientStops = mapBackground.match(/rgba?\([^)]*\)/g) ?? [];
          const mapBase = gradientStops.length > 0 ? rgb(gradientStops[gradientStops.length - 1]) : [17, 21, 27];
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
