import { expect, test, type Page } from "@playwright/test";
import {
  SkipLiveDockerError,
  startLiveDockerStack,
  startMockStack,
  type Stack
} from "./dockermapHarness";

async function openSpace(page: Page, label: string, path: string) {
  await page.locator(`.rail .nav-list a[href="${path}"]`, { hasText: label }).click();
  await expect(page).toHaveURL(new RegExp(`${path === "/" ? "/$" : path}`));
}

test.describe("DockerMap GUI", () => {
  let stack: Stack | null = null;

  test.afterEach(async () => {
    await stack?.stop();
    stack = null;
  });

  test("navigates every space against the daemon fallback", async ({ page }) => {
    stack = await startMockStack();

    await page.goto(stack.webUrl);
    await expect(page.getByText("DockerMap", { exact: true })).toBeVisible();
    await expect(page.getByText(/Mock Engine|Docker Engine/)).toBeVisible();
    await expect(page.getByRole("main")).toContainText("Command Center");

    const spaces = [
      ["Service Map", "/map", "Service Map"],
      ["Runtime", "/runtime", "Runtime Map"],
      ["Changes", "/changes", "Change Center"],
      ["Copilot", "/copilot", "Copilot"],
      ["Networking", "/networking", "Networking"],
      ["Storage", "/storage", "Storage"],
      ["Images", "/images", "Images"],
      ["Logs", "/logs", "Logs"],
      ["Compose", "/compose", "Compose"],
      ["Diagnostics", "/diagnostics", "Diagnostics"]
    ] as const;

    for (const [label, path, marker] of spaces) {
      await openSpace(page, label, path);
      await expect(page.getByRole("main")).toContainText(marker);
    }

    // Logs controls narrow the stream without a reload.
    await openSpace(page, "Logs", "/logs");
    await page.locator("input.log-search").fill("traffic");
    await expect(page.getByRole("main")).toContainText("accepted traffic");
    await page.locator("select.log-level-select").selectOption("error");
    await expect(page.getByRole("main")).toContainText("No output matches");
    await page.locator("input.log-search").fill("");
    await page.locator("select.log-level-select").selectOption("all");

    // The command palette is a primary interface.
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    await palette.getByPlaceholder(/Search services/).fill("postgres");
    await palette.getByText("Go to postgres").click();

    await expect(page).toHaveURL(/\/services\/postgres/);
    await expect(page.getByRole("main")).toContainText("postgres");
    await expect(page.getByRole("main")).toContainText("Dependencies");
  });

  test("maps a live Docker Compose fixture through the GUI @live-docker", async ({ page, request }) => {
    test.skip(!process.env.DOCKERMAP_E2E_LIVE_DOCKER, "Set DOCKERMAP_E2E_LIVE_DOCKER=1 to create live Docker fixtures.");

    try {
      stack = await startLiveDockerStack();
    } catch (error) {
      if (error instanceof SkipLiveDockerError) {
        test.skip(true, error.message);
      }
      throw error;
    }

    const projectName = stack.projectName!;
    const snapshot = await (await request.get(`${stack.apiUrl}/api/snapshot`)).json();
    const containerNames = snapshot.containers.map((container: { name: string }) => container.name);
    const apiName = containerNames.find((name: string) => name.includes(`${projectName}-api-1`));
    const workerName = containerNames.find((name: string) => name.includes(`${projectName}-worker-1`));
    expect(apiName).toBeTruthy();
    expect(workerName).toBeTruthy();
    expect(containerNames).not.toContain(stack.controlContainerName);

    const runtimeMap = await (await request.get(`${stack.apiUrl}/api/runtime/map`)).json();
    const runtimeProviders = new Set(runtimeMap.nodes.map((node: { provider: string }) => node.provider));
    for (const provider of ["docker", "reverse_proxy", "local_dns", "tailscale", "headscale", "npm", "tmux", "systemd", "pm2", "scheduled_job"]) {
      expect(runtimeProviders.has(provider), `expected runtime provider ${provider}`).toBe(true);
    }
    if (process.platform === "linux") {
      expect(runtimeProviders.has("network"), "expected network listener provider on Linux").toBe(true);
    }

    await page.goto(stack.webUrl);
    await expect(page.getByText(/Docker Engine/)).toBeVisible();

    // Service map shows the live services as nodes.
    await openSpace(page, "Service Map", "/map");
    await expect(page.getByRole("main")).toContainText(apiName!);
    await expect(page.getByRole("main")).toContainText(workerName!);

    // Service detail surfaces the running image and dependency context.
    await page.goto(`${stack.webUrl}/services/${encodeURIComponent(apiName!)}`);
    await expect(page.getByRole("main")).toContainText(apiName!);
    await expect(page.getByRole("main")).toContainText("busybox:1.36.1");
    await expect(page.getByRole("main")).toContainText("Dependencies");

    await openSpace(page, "Networking", "/networking");
    await expect(page.getByRole("main")).toContainText(`${projectName}_back`);
    await expect(page.getByRole("main")).toContainText(`${projectName}_front`);

    await openSpace(page, "Storage", "/storage");
    await expect(page.getByRole("main")).toContainText(`${projectName}_live-cache`);
    await expect(page.getByRole("main")).toContainText(`${projectName}_live-logs`);

    await openSpace(page, "Logs", "/logs");
    await page.locator("select.service-select").selectOption(workerName!);
    await expect(page.getByRole("main")).toContainText("dockermap-live-worker", { timeout: 20_000 });

    // Round-3 (F5/F1): enable live tail so the merge-refresh polls pick up a
    // cursor once the worker's 250-line burst (12.5s at 20 lines/sec) has
    // grown past PAGE_SIZE — with more lines than the page, the live Docker
    // path over-fetches and "Load older" must appear.
    await page.locator("label.log-live input").check();
    const loadOlder = page.getByRole("button", { name: "Load older" });
    await expect(loadOlder).toBeVisible({ timeout: 25_000 });

    // Round-3 (F1, API layer): a small page on the live path still carries a
    // non-null nextCursor because more lines exist behind it.
    const paginated = await (
      await request.get(
        `${stack.apiUrl}/api/logs?service=${encodeURIComponent(workerName!)}&limit=10`
      )
    ).json();
    expect(paginated.entries.length).toBe(10);
    expect(paginated.nextCursor).toBeTruthy();

    // Round-3 (F5): loading an older page appends, and live tail polls must
    // MERGE new lines without discarding the loaded older page.
    const countBeforeOlder = await page.locator("ul.log-stream li").count();
    await loadOlder.click();
    await expect(async () => {
      const count = await page.locator("ul.log-stream li").count();
      expect(count).toBeGreaterThanOrEqual(countBeforeOlder + 50);
    }).toPass({ timeout: 20_000 });
    const countAfterOlder = await page.locator("ul.log-stream li").count();

    // Wait past at least one live poll cycle, then assert the loaded older
    // page survived (the old code reset the stream to the newest page on
    // every heartbeat tick) and the cursor is still advertised.
    await page.waitForTimeout(4_000);
    const countAfterTick = await page.locator("ul.log-stream li").count();
    expect(countAfterTick).toBeGreaterThanOrEqual(countAfterOlder);
    await expect(loadOlder).toBeVisible();

    await openSpace(page, "Compose", "/compose");
    if (process.platform === "linux") {
      await expect(page.getByRole("main")).toContainText("matched");
    } else {
      await expect(page.getByRole("main")).toContainText("Mount drift");
    }
  });
});
