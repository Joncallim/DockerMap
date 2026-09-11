import { expect, test, type Page, type Route, type TestInfo } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
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

type SyntheticCertificationClass = "compose-heavy" | "mixed-docker-host-native" | "sparse-unusual";

type SyntheticFixtureSet = Record<"heartbeat" | "snapshot" | "runtime" | "findings" | "whoami", NamedFixture> & {
  certificationClass: SyntheticCertificationClass;
};

const syntheticRuntimeFixtures: Record<SyntheticCertificationClass, NamedFixture> = {
  "compose-heavy": {
    name: "atlas-synthetic-compose-heavy-runtime-v1",
    body: {
      source: "mock", modelRevision: "atlas-synthetic-compose-heavy-r1", lastUpdated: 1,
      nodes: [
        runtimeNode("docker_container_synthetic_compose_web", "docker", "container", "container", "compose web"),
        runtimeNode("docker_container_synthetic_compose_worker", "docker", "container", "container", "compose worker"),
        runtimeNode("docker_container_synthetic_compose_database", "docker", "container", "container", "compose database"),
        runtimeNode("docker_network_synthetic_compose", "docker", "docker_network", "network", "recorded compose network", null),
        runtimeNode("docker_volume_synthetic_compose_data", "docker", "docker_volume", "storage", "recorded compose storage", null)
      ],
      edges: [
        runtimeEdge("docker_container_synthetic_compose_web", "docker_container_synthetic_compose_worker", "depends_on", "docker_compose_depends_on"),
        runtimeEdge("docker_container_synthetic_compose_web", "docker_network_synthetic_compose", "connected_to", "docker_network_membership"),
        runtimeEdge("docker_container_synthetic_compose_database", "docker_network_synthetic_compose", "connected_to", "docker_network_membership"),
        runtimeEdge("docker_container_synthetic_compose_database", "docker_volume_synthetic_compose_data", "mounts", "docker_volume_mount")
      ], diagnostics: [], providerStates: []
    }
  },
  "mixed-docker-host-native": {
    name: "atlas-synthetic-mixed-docker-host-native-runtime-v1",
    body: {
      source: "mock", modelRevision: "atlas-synthetic-mixed-host-r1", lastUpdated: 1,
      nodes: [
        runtimeNode("docker_container_synthetic_gateway", "docker", "container", "container", "gateway"),
        runtimeNode("systemd_service_synthetic_gateway", "systemd", "systemd_service", "service", "gateway"),
        runtimeNode("systemd_service_synthetic_target", "systemd", "systemd_service", "service", "host target", "paused")
      ],
      edges: [runtimeEdge("systemd_service_synthetic_gateway", "systemd_service_synthetic_target", "requires", "systemd_requires", "declared", "systemd", "stale")],
      diagnostics: [], providerStates: [{ slot: "systemd", state: "stale", lastAttemptMs: 1, lastSuccessMs: 1, lastDurationMs: 1, consecutiveFailureCount: 0, dataRevision: "synthetic", statusReason: "collection_failed" }]
    }
  },
  "sparse-unusual": {
    name: "atlas-synthetic-sparse-unusual-runtime-v1",
    body: {
      source: "mock", modelRevision: "atlas-synthetic-sparse-unusual-r1", lastUpdated: 1,
      nodes: [
        runtimeNode("docker_container_synthetic_collision", "docker", "container", "container", "duplicate record"),
        runtimeNode("docker_container_synthetic_collision", "docker", "container", "container", "duplicate record"),
        runtimeNode("runtime_synthetic_unsupported", "other", "future_unpublished_kind", "edge", "unsupported synthetic record", null),
        runtimeNode("docker_container_synthetic_daemon_client", "docker", "container", "container", "daemon context client"),
        runtimeNode("host_risk_docker_daemon_state", "docker", "host_risk", "host", "recorded daemon state context", null)
      ],
      edges: [runtimeEdge("docker_container_synthetic_daemon_client", "host_risk_docker_daemon_state", "exposes_daemon_state", "docker_daemon_state_bind_mount")], diagnostics: [], providerStates: []
    }
  }
};

const baseNamedFixtures: Record<"heartbeat" | "findings" | "whoami", NamedFixture> = {
  heartbeat: {
    name: "atlas-capture-redacted-heartbeat-v1",
    body: {
      status: "ok", mode: "mock", dockerReachable: false, lastUpdated: 1710000000000,
      snapshotVersion: "atlas-capture-redacted-v1", modelRevision: "atlas-capture-redacted-v1",
      message: "Named redacted Atlas fixture"
    }
  },
  findings: { name: "atlas-synthetic-findings-v1", body: { source: "mock", modelRevision: "atlas-synthetic-r1", findings: [] } },
  whoami: { name: "atlas-capture-redacted-whoami-v1", body: { authenticated: false, required: false } }
};

function runtimeNode(id: string, provider: string, type: string, layer: string, label: string, status: string | null = "running") {
  return { id, provider, type, label, status, layer, metadata: {} };
}

function runtimeEdge(source: string, target: string, relationship: string, kind: string, assertionKind: "observed" | "declared" = "observed", provider = "docker", freshness = "fresh") {
  return { source, target, relationship, metadata: {}, evidenceRefs: [{ version: provider === "systemd" ? 2 : 1, id: `synthetic-${kind}-${source}`, provider, kind, assertionKind, freshness, providerRevision: "synthetic-r1", ...(provider === "systemd" ? { providerSlot: "systemd" } : {}), subjectRef: source, summary: "Synthetic certification declaration", collectedAt: 1 }] };
}

function fixtureSet(certificationClass: SyntheticCertificationClass): SyntheticFixtureSet {
  const runtime = syntheticRuntimeFixtures[certificationClass];
  const revision = (runtime.body as { modelRevision: string }).modelRevision;
  return {
    certificationClass,
    ...baseNamedFixtures,
    heartbeat: { ...baseNamedFixtures.heartbeat, body: { ...(baseNamedFixtures.heartbeat.body as object), modelRevision: revision } },
    snapshot: { name: `atlas-synthetic-${certificationClass}-snapshot-v1`, body: { source: "mock", modelRevision: revision, lastUpdated: 1, containers: [], images: [], networks: [], volumes: [] } },
    runtime,
    findings: { ...baseNamedFixtures.findings, body: { source: "mock", modelRevision: revision, findings: [] } }
  };
}

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
    for (const certificationClass of ["compose-heavy", "mixed-docker-host-native", "sparse-unusual"] as const) {
    test(`captures the named sanitized ${certificationClass} fixture: ${profile.name}`, async ({ browser }, testInfo) => {
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
        const fixtures = fixtureSet(certificationClass);
        const ledger = await installNamedRedactedFixtureRoutes(page, fixtures);
        await page.goto(`${stack.webUrl}/atlas`, { waitUntil: "domcontentloaded" });
        const atlas = page.locator(".atlas-screen");
        await expect(atlas).toBeVisible();
        await expect(atlas.getByRole("heading", { name: "Atlas Overview" })).toBeVisible();
        expect(ledger.unexpected, `unexpected API traffic escaped the named fixture allowlist: ${ledger.unexpected.join(", ")}`).toEqual([]);
        expect(ledger.served).toEqual(expect.arrayContaining([
          fixtures.heartbeat.name,
          fixtures.snapshot.name,
          fixtures.runtime.name,
          fixtures.findings.name
        ]));
        await page.addStyleTag({ content: captureCss });
        await atlas.screenshot({
          path: testInfo.outputPath(`atlas-${certificationClass}-${profile.name}.png`),
          animations: "disabled",
          caret: "hide",
          scale: "css"
        });
        writeCaptureSidecar(testInfo, certificationClass, profile.name, profile, fixtures, ledger.served);
        expect(ledger.unexpected, `unexpected API traffic occurred during capture: ${ledger.unexpected.join(", ")}`).toEqual([]);
      } finally {
        await context.close();
      }
    });
    }
  }

  test("exercises synthetic Atlas keyboard, pointer, and Axe evidence", async ({ browser }) => {
    test.skip(process.env.DOCKERMAP_ATLAS_CAPTURE !== "1", "Set DOCKERMAP_ATLAS_CAPTURE=1 to run opt-in Atlas certification evidence.");
    stack = await startMockStack({ atlasOverview: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark", reducedMotion: "reduce" });
    try {
      const page = await context.newPage();
      const fixtures = fixtureSet("mixed-docker-host-native");
      const ledger = await installNamedRedactedFixtureRoutes(page, fixtures);
      await page.goto(`${stack.webUrl}/atlas`, { waitUntil: "domcontentloaded" });
      const directory = page.getByRole("region", { name: "Atlas subject directory" });
      await expect(directory).toBeVisible();
      const first = directory.getByRole("button").first();
      await first.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("complementary", { name: "Atlas inspector" })).not.toContainText("Select a subject");
      await directory.getByRole("button").nth(1).click();
      await expect(page.getByRole("complementary", { name: "Atlas inspector" })).toContainText("gateway");
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations, results.violations.map((violation) => violation.id).join(", ")).toEqual([]);
      expect(ledger.unexpected).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

async function installNamedRedactedFixtureRoutes(page: Page, namedFixtures: SyntheticFixtureSet): Promise<FixtureLedger> {
  const ledger: FixtureLedger = { served: [], unexpected: [] };
  // Register the reject-all route first: Playwright evaluates the newest
  // matching route first, so the named routes below are the only API escapes.
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const target = `${request.method()} ${new URL(request.url()).pathname}`;
    ledger.unexpected.push(target);
    await route.abort("blockedbyclient");
  });
  await page.route(/\/api\/events\/stream(?:\?.*)?$/, (route) => fulfillHeartbeat(route, namedFixtures.heartbeat, ledger));
  await page.route("**/api/snapshot", (route) => fulfillNamedFixture(route, namedFixtures.snapshot, ledger));
  await page.route("**/api/runtime/map", (route) => fulfillNamedFixture(route, namedFixtures.runtime, ledger));
  await page.route("**/api/findings", (route) => fulfillNamedFixture(route, namedFixtures.findings, ledger));
  // EventSource closes after the deterministic one-event body. The heartbeat
  // probes this endpoint on close; keep that follow-up inside the named,
  // redacted fixture boundary too.
  await page.route("**/api/auth/whoami", (route) => fulfillNamedFixture(route, namedFixtures.whoami, ledger));
  return ledger;
}

async function fulfillHeartbeat(route: Route, fixture: NamedFixture, ledger: FixtureLedger) {
  if (!await allowReadRequest(route, ledger)) return;
  ledger.served.push(fixture.name);
  await route.fulfill({
    contentType: "text/event-stream",
    body: `event: snapshot\ndata: ${JSON.stringify(fixture.body)}\n\n`
  });
}

async function fulfillNamedFixture(route: Route, fixture: NamedFixture, ledger: FixtureLedger) {
  if (!await allowReadRequest(route, ledger)) return;
  ledger.served.push(fixture.name);
  await route.fulfill({ contentType: "application/json", body: JSON.stringify(fixture.body) });
}

async function allowReadRequest(route: Route, ledger: FixtureLedger): Promise<boolean> {
  if (route.request().method() === "GET") return true;
  ledger.unexpected.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
  await route.abort("blockedbyclient");
  return false;
}

function writeCaptureSidecar(
  testInfo: TestInfo,
  certificationClass: SyntheticCertificationClass,
  profile: string,
  options: (typeof captureProfiles)[number],
  namedFixtures: SyntheticFixtureSet,
  servedFixtures: string[]
) {
  writeFileSync(testInfo.outputPath(`atlas-${certificationClass}-${profile}.json`), `${JSON.stringify({
    captureVersion: 1,
    certificationClass,
    route: "/atlas",
    profile,
    viewport: options.viewport,
    colorScheme: options.colorScheme,
    reducedMotion: options.reducedMotion,
    deviceScaleFactor: 1,
    fixtureInventory: (["heartbeat", "snapshot", "runtime", "findings", "whoami"] as const).map((key) => namedFixtures[key].name),
    servedFixtures,
    artifact: `atlas-${certificationClass}-${profile}.png`
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
