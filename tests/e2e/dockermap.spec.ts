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

    // Round-5 (F1): container→container depends_on edges resolve by ROLE
    // (compose service name), not by container name — the fixture's worker
    // depends_on api, and live names are project-prefixed.
    const graph = await (await request.get(`${stack.apiUrl}/api/graph`)).json();
    const nodeIdByLabel = new Map(
      graph.nodes.map((node: { id: string; label: string }) => [node.label, node.id])
    );
    const workerNodeId = nodeIdByLabel.get(workerName!);
    const apiNodeId = nodeIdByLabel.get(apiName!);
    expect(workerNodeId).toBeTruthy();
    expect(apiNodeId).toBeTruthy();
    expect(
      graph.edges.some(
        (edge: { source: string; target: string }) =>
          edge.source === workerNodeId && edge.target === apiNodeId
      ),
      "live graph should contain the worker→api depends_on edge"
    ).toBe(true);

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

    // Round-6 (F3): verify REAL cursor paging against live Docker via the API.
    // The GUI "Load older" button drives the same endpoint, but the previous
    // e2e assertion (count >= before+50 with live tail ON) was a false
    // positive: the worker keeps emitting and the 3s merge-poll satisfied the
    // delta even when "Load older" itself returned ~1 line. Poll the API until
    // two full pages exist, then assert strict older-ness, no overlap, and
    // cursor termination.
    const pageLogs = async (cursor?: string) =>
      (await request.get(
        `${stack.apiUrl}/api/logs?service=${encodeURIComponent(workerName!)}&limit=100` +
          (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "")
      )).json();

    let page1!: { entries: { id: string; timestamp: number }[]; nextCursor: string | null };
    let page2!: { entries: { id: string; timestamp: number }[]; nextCursor: string | null };
    await expect(async () => {
      page1 = await pageLogs();
      expect(page1.entries.length).toBe(100);
      expect(page1.nextCursor).toBeTruthy();
      page2 = await pageLogs(page1.nextCursor);
      expect(page2.entries.length).toBe(100);
      expect(page2.nextCursor).toBeTruthy();
    }).toPass({ timeout: 30_000 });

    const page1Ids = new Set(page1.entries.map((entry) => entry.id));
    const page1Oldest = page1.entries[page1.entries.length - 1].timestamp;
    for (const entry of page2.entries) {
      expect(page1Ids.has(entry.id)).toBe(false);
      expect(entry.timestamp).toBeLessThan(page1Oldest);
    }

    // Walk the remaining pages to the true start of history: the cursor must
    // terminate (None) rather than loop or stall.
    let cursor = page2.nextCursor;
    let pagesWalked = 0;
    while (cursor && pagesWalked < 10) {
      const next = await pageLogs(cursor);
      expect(next.entries.length).toBeLessThanOrEqual(100);
      cursor = next.nextCursor;
      pagesWalked += 1;
    }
    expect(cursor).toBe(null);

    // Round-6 (F3, GUI): the "Load older" control surfaces once a cursor
    // exists — enabling live tail drives the merge-poll that sets nextCursor,
    // and unchecking it isolates the stream from further accumulation.
    const loadOlder = page.getByRole("button", { name: "Load older" });
    await page.locator("label.log-live input").check();
    await expect(loadOlder).toBeVisible({ timeout: 25_000 });
    await page.locator("label.log-live input").uncheck();

    await openSpace(page, "Compose", "/compose");
    if (process.platform === "linux") {
      await expect(page.getByRole("main")).toContainText("matched");
    } else {
      await expect(page.getByRole("main")).toContainText("Mount drift");
    }
  });
});
