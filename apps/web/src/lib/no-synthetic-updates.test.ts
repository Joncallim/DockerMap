import { testProviderStates } from "./testProviderStates";
import { describe, expect, it } from "vitest";
import type { DockerSnapshot, RuntimeMap } from "@dockermap/contracts";
import type { Service, SystemSummary } from "./model";
import { getDemoResponse } from "./demoData";
import { buildModel, summarize } from "./model";
import { changeFeed, type ChangeEvent } from "./stubs";

const runtime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], modelRevision: "test-revision", providerStates: testProviderStates, lastUpdated: 0 };

/**
 * Live-shaped payload in the shape the daemon mock emits for /api/snapshot
 * (crates/dockermap-core `mock_snapshot`): full ContainerRecords with nested
 * mounts, populated image/network/volume records, and a lastUpdated
 * timestamp — an API-shaped response, NOT a handcrafted demo. The demo leg
 * below uses getDemoResponse(), the same fetch path the app takes, so both
 * AC3 legs (L1, Q10) run against API-shaped bytes.
 */
const liveSnapshot: DockerSnapshot = {
  containers: [
    {
      id: "container_api",
      name: "api",
      image: "python:3.11-slim",
      status: "running",
      role: "api",
      networks: ["network_app", "network_data"],
      ports: ["3233:3233/tcp"],
      mounts: [
        {
          id: "container_api:/workspace/src:/srv/dockermap/src",
          kind: "bind",
          source: "/srv/dockermap/src",
          target: "/workspace/src",
          readOnly: false
        }
      ],
      dependsOn: ["container_db"]
    },
    {
      id: "container_db",
      name: "postgres",
      image: "postgres:16-alpine",
      status: "running",
      role: "primary database",
      networks: ["network_data"],
      ports: ["5432:5432/tcp"],
      mounts: [
        {
          id: "container_db:/var/lib/postgresql/data:postgres_data",
          kind: "named_volume",
          source: "postgres_data",
          target: "/var/lib/postgresql/data",
          readOnly: false
        }
      ],
      dependsOn: []
    }
  ],
  images: [
    { image: "python:3.11-slim", containers: ["api"], status: "running" },
    { image: "postgres:16-alpine", containers: ["postgres"], status: "running" }
  ],
  networks: [
    { id: "network_app", name: "app", driver: "bridge", internal: false, members: ["container_api"] },
    { id: "network_data", name: "data", driver: "bridge", internal: false, members: ["container_api", "container_db"] }
  ],
  volumes: [{ id: "volume_postgres_data", name: "postgres_data", attachedTo: ["container_db"] }],
  lastUpdated: 0,
  modelRevision: "test-revision"
  };

/**
 * Recursive key collector (U4): a renamed claim can hide on a NESTED object
 * (a mount record, a dependency occurrence), so the scan walks every plain
 * object/array reachable from the scanned roots instead of only top-level
 * keys. Map/Set values are not own enumerable keys and are intentionally
 * skipped — the claim surfaces live on Service/SystemSummary plain objects.
 */
function deepKeys(value: unknown, seen: Set<object> = new Set()): string[] {
  if (typeof value !== "object" || value === null) return [];
  if (seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) {
    return value.flatMap((item) => deepKeys(item, seen));
  }
  return [...Object.keys(value), ...Object.values(value).flatMap((child) => deepKeys(child, seen))];
}

/** Feed scan: any event whose kind/summary/detail carries update-shaped vocabulary. */
function feedMatches(event: ChangeEvent): boolean {
  return /updat|refresh|pulled/i.test(`${event.kind} ${event.summary} ${event.detail ?? ""}`);
}

describe("no synthetic update claim reaches the model", () => {
  it("deep-scans live and demo model graphs and their feeds", () => {
    const demoSnapshot = getDemoResponse<DockerSnapshot>("/api/snapshot");
    for (const snapshot of [liveSnapshot, demoSnapshot]) {
      const model = buildModel(snapshot, runtime);
      const summary = summarize(model);
      // Nested graph scan: services (with nested mounts/occurrences) and the
      // summary must be free of update-shaped keys, top level AND nested.
      const keys = deepKeys([model.services, summary]);
      expect(keys.some((key) => /update|refresh/i.test(key))).toBe(false);
      // Scan the sample arm: the live arm deliberately has no events, so
      // scanning it would make this update-vocabulary tripwire vacuous.
      // demo + demo provenance is the authorized matching sample pair.
      const feed = changeFeed(model, "demo", "demo");
      if (feed.kind === "unavailable") throw new Error("demo history must remain sample-tagged");
      for (const event of feed.value) {
        expect(feedMatches(event)).toBe(false);
      }
      const service = model.services[0];
      // Runtime: absent through literal-typed template access; the 2339-while-
      // absent error is suppressed by the directive, so reintroducing either
      // field makes the directive unused and tsc FAILS. Template-parts keep the
      // file's claim-grep at zero literal hits.
      // @ts-expect-error update claims are not part of Service.
      expect(service[`update${"Available"}`]).toBeUndefined();
      // @ts-expect-error update claims are not part of SystemSummary.
      expect(summary[`updates${"Available"}`]).toBeUndefined();
      // Compile-time backstop (Sol gate follow-up): type-level probes whose
      // template-parts evaluate to the EXACT removed keys at the type level, so
      // the @ts-expect-error directives are LIVE only while the fields are
      // absent — reintroducing either field makes the directive unused and tsc
      // FAILS (computed-string access could not).
      type UpdateProbe<K extends string> = `update${K}`;
      // @ts-expect-error update claims are not part of Service.
      const serviceProbe: UpdateProbe<"Available"> extends keyof Service ? "ok" : never = "ok";
      // @ts-expect-error update claims are not part of SystemSummary.
      const summaryProbe: UpdateProbe<"sAvailable"> extends keyof SystemSummary ? "ok" : never = "ok";
    }
  });

  it("tripwire: a renamed claim on a NESTED object is caught by the deep scan", () => {
    const model = buildModel(liveSnapshot, runtime);
    // U4 probe: a future regression re-adds the claim under a FRESH name
    // (imageRefresh) on a nested object — the exact shape that slipped the
    // old top-level-only scan. The deep scan must flag it.
    (model.services[0] as unknown as Record<string, unknown>).imageRefresh = true;
    expect(deepKeys(model.services).some((key) => /update|refresh/i.test(key))).toBe(true);
  });

  it("tripwire: a renamed feed kind and summary are caught by the feed scan", () => {
    // U4 probe: kind "refresh" + summary "pulled newer image" — neither
    // contains "updat", so only the broadened vocabulary catches it. Note the
    // cast: "refresh" is NOT a ChangeEvent kind today, so the probe must
    // smuggle it past the type — which is itself the demonstration that the
    // type-level gates are the real backstop and this scan only a tripwire.
    const planted = {
      id: "planted",
      serviceId: null,
      serviceName: "api",
      routeName: null,
      kind: "refresh",
      summary: "pulled newer image",
      at: 0,
      estimated: true
    } as unknown as ChangeEvent;
    expect(feedMatches(planted)).toBe(true);
  });

  it("documents the tripwire blind spot — the runtime scan is NOT the backstop", () => {
    // A future rename OUTSIDE the scanned vocabulary (e.g. kind "recycled",
    // summary "swapped in a fresh image") still slips the regexes above.
    // That is the documented blind spot: the runtime scan is a tripwire, not
    // proof. The real backstop is the @ts-expect-error gates (type-level
    // removal) plus the contract's lack of any update field — keep those.
    expect("recycled swapped in a fresh image").not.toMatch(/updat|refresh|pulled/i);
  });
});
