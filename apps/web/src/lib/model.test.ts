import { describe, expect, it } from "vitest";
import type {
  ContainerRecord,
  DockerSnapshot,
  NetworkRecord,
  RuntimeMap,
  VolumeRecord
} from "@dockermap/contracts";
import { buildModel, computeImpact, hashString, stateForStatus, summarize } from "./model";

const emptyRuntime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], lastUpdated: 0 };

function container(partial: Partial<ContainerRecord> & Pick<ContainerRecord, "id" | "name">): ContainerRecord {
  return {
    image: "busybox:latest",
    status: "running",
    role: "",
    networks: [],
    ports: [],
    mounts: [],
    dependsOn: [],
    ...partial
  };
}

function snapshot(
  containers: ContainerRecord[],
  networks: NetworkRecord[] = [],
  volumes: VolumeRecord[] = []
): DockerSnapshot {
  return { containers, images: [], networks, volumes, lastUpdated: 0 };
}

describe("stateForStatus", () => {
  it("maps canonical Docker status strings", () => {
    expect(stateForStatus("running")).toBe("healthy");
    expect(stateForStatus("healthy")).toBe("healthy");
    expect(stateForStatus("paused")).toBe("warning");
    expect(stateForStatus("restarting")).toBe("updating");
    expect(stateForStatus("created")).toBe("updating");
    expect(stateForStatus("exited")).toBe("offline");
    expect(stateForStatus("dead")).toBe("offline");
    expect(stateForStatus("unhealthy")).toBe("degraded");
  });

  it("maps free-form `docker ps` status text", () => {
    expect(stateForStatus("Up 3 hours")).toBe("healthy");
    expect(stateForStatus("Up 2 days (healthy)")).toBe("healthy");
    expect(stateForStatus("Restarting (1) 2 seconds ago")).toBe("updating");
    expect(stateForStatus("Exited (0) 2 hours ago")).toBe("offline");
    expect(stateForStatus("Paused")).toBe("warning");
  });

  it("falls back to unknown for nullish or unrecognized statuses", () => {
    expect(stateForStatus(null)).toBe("unknown");
    expect(stateForStatus(undefined)).toBe("unknown");
    expect(stateForStatus("")).toBe("unknown");
    expect(stateForStatus("reincarnating")).toBe("unknown");
  });
});

describe("splitImage (via buildModel)", () => {
  it("splits repo and tag at the last colon after the last slash", () => {
    const model = buildModel(snapshot([container({ id: "c1", name: "web", image: "nginx:1.27-alpine" })]), emptyRuntime);
    expect(model.services[0].imageRepo).toBe("nginx");
    expect(model.services[0].imageTag).toBe("1.27-alpine");
  });

  it("keeps registry hosts with ports in the repo", () => {
    const model = buildModel(snapshot([container({ id: "c1", name: "web", image: "localhost:5000/app:1.0" })]), emptyRuntime);
    expect(model.services[0].imageRepo).toBe("localhost:5000/app");
    expect(model.services[0].imageTag).toBe("1.0");
  });

  it("defaults to latest when no tag is present", () => {
    const model = buildModel(snapshot([container({ id: "c1", name: "web", image: "redis" })]), emptyRuntime);
    expect(model.services[0].imageRepo).toBe("redis");
    expect(model.services[0].imageTag).toBe("latest");
  });

  it("derives a short tag from a digest", () => {
    const digest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const model = buildModel(snapshot([container({ id: "c1", name: "web", image: `img@${digest}` })]), emptyRuntime);
    expect(model.services[0].imageRepo).toBe("img");
    expect(model.services[0].imageTag).toBe(digest.slice(0, 12));
  });
});

describe("classifyKind (via buildModel)", () => {
  it("classifies services by role and image", () => {
    const model = buildModel(
      snapshot([
        container({ id: "c_gw", name: "gw", image: "nginx:alpine", role: "edge proxy" }),
        container({ id: "c_api", name: "api", image: "python:3.11", role: "api" }),
        container({ id: "c_db", name: "db", image: "postgres:16", role: "primary database" }),
        container({ id: "c_cache", name: "cache", image: "redis:7", role: "cache and queue broker" }),
        container({ id: "c_w", name: "w", image: "python:3.11", role: "worker" }),
        container({ id: "c_misc", name: "misc", image: "busybox", role: "sidecar" })
      ]),
      emptyRuntime
    );
    const kindByName = new Map(model.services.map((s) => [s.name, s.kind]));
    expect(kindByName.get("gw")).toBe("proxy");
    expect(kindByName.get("api")).toBe("api");
    expect(kindByName.get("db")).toBe("database");
    expect(kindByName.get("cache")).toBe("cache");
    expect(kindByName.get("w")).toBe("worker");
    expect(kindByName.get("misc")).toBe("service");
  });
});

describe("buildModel depends_on resolution", () => {
  it("resolves role and container-name references to container ids", () => {
    const model = buildModel(
      snapshot([
        container({ id: "container_web", name: "web", dependsOn: ["api"] }),
        container({ id: "container_api", name: "api", role: "api" })
      ]),
      emptyRuntime
    );
    expect(model.byName.get("web")!.dependsOn).toEqual(["container_api"]);
  });

  it("resolves project-prefixed container names alongside role names", () => {
    const model = buildModel(
      snapshot([
        container({ id: "container_app", name: "app", dependsOn: ["redis", "proj_db_1"] }),
        container({ id: "container_redis", name: "proj_redis_1", role: "redis" }),
        container({ id: "container_db", name: "proj_db_1", role: "db" })
      ]),
      emptyRuntime
    );
    expect(model.byName.get("app")!.dependsOn).toEqual(["container_redis", "container_db"]);
  });
});

describe("buildRelationships (via buildModel)", () => {
  it("emits depends_on edges with health derived from the target state", () => {
    const model = buildModel(
      snapshot([
        container({ id: "c_app", name: "app", dependsOn: ["c_db"], status: "running" }),
        container({ id: "c_db", name: "db", status: "Exited (0) 2 hours ago" })
      ]),
      emptyRuntime
    );
    expect(model.relationships).toHaveLength(1);
    expect(model.relationships[0]).toMatchObject({ from: "c_app", to: "c_db", kind: "depends_on", health: "failing" });
  });

  it("links services sharing a volume with data relationships", () => {
    const volumes: VolumeRecord[] = [{ id: "vol_shared", name: "shared", attachedTo: ["app", "worker"] }];
    const model = buildModel(
      snapshot(
        [container({ id: "c_app", name: "app" }), container({ id: "c_worker", name: "worker" })],
        [],
        volumes
      ),
      emptyRuntime
    );
    const data = model.relationships.filter((r) => r.kind === "data");
    expect(data).toHaveLength(1);
    expect(data[0].from).toBe("c_app");
    expect(data[0].to).toBe("c_worker");
  });
});

describe("computeImpact", () => {
  const impactModel = buildModel(
    snapshot([
      container({ id: "c_a", name: "a", dependsOn: [] }),
      container({ id: "c_b", name: "b", dependsOn: ["c_a"] }),
      container({ id: "c_c", name: "c", dependsOn: ["c_b"] }),
      container({ id: "c_d", name: "d", dependsOn: ["c_b"] })
    ]),
    emptyRuntime
  );

  it("walks the transitive dependency chain downstream", () => {
    const impact = computeImpact(impactModel, "c_a");
    expect(impact.downstream.sort()).toEqual(["c_b", "c_c", "c_d"]);
    expect(impact.upstream).toEqual([]);
  });

  it("walks the transitive dependency chain upstream", () => {
    const impact = computeImpact(impactModel, "c_c");
    expect(impact.upstream.sort()).toEqual(["c_a", "c_b"]);
    expect(impact.downstream).toEqual([]);
  });

  it("reports direct neighbors only and never the service itself", () => {
    const impact = computeImpact(impactModel, "c_b");
    expect(impact.upstream.sort()).toEqual(["c_a"]);
    expect(impact.downstream.sort()).toEqual(["c_c", "c_d"]);
    expect(impact.neighbors.has("c_b")).toBe(false);
    expect(impact.neighbors.has("c_a")).toBe(true);
    expect(impact.neighbors.has("c_c")).toBe(true);
  });
});

describe("summarize", () => {
  it("counts states and attention across the model", () => {
    const model = buildModel(
      snapshot([
        container({ id: "c1", name: "one", status: "running" }),
        container({ id: "c2", name: "two", status: "unhealthy" }),
        container({ id: "c3", name: "three", status: "paused" }),
        container({ id: "c4", name: "four", status: "Exited (1)" })
      ]),
      emptyRuntime
    );
    const summary = summarize(model);
    expect(summary.total).toBe(4);
    expect(summary.healthy).toBe(1);
    expect(summary.degraded).toBe(1);
    expect(summary.warning).toBe(1);
    expect(summary.offline).toBe(1);
    expect(summary.attention).toBe(3);
    // updateAvailable is hash-derived per container; assert the range, not exact counts.
    expect(summary.updatesAvailable).toBeGreaterThanOrEqual(0);
    expect(summary.updatesAvailable).toBeLessThanOrEqual(summary.total);
  });
});

describe("hashString", () => {
  it("is deterministic and normalized to [0, 1)", () => {
    const first = hashString("container_api");
    expect(hashString("container_api")).toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(1);
  });

  it("spreads distinct inputs apart", () => {
    const inputs = ["a", "b", "c", "container_api", "container_db", "container_redis"];
    expect(new Set(inputs.map(hashString)).size).toBe(inputs.length);
  });
});
