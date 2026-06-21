import { expect, test, type Page } from "@playwright/test";
import {
  SkipLiveDockerError,
  startLiveDockerStack,
  startMockStack,
  type Stack
} from "./dockermapHarness";

async function openRailPage(page: Page, label: string, path: string) {
  await page.locator(`.rail .nav-list a[href="${path}"]`, { hasText: label }).click();
  await expect(page).toHaveURL(new RegExp(`${path === "/" ? "/$" : path}`));
}

test.describe("DockerMap GUI", () => {
  let stack: Stack | null = null;

  test.afterEach(async () => {
    await stack?.stop();
    stack = null;
  });

  test("navigates every primary page against the daemon fallback", async ({ page }) => {
    stack = await startMockStack();

    await page.goto(stack.webUrl);
    await expect(page.getByText("DockerMap")).toBeVisible();
    await expect(page.getByText(/Mock Engine|Docker Socket/)).toBeVisible();
    await expect(page.getByText("Topology Canvas")).toBeVisible();

    const pages = [
      ["Containers", "/containers", "Container Index"],
      ["Images", "/images", "Image"],
      ["Networks", "/networks", "Network"],
      ["Volumes", "/volumes", "Volume"],
      ["Logs", "/logs", "Log Stream"],
      ["Compose", "/compose", "Compose Map"]
    ] as const;

    for (const [label, path, marker] of pages) {
      await openRailPage(page, label, path);
      await expect(page.getByRole("main")).toContainText(marker);
      await expect(page.getByText(/unavailable/i)).toHaveCount(0);
    }
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

    await page.goto(stack.webUrl);
    await expect(page.getByText("Docker Socket")).toBeVisible();
    await expect(page.getByText("Docker engine connected")).toBeVisible();

    await page.getByPlaceholder("Search services, images, networks, volumes, paths").fill(projectName);
    await openRailPage(page, "Containers", "/containers");
    await expect(page.getByRole("main")).toContainText(apiName!);
    await expect(page.getByRole("main")).toContainText(workerName!);

    await page.getByRole("link", { name: apiName! }).first().click();
    await expect(page).toHaveURL(new RegExp(`/containers/${apiName}`));
    await expect(page.getByText("Service Detail")).toBeVisible();
    await expect(page.getByText("busybox:1.36.1")).toBeVisible();
    await expect(page.getByRole("main").getByText(/up|running/i)).toBeVisible();

    await openRailPage(page, "Images", "/images");
    await expect(page.getByRole("main")).toContainText("busybox:1.36.1");

    await openRailPage(page, "Networks", "/networks");
    await expect(page.getByRole("main")).toContainText(`${projectName}_back`);
    await expect(page.getByRole("main")).toContainText(`${projectName}_front`);

    await openRailPage(page, "Volumes", "/volumes");
    await expect(page.getByRole("main")).toContainText(`${projectName}_live-cache`);
    await expect(page.getByRole("main")).toContainText(`${projectName}_live-logs`);

    await openRailPage(page, "Logs", "/logs");
    await page.locator("select.service-select").selectOption(workerName!);
    await expect(page.getByRole("main")).toContainText("dockermap-live-worker", { timeout: 20_000 });

    await openRailPage(page, "Compose", "/compose");
    await expect(page.getByText("Compose Map")).toBeVisible();
    await expect(page.getByRole("main")).toContainText("api");
    await expect(page.getByRole("main")).toContainText("worker");
    await expect(page.getByRole("main")).toContainText("/data");
    await expect(page.getByRole("main")).toContainText("/worker-data");
    await expect(page.getByRole("main")).toContainText("matched");
  });
});
