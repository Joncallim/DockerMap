import { expect, test, type Page } from "@playwright/test";
import {
  SkipLiveDockerError,
  startLiveDockerStack,
  startMockStack,
  startProductionImageStack,
  startTokenConfiguredCompose,
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
    await expect(page.getByText(/Mock Engine/)).toBeVisible();
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

    // Inventory detail routes use the shared snapshot and preserve relationships.
    await openSpace(page, "Networking", "/networking");
    await page.locator(".entity-detail-link", { hasText: "application" }).click();
    await expect(page).toHaveURL(/\/networks\/application$/);
    await expect(page.getByRole("heading", { name: "application" })).toBeVisible();
    await expect(page.getByRole("main")).toContainText("bridge");
    for (const service of ["gateway", "api", "worker"]) await expect(page.getByRole("main")).toContainText(service);
    await page.locator(".svc-list").getByRole("link", { name: "gateway", exact: true }).click();
    await expect(page).toHaveURL(/\/services\/gateway$/);

    await openSpace(page, "Storage", "/storage");
    await page.locator(".entity-detail-link", { hasText: "postgres_data" }).click();
    await expect(page).toHaveURL(/\/volumes\/postgres_data$/);
    await expect(page.getByRole("heading", { name: "postgres_data" })).toBeVisible();
    await expect(page.getByRole("main")).toContainText("postgres");
    await expect(page.getByRole("main")).toContainText("/var/lib/postgresql/data");
    await expect(page.getByRole("main")).toContainText("read-write");

    await openSpace(page, "Images", "/images");
    await page.locator(".image-detail-link", { hasText: "python:3.11-slim" }).click();
    await expect(page).toHaveURL(/\/images\/python%3A3\.11-slim$/);
    await expect(page.getByRole("heading", { name: "python:3.11-slim" })).toBeVisible();
    await expect(page.getByRole("main")).toContainText("api");
    await expect(page.getByRole("main")).toContainText("worker");

    // A slash-bearing reference must resolve through the browser router's %2F
    // decoding: the missing-image case below could still pass if decoding were
    // broken (it reaches the same not-found state), so prove the POSITIVE
    // lookup against the mock fixture image too.
    await page.goto(`${stack.webUrl}/images/${encodeURIComponent("ghcr.io/dockermap/example:1.0")}`, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/images\/ghcr\.io%2Fdockermap%2Fexample%3A1\.0$/);
    await expect(page.getByRole("heading", { name: "ghcr.io/dockermap/example:1.0" })).toBeVisible();
    await expect(page.getByRole("main")).toContainText("Sample consumer status: running");
    await expect(page.getByRole("main")).toContainText("registry");
    await expect(page.getByRole("heading", { name: "Image not found" })).not.toBeVisible();

    await openSpace(page, "Runtime", "/runtime");
    const applicationRuntime = page.locator(".runtime-node-btn", { hasText: "application" }).filter({ hasText: "docker network" });
    await applicationRuntime.click();
    await expect(page.getByRole("link", { name: "Open network detail" })).toHaveAttribute("href", "/networks/application");
    await page.getByRole("link", { name: "Open network detail" }).click();
    await expect(page).toHaveURL(/\/networks\/application$/);
    await openSpace(page, "Runtime", "/runtime");
    const postgresVolumeRuntime = page.locator(".runtime-node-btn", { hasText: "postgres_data" }).filter({ hasText: "docker volume" });
    await postgresVolumeRuntime.click();
    await expect(page.getByRole("link", { name: "Open volume detail" })).toHaveAttribute("href", "/volumes/postgres_data");

    await openSpace(page, "Service Map", "/map");
    await page.getByRole("button", { name: "postgres, healthy" }).click();
    await page.getByRole("link", { name: "postgres:16-alpine" }).click();
    await expect(page.getByRole("heading", { name: "postgres:16-alpine" })).toBeVisible();
    await page.goto(`${stack.webUrl}/map`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "postgres, healthy" }).click();
    await page.getByRole("link", { name: "data", exact: true }).click();
    await expect(page.getByRole("heading", { name: "data" })).toBeVisible();
    await page.goto(`${stack.webUrl}/map`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "postgres, healthy" }).click();
    await page.getByRole("link", { name: "postgres_data" }).click();
    await expect(page.getByRole("heading", { name: "postgres_data" })).toBeVisible();

    await page.goto(`${stack.webUrl}/images/${encodeURIComponent("ghcr.io/example/missing:tag")}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Image not found" })).toBeVisible();
    await expect(page.getByRole("main")).toContainText("ghcr.io/example/missing:tag");
    await expect(page.getByRole("link", { name: "Back to Images" })).toHaveAttribute("href", "/images");
    await page.goto(`${stack.webUrl}/networks/missing`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Network not found" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to Networking" })).toHaveAttribute("href", "/networking");
    await page.goto(`${stack.webUrl}/volumes/missing`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Volume not found" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to Storage" })).toHaveAttribute("href", "/storage");

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

  test("runtime relation navigation widens filters, keeps the destination selected and focused", async ({ page }) => {
    stack = await startMockStack();

    await page.goto(stack.webUrl, { waitUntil: "domcontentloaded" });
    await openSpace(page, "Runtime", "/runtime");

    // Select the api container (its label is unique among runtime rows)…
    const apiNode = page.locator("button.runtime-node-btn", { hasText: "api" });
    await apiNode.click();
    await expect(apiNode).toHaveAttribute("aria-pressed", "true");

    // …then narrow the layer filter to Container AND the provider filter to
    // docker. The provider filter is COMPATIBLE with the destination (the
    // "application" network is a docker node); the layer filter is not (the
    // relation lives in the network layer), so its destination row is now
    // EXCLUDED from the node list — but the inspector still offers the
    // relation button.
    await page.getByRole("button", { name: /^Container \(\d+\)$/ }).click();
    await page.getByRole("button", { name: /^docker \(\d+\)$/ }).click();
    const applicationNode = page.locator("button.runtime-node-btn", { hasText: "application" }).filter({ hasText: "docker network" });
    await expect(applicationNode).toHaveCount(0);

    // Follow the relation anyway: the destination must become visible (the
    // incompatible layer filter is widened), stay SELECTED, and receive FOCUS
    // on its persistent row button — never BODY. Previously the visibility
    // effect cleared the selection and the one-frame rAF focus found no row.
    await page.locator(".runtime-edge-target", { hasText: "application" }).click();
    // F5: each predicate widens INDEPENDENTLY — ONLY the incompatible layer
    // filter changes; the compatible provider=docker filter keeps its
    // user-chosen state (and attention-only was never activated).
    await expect(page.getByRole("button", { name: "All layers" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: /^docker \(\d+\)$/ })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Attention only" })).toHaveAttribute("aria-pressed", "false");
    await expect(applicationNode).toBeVisible();
    await expect(applicationNode).toHaveAttribute("aria-pressed", "true");
    // F4: the keyed focus request is consumed by a LAYOUT effect (which runs
    // before paint), so the destination button is already focused at the NEXT
    // PAINT after the click — no body-focus frame can ever paint. A passive
    // effect may run after paint, so an eventual-focus assertion could not
    // catch a body-focus frame; probing inside requestAnimationFrame can.
    const focusAtNextPaint = await page.evaluate(() => new Promise<string | null>((resolve) => {
      requestAnimationFrame(() => {
        const active = document.activeElement;
        resolve(
          active instanceof HTMLElement && active.classList.contains("runtime-node-btn")
            ? active.querySelector(".runtime-node-label")?.textContent?.trim() ?? null
            : null
        );
      });
    }));
    expect(focusAtNextPaint).toBe("application");
    await expect(applicationNode).toBeFocused();
    // The inspector shows the newly selected network node.
    await expect(page.getByRole("heading", { name: "application" })).toBeVisible();
  });

  test("collision evidence stays visible and non-routable in the service directory", async ({ page }) => {
    stack = await startMockStack();

    // The same duplicate-identity fixture the renderer regression uses: two
    // records share a canonical id, two share a name, one is unique. jsdom
    // cannot measure glyph/stroke ink — the earlier renderer test only proved
    // node CENTERS stay in [30, 210], which silently certified a tag whose
    // transformed, stroke-inclusive bottom edge reached ~242 (outside the
    // viewBox). This browser regression asserts every tag's TRANSFORMED
    // getBBox() + stroke bounds within 0..240.
    const extraContainers = [
      { id: "c_dup", name: "first", image: "busybox:1", status: "running", role: "", networks: [], ports: [], mounts: [], dependsOn: ["c_dup"] },
      { id: "c_dup", name: "second", image: "busybox:1", status: "running", role: "", networks: [], ports: [], mounts: [], dependsOn: ["c_ok"] },
      { id: "c_name1", name: "dup-name", image: "busybox:1", status: "running", role: "", networks: [], ports: [], mounts: [], dependsOn: [] },
      { id: "c_name2", name: "dup-name", image: "busybox:1", status: "running", role: "", networks: [], ports: [], mounts: [], dependsOn: [] },
      { id: "c_ok", name: "unique", image: "busybox:1", status: "running", role: "", networks: [], ports: [], mounts: [], dependsOn: [] }
    ];
    await page.route("**/api/snapshot", async (route) => {
      const response = await route.fetch();
      const snapshot = (await response.json()) as { containers: Array<{ id: string }> };
      // Idempotent against the app's refresh ticks: compute the BASE id set
      // ONCE per response (before any push) so the two duplicate-id records
      // are both injected — a per-push `some(id === extra.id)` check would
      // skip the SECOND c_dup because the first was just added.
      const baseIds = new Set(snapshot.containers.map((container) => container.id));
      for (const extra of extraContainers) {
        if (!baseIds.has(extra.id)) {
          snapshot.containers.push(extra as (typeof snapshot.containers)[number]);
        }
      }
      await route.fulfill({ response, json: snapshot });
    });

    await page.goto(`${stack.webUrl}/map`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Service Map" })).toBeVisible();
    // Dense topology is now progressive: ambiguous records remain visible in
    // the directory, never as selectable graph nodes or semantic edges.
    await expect(page.getByRole("heading", { name: /Service directory/ })).toBeVisible();
    await expect(page.getByText("identity collision").first()).toBeVisible();
    await expect(page.getByLabel(/first is unavailable for selection/)).toBeVisible();
    await expect(page.getByLabel(/second is unavailable for selection/)).toBeVisible();
    await expect(page.locator("g.node", { hasText: "first" })).toHaveCount(0);
    const edgeTitles = await page.locator(".edge-group title").allTextContents();
    expect(edgeTitles.join(" ")).not.toContain("first");
    expect(edgeTitles.join(" ")).not.toContain("second");
  });

  test("hover impact highlighting is occurrence-safe and names the exact occurrence", async ({ page, request }) => {
    stack = await startMockStack();

    // The same duplicate-identity fixture as the renderer/browser regressions
    // (two records share a canonical id, two share a name, one unique) is
    // injected into the real mock stack, so the map carries the base stack's
    // selectable nodes AND the collided occurrences.
    const extraContainers = [
      { id: "c_dup", name: "first", image: "busybox:1", status: "running", role: "", networks: [], ports: [], mounts: [], dependsOn: ["c_dup"] },
      { id: "c_dup", name: "second", image: "busybox:1", status: "running", role: "", networks: [], ports: [], mounts: [], dependsOn: ["c_ok"] },
      { id: "c_name1", name: "dup-name", image: "busybox:1", status: "running", role: "", networks: [], ports: [], mounts: [], dependsOn: [] },
      { id: "c_name2", name: "dup-name", image: "busybox:1", status: "running", role: "", networks: [], ports: [], mounts: [], dependsOn: [] },
      { id: "c_ok", name: "unique", image: "busybox:1", status: "running", role: "", networks: [], ports: [], mounts: [], dependsOn: [] }
    ];
    await page.route("**/api/snapshot", async (route) => {
      const response = await route.fetch();
      const snapshot = (await response.json()) as { containers: Array<{ id: string }> };
      const baseIds = new Set(snapshot.containers.map((container) => container.id));
      for (const extra of extraContainers) {
        if (!baseIds.has(extra.id)) {
          snapshot.containers.push(extra as (typeof snapshot.containers)[number]);
        }
      }
      await route.fulfill({ response, json: snapshot });
    });

    await page.goto(`${stack.webUrl}/map`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Service Map" })).toBeVisible();
    // An isolated service is selected from the directory, then receives its
    // own focused graph instead of being mixed into every-service topology.
    await page.locator(".service-directory button", { hasText: "unique" }).click();
    const uniqueNode = page.locator("g.node", { hasText: "unique" });
    await expect(uniqueNode).toHaveCount(1);
    await expect(page.locator("g.node")).toHaveCount(1);
    await expect(page.locator(".map-impact-kind")).toContainText("unique");
    await uniqueNode.locator("circle.node-core").hover();
    await expect(uniqueNode).toHaveClass(/node-self/);
  });

  test("refreshing a selected directory service into a collision clears selection and keeps evidence visible", async ({ page }) => {
    stack = await startMockStack();
    let collided = false;
    await page.route("**/api/snapshot", async (route) => {
      const response = await route.fetch();
      const snapshot = (await response.json()) as { containers: Array<Record<string, unknown>> };
      if (!snapshot.containers.some((container) => container.name === "unique")) {
        snapshot.containers.push({ id: "c_ok", name: "unique", image: "busybox:1", status: "running", role: "", networks: [], ports: [], mounts: [], dependsOn: [] });
      }
      if (collided && !snapshot.containers.some((container) => container.name === "unique-clone")) {
        snapshot.containers.unshift({ id: "c_ok", name: "unique-clone", image: "busybox:1", status: "running", role: "", networks: [], ports: [], mounts: [], dependsOn: [] });
      }
      await route.fulfill({ response, json: snapshot });
    });

    await page.goto(`${stack.webUrl}/map`, { waitUntil: "domcontentloaded" });
    await page.locator(".service-directory button", { hasText: "unique" }).click();
    await expect(page.locator("g.node", { hasText: "unique" })).toHaveCount(1);
    collided = true;
    await expect(page.locator("g.node.node-self")).toHaveCount(0);
    await expect(page.locator(".map-impact")).toHaveCount(0);
    await expect(page.getByLabel(/unique is unavailable for selection/)).toBeVisible();
  });

  test("focused graph only renders the selected service context", async ({ page }) => {
    stack = await startMockStack();
    await page.goto(`${stack.webUrl}/map`, { waitUntil: "domcontentloaded" });
    await page.locator(".service-directory button", { hasText: "postgres" }).click();
    await expect(page.locator("g.node.node-self")).toHaveCount(1);
    await expect(page.locator("g.node.node-self")).toContainText("postgres");
    await expect(page.locator(".map-impact-kind")).toContainText("postgres");
    await expect(page.locator("g.node")).toHaveCount(4);
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

    const relationshipNetwork = snapshot.networks.find((network: { name: string; driver: string; members: string[] }) => network.name && network.members.some((member) => member === apiName || member === workerName));
    const relationshipVolume = snapshot.volumes.find((volume: { name: string; id: string; attachedTo: string[] }) => volume.name && volume.attachedTo.length > 0 && snapshot.containers.some((container: { name: string; mounts: { kind: string; source: string | null; target: string }[] }) => volume.attachedTo.includes(container.name) && container.mounts.some((mount) => mount.kind === "named_volume" && (mount.source === volume.name || mount.source === volume.id))));
    const busyboxImage = snapshot.images.find((image: { image: string; containers: string[] }) => image.image === "busybox:1.36.1" && image.containers.length > 0);
    expect(relationshipNetwork).toBeTruthy();
    expect(relationshipVolume).toBeTruthy();
    expect(busyboxImage).toBeTruthy();
    const volumeConsumer = snapshot.containers.find((container: { name: string; mounts: { kind: string; source: string | null; target: string }[] }) => relationshipVolume.attachedTo.includes(container.name) && container.mounts.some((mount) => mount.kind === "named_volume" && (mount.source === relationshipVolume.name || mount.source === relationshipVolume.id)));
    const volumeTarget = volumeConsumer.mounts.find((mount: { kind: string; source: string | null; target: string }) => mount.kind === "named_volume" && (mount.source === relationshipVolume.name || mount.source === relationshipVolume.id))?.target;
    expect(volumeConsumer).toBeTruthy();
    expect(volumeTarget).toBeTruthy();

    // Detail links use relationship-bearing keys from this live snapshot.
    await openSpace(page, "Networking", "/networking");
    await page.locator(".entity-detail-link", { hasText: relationshipNetwork.name }).click();
    await expect(page.getByRole("heading", { name: relationshipNetwork.name })).toBeVisible();
    await expect(page.getByRole("main")).toContainText(relationshipNetwork.driver);
    await expect(page.getByRole("main")).toContainText(relationshipNetwork.members[0]);
    await openSpace(page, "Storage", "/storage");
    await page.locator(".entity-detail-link", { hasText: relationshipVolume.name }).click();
    await expect(page.getByRole("heading", { name: relationshipVolume.name })).toBeVisible();
    await expect(page.getByRole("main")).toContainText(volumeConsumer.name);
    await expect(page.getByRole("main")).toContainText(volumeTarget);
    await openSpace(page, "Images", "/images");
    await page.locator(".image-detail-link", { hasText: busyboxImage.image }).click();
    await expect(page).toHaveURL(new RegExp(`/images/${encodeURIComponent(busyboxImage.image)}$`));
    await expect(page.getByRole("heading", { name: busyboxImage.image })).toBeVisible();
    await expect(page.getByRole("main")).toContainText(busyboxImage.containers[0]);

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

  test("serves the browser from the production image with bearer session-cookie auth @production-image", async ({ page, request }) => {
    test.skip(!process.env.DOCKERMAP_E2E_PRODUCTION_IMAGE, "Set DOCKERMAP_E2E_PRODUCTION_IMAGE=1 to build the production image.");

    try {
      stack = await startProductionImageStack();
    } catch (error) {
      if (error instanceof SkipLiveDockerError) {
        test.skip(true, error.message);
      }
      throw error;
    }

    const unauthenticated = await request.get(`${stack.apiUrl}/api/snapshot`);
    expect(unauthenticated.status()).toBe(401);

    await page.goto(stack.webUrl);
    await expect(page.getByRole("heading", { name: "Enter your API token" })).toBeVisible();
    await page.getByRole("textbox", { name: "API token" }).fill("dockermap-production-e2e-token");
    await page.getByRole("button", { name: "Connect" }).click();
    await expect(page.getByText("DockerMap", { exact: true })).toBeVisible();
    await expect(page.getByRole("main")).toContainText("Command Center");
    await expect(page.getByText(/Mock Engine/)).toBeVisible();

    const cookies = await page.context().cookies(stack.webUrl);
    const sessionCookie = cookies.find((cookie) => cookie.name === "dockermap_session");
    expect(sessionCookie).toBeTruthy();
    expect(sessionCookie?.value).not.toBe("dockermap-production-e2e-token");
    expect(sessionCookie?.httpOnly).toBe(true);

    const receivedSnapshot = await page.evaluate(() => new Promise<boolean>((resolve, reject) => {
      const source = new EventSource("/api/events/stream");
      const timer = window.setTimeout(() => { source.close(); reject(new Error("SSE snapshot timed out")); }, 10_000);
      source.addEventListener("snapshot", () => { window.clearTimeout(timer); source.close(); resolve(true); }, { once: true });
      source.addEventListener("error", () => { window.clearTimeout(timer); source.close(); reject(new Error("SSE stream failed")); }, { once: true });
    }));
    expect(receivedSnapshot).toBe(true);

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Enter your API token" })).toBeVisible();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Enter your API token" })).toBeVisible();
  });

  test("rate-limits independent production-image clients despite spoofed forwarding headers @production-image", async () => {
    test.skip(!process.env.DOCKERMAP_E2E_PRODUCTION_IMAGE, "Set DOCKERMAP_E2E_PRODUCTION_IMAGE=1 to build the production image.");

    try {
      stack = await startProductionImageStack();
    } catch (error) {
      if (error instanceof SkipLiveDockerError) test.skip(true, error.message);
      throw error;
    }

    expect(stack.postProductionSessionBurst).toBeTruthy();
    for (const client of ["a", "b"] as const) {
      const burst = stack.postProductionSessionBurst!(client, "198.51.100");
      expect(burst.elapsedMs, `${client} burst must complete inside the 60-second limiter window`).toBeLessThan(60_000);
      expect(burst.responses, `${client} burst response count`).toHaveLength(21);
      for (const [index, result] of burst.responses.entries()) {
        if (index < 20) {
          expect(result.status, `${client} attempt ${index + 1}`).toBe(401);
        } else {
          expect(result.status, `${client} attempt ${index + 1}`).toBe(429);
          expect(JSON.parse(result.body)).toMatchObject({ code: "rate_limited" });
        }
      }
    }
  });

  test("maps a labeled real Docker fixture through the production image nginx path @production-image", async ({ page, request }) => {
    test.skip(!process.env.DOCKERMAP_E2E_PRODUCTION_IMAGE, "Set DOCKERMAP_E2E_PRODUCTION_IMAGE=1 to build the production image.");

    try {
      stack = await startProductionImageStack({ liveDocker: true });
    } catch (error) {
      if (error instanceof SkipLiveDockerError) test.skip(true, error.message);
      throw error;
    }

    expect(stack.productionSocketReadOnly).toBe(true);
    const projectName = stack.projectName!;
    const expectedNames = ["api", "worker", "caddy-proxy", "dnsmasq-dns", "tailscale-node", "headscale-control"]
      .map((service) => `${projectName}-${service}-1`)
      .sort();
    const snapshot = await (await request.get(`${stack.apiUrl}/api/snapshot`, {
      headers: { Authorization: "Bearer dockermap-production-e2e-token" }
    })).json();
    expect(snapshot.containers.map((container: { name: string }) => container.name).sort()).toEqual(expectedNames);

    await page.goto(stack.webUrl);
    await page.getByRole("textbox", { name: "API token" }).fill("dockermap-production-e2e-token");
    await page.getByRole("button", { name: "Connect" }).click();
    await expect(page.getByText(/Docker Engine/)).toBeVisible();
    await openSpace(page, "Service Map", "/map");
    for (const name of expectedNames) {
      await expect(page.getByRole("main")).toContainText(name);
    }
  });
  test("reports a healthy Docker healthcheck in none, bearer, and forward-auth modes @production-image", async () => {
    test.skip(!process.env.DOCKERMAP_E2E_PRODUCTION_IMAGE, "Set DOCKERMAP_E2E_PRODUCTION_IMAGE=1 to build the production image.");
    for (const env of [
      {},
      { DOCKERMAP_API_TOKEN: "dockermap-compose-e2e-token" },
      { DOCKERMAP_AUTH_REQUIRED: "true" },
      { DOCKERMAP_AUTH_REQUIRED: "true", DOCKERMAP_API_TOKEN: "dockermap-compose-e2e-token", DOCKERMAP_AUTH_USER_HEADER: "x-internal-user" }
    ]) {
      const compose = await startTokenConfiguredCompose(env);
      try {
        expect(compose.health).toBe("healthy");
      } finally {
        await compose.stop();
      }
    }
  });
});
