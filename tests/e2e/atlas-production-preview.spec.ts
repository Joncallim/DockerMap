import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { SkipLiveDockerError, startProductionImageStack, type Stack } from "./dockermapHarness";

const token = "dockermap-production-e2e-token";

type NamedFixture = { name: string; body: unknown };
type FixtureLedger = { served: string[]; unexpected: string[] };

const fixtures: Record<"heartbeat" | "snapshot" | "runtime" | "findings" | "history" | "whoami", NamedFixture> = {
  heartbeat: { name: "atlas-production-redacted-heartbeat-v1", body: { status: "ok", mode: "mock", dockerReachable: false, lastUpdated: 1, snapshotVersion: "atlas-production-redacted-v1", modelRevision: "atlas-production-r1", message: "Named redacted production fixture" } },
  snapshot: { name: "atlas-production-redacted-snapshot-v1", body: { source: "mock", modelRevision: "atlas-production-r1", lastUpdated: 1, containers: [], images: [], networks: [], volumes: [] } },
  runtime: { name: "atlas-production-redacted-runtime-v1", body: {
    source: "mock", modelRevision: "atlas-production-r1", lastUpdated: 1,
    nodes: [
      { id: "docker_container_production_gateway", provider: "docker", type: "container", label: "gateway", status: "running", layer: "container", metadata: {} },
      { id: "docker_network_production_application", provider: "docker", type: "docker_network", label: "application", status: "running", layer: "network", metadata: {} }
    ],
    edges: [{ source: "docker_container_production_gateway", target: "docker_network_production_application", relationship: "connected_to", metadata: {}, evidenceRefs: [{ version: 1, id: "production-network-membership", provider: "docker", kind: "docker_network_membership", assertionKind: "observed", freshness: "fresh", providerRevision: "atlas-production-r1", subjectRef: "docker_container_production_gateway", summary: "Named redacted production fixture", collectedAt: 1 }] }],
    diagnostics: [], providerStates: []
  } },
  findings: { name: "atlas-production-redacted-findings-v1", body: { source: "mock", modelRevision: "atlas-production-r1", findings: [] } },
  history: { name: "atlas-production-redacted-history-v1", body: { source: "mock", baselineEstablished: false, currentModelRevision: null, observedRevision: null, events: [] } },
  whoami: { name: "atlas-production-redacted-whoami-v1", body: { authenticated: true, required: true } }
};

test.describe("Atlas production-image preview", () => {
  let stack: Stack | null = null;

  test.afterEach(async () => {
    await stack?.stop();
    stack = null;
  });

  test("keeps /atlas unavailable in the default production image @production-image", async ({ page }) => {
    test.skip(process.env.DOCKERMAP_E2E_PRODUCTION_IMAGE !== "1", "Set DOCKERMAP_E2E_PRODUCTION_IMAGE=1 to build the default production image.");
    stack = await productionStack();
    await authenticate(page.context(), stack);
    await page.goto(`${stack.webUrl}/atlas`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Nothing here" })).toBeVisible();
    await expect(page.getByText("Atlas Overview", { exact: true })).toHaveCount(0);
  });

  test("renders only named redacted Atlas fixtures in the explicit production preview @production-image", async ({ page }) => {
    test.skip(process.env.DOCKERMAP_E2E_PRODUCTION_IMAGE !== "1" || process.env.DOCKERMAP_ATLAS_PRODUCTION_IMAGE !== "1", "Set both production-image flags to run the explicit Atlas production preview.");
    stack = await productionStack({ atlasOverview: true });
    await authenticate(page.context(), stack);
    const ledger = await installNamedFixtureRoutes(page);
    await page.goto(`${stack.webUrl}/atlas`, { waitUntil: "domcontentloaded" });
    const atlas = page.locator(".atlas-screen");
    await expect(atlas).toBeVisible();
    await expect(atlas.getByRole("heading", { name: "Atlas Overview" })).toBeVisible();
    await expect(atlas).toContainText("gateway");
    await expect(atlas).not.toContainText("docker_container_production_gateway");
    expect(ledger.served).toEqual(expect.arrayContaining([fixtures.heartbeat.name, fixtures.snapshot.name, fixtures.runtime.name, fixtures.findings.name, fixtures.history.name]));
    expect(ledger.unexpected, `unexpected production API traffic: ${ledger.unexpected.join(", ")}`).toEqual([]);
  });
});

async function productionStack(options: { atlasOverview?: true } = {}) {
  try {
    return await startProductionImageStack(options);
  } catch (error) {
    if (error instanceof SkipLiveDockerError) test.skip(true, error.message);
    throw error;
  }
}

async function authenticate(context: BrowserContext, stack: Stack) {
  const response = await context.request.post(`${stack.apiUrl}/api/auth/session`, { data: { token } });
  // The existing session endpoint intentionally reports successful cookie
  // establishment without a response body.
  expect(response.status()).toBe(204);
  const cookies = await context.request.storageState();
  const session = cookies.cookies.find((cookie) => cookie.name === "dockermap_session");
  expect(session).toBeTruthy();
  await context.addCookies(cookies.cookies);
}

async function installNamedFixtureRoutes(page: Page): Promise<FixtureLedger> {
  const ledger: FixtureLedger = { served: [], unexpected: [] };
  // Playwright evaluates the newest matching handler first. Register this
  // reject-all guard before the exact GET routes below so no API request can
  // silently fall through to the mock daemon in the production container.
  await page.route("**/api/**", async (route) => {
    ledger.unexpected.push(target(route));
    await route.abort("blockedbyclient");
  });
  await page.route(/\/api\/events\/stream(?:\?.*)?$/, (route) => fulfillHeartbeat(route, fixtures.heartbeat, ledger));
  await page.route("**/api/snapshot", (route) => fulfillJson(route, fixtures.snapshot, ledger));
  await page.route("**/api/runtime/map", (route) => fulfillJson(route, fixtures.runtime, ledger));
  await page.route("**/api/findings", (route) => fulfillJson(route, fixtures.findings, ledger));
  await page.route("**/api/history", (route) => fulfillJson(route, fixtures.history, ledger));
  await page.route("**/api/auth/whoami", (route) => fulfillJson(route, fixtures.whoami, ledger));
  return ledger;
}

async function fulfillHeartbeat(route: Route, fixture: NamedFixture, ledger: FixtureLedger) {
  if (!await readOnly(route, ledger)) return;
  ledger.served.push(fixture.name);
  await route.fulfill({ contentType: "text/event-stream", body: `event: snapshot\ndata: ${JSON.stringify(fixture.body)}\n\n` });
}

async function fulfillJson(route: Route, fixture: NamedFixture, ledger: FixtureLedger) {
  if (!await readOnly(route, ledger)) return;
  ledger.served.push(fixture.name);
  await route.fulfill({ contentType: "application/json", body: JSON.stringify(fixture.body) });
}

async function readOnly(route: Route, ledger: FixtureLedger) {
  if (route.request().method() === "GET") return true;
  ledger.unexpected.push(target(route));
  await route.abort("blockedbyclient");
  return false;
}

function target(route: Route) {
  return `${route.request().method()} ${new URL(route.request().url()).pathname}`;
}
