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

describe("empty schema-valid identities stay visible and non-routable", () => {
  it("keeps empty image, network, volume, and container strings in the model but out of the routing indexes", () => {
    const model = buildModel(
      {
        containers: [container({ id: "c1", name: "", image: "", networks: [""] })],
        images: [{ image: "", containers: [""], status: "" }],
        networks: [{ id: "net1", name: "", driver: "bridge", internal: false, members: [""] }],
        volumes: [{ id: "vol1", name: "", attachedTo: [""] }],
        lastUpdated: 0
      },
      emptyRuntime
    );
    // The contract permits empty strings and the model keeps the recorded
    // evidence visible in every relationship list…
    expect(model.services[0].image).toBe("");
    expect(model.services[0].networks).toEqual([""]);
    expect(model.networks[0].members).toEqual([""]);
    expect(model.volumes[0].attachedTo).toEqual([""]);
    expect(model.images[0].containers).toEqual([""]);
    // …but empty keys never enter the first-wins routing indexes, so empty
    // identities can never emit a detail link.
    expect(model.imageByRef.has("")).toBe(false);
    expect(model.networkByName.has("")).toBe(false);
    expect(model.volumeByName.has("")).toBe(false);
  });
});

describe("collision-safe redacted identities", () => {
  // Distinct records whose identities sanitize to the SAME published value
  // (the daemon redacts sensitive identity strings to "[redacted]" before
  // publication). A first-wins index would keep only ONE record: the other
  // record's detail route becomes unreachable and every link for the collided
  // value opens the WRONG record. The index must exclude collided keys
  // entirely (lookup fails closed) and report them so the UI can render
  // non-routable text instead of silently routing.
  const collided: DockerSnapshot = {
    containers: [
      container({ id: "c_a", name: "svc-a", image: "img-a:1" }),
      container({ id: "c_b", name: "svc-b", image: "img-b:1" })
    ],
    images: [
      { image: "[redacted]", containers: ["svc-a"], status: "running" },
      { image: "[redacted]", containers: ["svc-b"], status: "exited" }
    ],
    networks: [
      { id: "net_a", name: "[redacted]", driver: "bridge", internal: false, members: ["svc-a"] },
      { id: "net_b", name: "[redacted]", driver: "overlay", internal: true, members: ["svc-b"] },
      { id: "net_ok", name: "bridge1", driver: "bridge", internal: false, members: [] }
    ],
    volumes: [
      { id: "vol_a", name: "[redacted]", attachedTo: ["svc-a"] },
      { id: "vol_b", name: "[redacted]", attachedTo: ["svc-b"] }
    ],
    lastUpdated: 0
  };
  const model = buildModel(collided, emptyRuntime);

  it("keeps EVERY collided record in the arrays so both rows stay visible", () => {
    expect(model.networks).toHaveLength(3);
    expect(model.networks.filter((n) => n.name === "[redacted]")).toHaveLength(2);
    expect(model.volumes).toHaveLength(2);
    expect(model.images).toHaveLength(2);
  });

  it("excludes collided keys from every routing index (lookup fails closed)", () => {
    expect(model.networkByName.has("[redacted]")).toBe(false);
    expect(model.volumeByName.has("[redacted]")).toBe(false);
    expect(model.imageByRef.has("[redacted]")).toBe(false);
    // No record — not even the first — is routable under the collided key,
    // so a link for either record can never open the wrong one.
    expect(model.networkByName.get("[redacted]")).toBeUndefined();
    expect(model.volumeByName.get("[redacted]")).toBeUndefined();
    expect(model.imageByRef.get("[redacted]")).toBeUndefined();
  });

  it("reports collided keys so lists and detail routes can render a collision state", () => {
    expect(model.networkNameCollisions.has("[redacted]")).toBe(true);
    expect(model.volumeNameCollisions.has("[redacted]")).toBe(true);
    expect(model.imageRefCollisions.has("[redacted]")).toBe(true);
  });

  it("leaves unique identities fully routable", () => {
    expect(model.networkByName.get("bridge1")?.id).toBe("net_ok");
    expect(model.networkNameCollisions.has("bridge1")).toBe(false);
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
