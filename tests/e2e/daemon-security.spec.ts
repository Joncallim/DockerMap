import { expect, test } from "@playwright/test";
import { startAuthenticatedMockDaemon } from "./dockermapHarness";

test("daemon bearer middleware protects every route and hides unavailable Compose locations", async () => {
  const token = "daemon-test-token";
  const daemon = await startAuthenticatedMockDaemon(token);
  const validRoutes = [
    "/daemon/health",
    "/daemon/snapshot",
    "/daemon/graph",
    "/daemon/runtime/map",
    "/daemon/containers",
    "/daemon/containers/gateway",
    "/daemon/images",
    "/daemon/networks",
    "/daemon/volumes",
    "/daemon/logs",
    "/daemon/compose/scan",
    "/daemon/compose/graph",
    "/daemon/compose/edit-plan?file=compose.yaml&service=app&mount=0"
  ];

  try {
    for (const path of validRoutes) {
      const missing = await fetch(`${daemon.url}${path}`);
      expect(missing.status, `${path} without a token`).toBe(401);

      const incorrect = await fetch(`${daemon.url}${path}`, {
        headers: { Authorization: "Bearer wrong-token" }
      });
      expect(incorrect.status, `${path} with an incorrect token`).toBe(401);

      const authenticated = await fetch(`${daemon.url}${path}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      expect(authenticated.status, `${path} with the daemon token`).toBe(200);
    }

    const scan = await fetch(`${daemon.url}/daemon/compose/scan`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(scan.status).toBe(200);
    const scanBody = await scan.json();
    const serializedScan = JSON.stringify(scanBody);
    expect(serializedScan).not.toContain("DOCKERMAP_TEST_FAKE_SOL5_VALID_ENV_KEY");
    expect(serializedScan).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufdd0-\ufdef\ufeff]/u);
    const environment = scanBody.services.find((service: { name: string }) => service.name === "app").environment;
    expect(Object.keys(environment).filter((key) => key === "collision�")).toHaveLength(1);
    expect(scanBody.diagnostics.some((diagnostic: { id: string }) => diagnostic.id === "compose_environment_key_collision")).toBe(true);

    const missingFallback = await fetch(`${daemon.url}/daemon/not-found`);
    expect(missingFallback.status).toBe(401);
    const authenticatedFallback = await fetch(`${daemon.url}/daemon/not-found`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(authenticatedFallback.status).toBe(404);

    const unavailable = await fetch(`${daemon.url}/daemon/compose/scan?file=missing-sol5.yaml`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(unavailable.status).toBe(400);
    const unavailableBody = await unavailable.json();
    expect(unavailableBody.message).toBe("requested Compose file is unavailable");
    expect(JSON.stringify(unavailableBody)).not.toContain(daemon.fixtureDir);
    expect(JSON.stringify(unavailableBody)).not.toContain("os error");
  } finally {
    await daemon.stop();
  }
});

test("daemon falls back to DOCKERMAP_API_TOKEN when no daemon token is set", async () => {
  const token = "api-token-fallback";
  const daemon = await startAuthenticatedMockDaemon(token, { apiTokenFallback: true });
  try {
    const missing = await fetch(`${daemon.url}/daemon/health`);
    expect(missing.status).toBe(401);
    const authenticated = await fetch(`${daemon.url}/daemon/health`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(authenticated.status).toBe(200);
  } finally {
    await daemon.stop();
  }
});
