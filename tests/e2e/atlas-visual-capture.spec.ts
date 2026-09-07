import { expect, test, type Page, type Route, type TestInfo } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { startMockStack, type Stack } from "./dockermapHarness";

type NamedFixture = {
  name: string;
  body: unknown;
};

type FixtureLedger = {
  served: string[];
  unexpected: string[];
};

const namedFixtures: Record<"heartbeat" | "snapshot" | "runtime" | "findings" | "whoami", NamedFixture> = {
  heartbeat: {
    name: "atlas-capture-redacted-heartbeat-v1",
    body: {
      status: "ok", mode: "mock", dockerReachable: false, lastUpdated: 1710000000000,
      snapshotVersion: "atlas-capture-redacted-v1", modelRevision: "atlas-capture-redacted-v1",
      message: "Named redacted Atlas fixture"
    }
  },
  snapshot: {
    name: "atlas-capture-redacted-snapshot-v1",
    body: {
      source: "mock", modelRevision: "atlas-capture-redacted-v1", lastUpdated: 1710000000000,
      containers: [{ id: "atlas_fixture_api", name: "api", image: "python:3.12-slim", status: "running", role: "api", networks: [], ports: [], mounts: [], dependsOn: [] }],
      images: [], networks: [], volumes: []
    }
  },
  runtime: {
    name: "atlas-capture-redacted-runtime-v1",
    body: {
      source: "mock", modelRevision: "atlas-capture-redacted-v1", lastUpdated: 1710000000000,
      nodes: [{
        id: "docker_container_atlas_fixture_api", provider: "docker", type: "container", label: "api", status: "running", layer: "container",
        metadata: { image: "python:3.12-slim", role: "api" },
        service: { name: "api", status: "running", dependencies: [], dependents: [], logs: [], events: [] }
      }],
      edges: [], diagnostics: [], providerStates: []
    }
  },
  findings: { name: "atlas-capture-redacted-findings-v1", body: { source: "mock", modelRevision: "atlas-capture-redacted-v1", findings: [] } },
  whoami: { name: "atlas-capture-redacted-whoami-v1", body: { authenticated: false, required: false } }
};

const captureProfiles = [
  { name: "desktop-light", viewport: { width: 1440, height: 960 }, colorScheme: "light" as const, reducedMotion: "no-preference" as const },
  { name: "desktop-dark", viewport: { width: 1440, height: 960 }, colorScheme: "dark" as const, reducedMotion: "no-preference" as const },
  { name: "narrow-light-reduced", viewport: { width: 390, height: 844 }, colorScheme: "light" as const, reducedMotion: "reduce" as const }
] as const;

test.describe("Atlas opt-in visual capture", () => {
  let stack: Stack | null = null;

  test.afterEach(async () => {
    await stack?.stop();
    stack = null;
  });

  for (const profile of captureProfiles) {
    test(`captures the named redacted fixture: ${profile.name}`, async ({ browser }, testInfo) => {
      test.skip(process.env.DOCKERMAP_ATLAS_CAPTURE !== "1", "Set DOCKERMAP_ATLAS_CAPTURE=1 to generate opt-in Atlas capture artifacts.");
      stack = await startMockStack({ atlasOverview: true });
      const context = await browser.newContext({
        viewport: profile.viewport,
        colorScheme: profile.colorScheme,
        reducedMotion: profile.reducedMotion,
        deviceScaleFactor: 1
      });
      try {
        const page = await context.newPage();
        const ledger = await installNamedRedactedFixtureRoutes(page);
        await page.goto(`${stack.webUrl}/atlas`, { waitUntil: "domcontentloaded" });
        const atlas = page.locator(".atlas-screen");
        await expect(atlas).toBeVisible();
        await expect(atlas.getByRole("heading", { name: "Atlas Overview" })).toBeVisible();
        expect(ledger.unexpected, `unexpected API traffic escaped the named fixture allowlist: ${ledger.unexpected.join(", ")}`).toEqual([]);
        expect(ledger.served).toEqual(expect.arrayContaining([
          namedFixtures.heartbeat.name,
          namedFixtures.snapshot.name,
          namedFixtures.runtime.name,
          namedFixtures.findings.name
        ]));
        await page.addStyleTag({ content: captureCss });
        await atlas.screenshot({
          path: testInfo.outputPath(`atlas-${profile.name}.png`),
          animations: "disabled",
          caret: "hide",
          scale: "css"
        });
        writeCaptureSidecar(testInfo, profile.name, profile, ledger.served);
      } finally {
        await context.close();
      }
    });
  }
});

async function installNamedRedactedFixtureRoutes(page: Page): Promise<FixtureLedger> {
  const ledger: FixtureLedger = { served: [], unexpected: [] };
  // Register the reject-all route first: Playwright evaluates the newest
  // matching route first, so the named routes below are the only API escapes.
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const target = `${request.method()} ${new URL(request.url()).pathname}`;
    ledger.unexpected.push(target);
    await route.abort("blockedbyclient");
  });
  await page.route("**/api/events/stream*", (route) => fulfillHeartbeat(route, ledger));
  await page.route("**/api/snapshot", (route) => fulfillNamedFixture(route, namedFixtures.snapshot, ledger));
  await page.route("**/api/runtime/map", (route) => fulfillNamedFixture(route, namedFixtures.runtime, ledger));
  await page.route("**/api/findings", (route) => fulfillNamedFixture(route, namedFixtures.findings, ledger));
  // EventSource closes after the deterministic one-event body. The heartbeat
  // probes this endpoint on close; keep that follow-up inside the named,
  // redacted fixture boundary too.
  await page.route("**/api/auth/whoami", (route) => fulfillNamedFixture(route, namedFixtures.whoami, ledger));
  return ledger;
}

async function fulfillHeartbeat(route: Route, ledger: FixtureLedger) {
  ledger.served.push(namedFixtures.heartbeat.name);
  await route.fulfill({
    contentType: "text/event-stream",
    body: `event: snapshot\ndata: ${JSON.stringify(namedFixtures.heartbeat.body)}\n\n`
  });
}

async function fulfillNamedFixture(route: Route, fixture: NamedFixture, ledger: FixtureLedger) {
  ledger.served.push(fixture.name);
  await route.fulfill({ contentType: "application/json", body: JSON.stringify(fixture.body) });
}

function writeCaptureSidecar(
  testInfo: TestInfo,
  profile: string,
  options: (typeof captureProfiles)[number],
  servedFixtures: string[]
) {
  writeFileSync(testInfo.outputPath(`atlas-${profile}.json`), `${JSON.stringify({
    captureVersion: 1,
    route: "/atlas",
    profile,
    viewport: options.viewport,
    colorScheme: options.colorScheme,
    reducedMotion: options.reducedMotion,
    deviceScaleFactor: 1,
    fixtureInventory: Object.values(namedFixtures).map((fixture) => fixture.name),
    servedFixtures,
    artifact: `atlas-${profile}.png`
  }, null, 2)}\n`);
}

const captureCss = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    caret-color: transparent !important;
    scroll-behavior: auto !important;
  }
`;
