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
      ["Changes", "/changes", "Change Center"],
      ["Copilot", "/copilot", "Copilot"],
      ["Networking", "/networking", "Networking"],
      ["Storage", "/storage", "Storage"],
      ["Images", "/images", "Images"],
      ["Logs", "/logs", "Logs"],
      ["Compose", "/compose", "Compose"]
    ] as const;

    for (const [label, path, marker] of spaces) {
      await openSpace(page, label, path);
      await expect(page.getByRole("main")).toContainText(marker);
    }

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

    await openSpace(page, "Compose", "/compose");
    if (process.platform === "linux") {
      await expect(page.getByRole("main")).toContainText("matched");
    } else {
      await expect(page.getByRole("main")).toContainText("Mount drift");
    }
  });
});
