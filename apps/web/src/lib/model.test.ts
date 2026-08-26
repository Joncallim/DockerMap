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

  it("never derives data edges from ambiguous, empty, or repeated member refs", () => {
    // "dup" is a redaction-collided name shared by TWO services: a ref to it
    // must stay unresolved (VolumeDetail shows the member as unresolved, so a
    // data edge to the FIRST occurrence would contradict that state).
    const volumes: VolumeRecord[] = [
      { id: "vol_ambig", name: "ambig", attachedTo: ["dup", "web"] },
      { id: "vol_empty", name: "empty", attachedTo: ["", "web"] },
      // The same unique service referenced twice (once by name, once by id):
      // dedupes to ONE member, so no self-edge (data:web~web:vol_self) may
      // derive and no pair may form.
      { id: "vol_self", name: "self", attachedTo: ["web", "c_web"] },
      // Positive control: unique refs still link.
      { id: "vol_ok", name: "ok", attachedTo: ["web", "api"] }
    ];
    const model = buildModel(
      snapshot(
        [
          container({ id: "c_web", name: "web" }),
          container({ id: "c_api", name: "api" }),
          container({ id: "c_dup1", name: "dup" }),
          container({ id: "c_dup2", name: "dup" })
        ],
        [],
        volumes
      ),
      emptyRuntime
    );
    const data = model.relationships.filter((r) => r.kind === "data");
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ from: "c_web", to: "c_api", kind: "data" });
    // No edge may ever have the same service on both ends (self-edge).
    for (const edge of model.relationships) {
      expect(edge.from).not.toBe(edge.to);
    }
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
    // …but empty keys never enter the collision-safe routing indexes, so empty
    // identities can never emit a detail link.
    expect(model.imageByRef.has("")).toBe(false);
    expect(model.networkByName.has("")).toBe(false);
    expect(model.volumeByName.has("")).toBe(false);
  });
});

describe("inventory presentation ordering", () => {
  it("canonicalizes equivalent reordered network and volume input before presentation", () => {
    const networks: NetworkRecord[] = [
      { id: "network_b", name: "beta", driver: "bridge", internal: false, members: [] },
      { id: "network_a", name: "alpha", driver: "bridge", internal: false, members: [] }
    ];
    const volumes: VolumeRecord[] = [
      { id: "volume_b", name: "beta", attachedTo: [] },
      { id: "volume_a", name: "alpha", attachedTo: [] }
    ];
    const first = buildModel(snapshot([], networks, volumes), emptyRuntime);
    const second = buildModel(snapshot([], [...networks].reverse(), [...volumes].reverse()), emptyRuntime);

    expect(first.networks.map((network) => network.id)).toEqual(["network_a", "network_b"]);
    expect(second.networks.map((network) => network.id)).toEqual(first.networks.map((network) => network.id));
    expect(first.volumes.map((volume) => volume.id)).toEqual(["volume_a", "volume_b"]);
    expect(second.volumes.map((volume) => volume.id)).toEqual(first.volumes.map((volume) => volume.id));
  });
});

describe("service and runtime identity indexes", () => {
  it("keeps duplicate and empty service evidence while excluding ambiguous semantic lookups", () => {
    const model = buildModel(
      snapshot([
        container({ id: "container_a", name: "[redacted]", role: "api" }),
        container({ id: "container_b", name: "[redacted]", role: "api" }),
        container({ id: "", name: "", dependsOn: ["[redacted]", "api"] })
      ]),
      emptyRuntime
    );

    expect(model.services).toHaveLength(3);
    expect(model.serviceNameCollisions.has("[redacted]")).toBe(true);
    expect(model.serviceAliasCollisions.has("api")).toBe(true);
    expect(model.byName.has("[redacted]")).toBe(false);
    expect(model.byId.has("")).toBe(false);
    // Ambiguous/empty refs never enter the SEMANTIC dependsOn list…
    expect(model.services[2].dependsOn).toEqual([]);
    // …but every RAW occurrence stays visible for non-routable rendering:
    // "[redacted]" is a redaction-collided alias and "api" an ambiguous role
    // alias — neither may silently disappear from the relationship list.
    expect(model.services[2].dependencyOccurrences).toEqual([
      { ref: "[redacted]", resolvedId: null },
      { ref: "api", resolvedId: null }
    ]);
  });

  it("keeps unique resolutions in both the raw occurrences and the semantic dependsOn list", () => {
    const model = buildModel(
      snapshot([
        container({ id: "container_web", name: "web", dependsOn: ["api"] }),
        container({ id: "container_api", name: "api", role: "api" })
      ]),
      emptyRuntime
    );
    expect(model.byName.get("web")!.dependencyOccurrences).toEqual([{ ref: "api", resolvedId: "container_api" }]);
    expect(model.byName.get("web")!.dependsOn).toEqual(["container_api"]);
  });

  it("excludes duplicate runtime ids instead of silently selecting the last node", () => {
    const runtime: RuntimeMap = {
      nodes: [
        { id: "runtime-duplicate", provider: "docker", type: "container", label: "first", status: "running", metadata: {} },
        { id: "runtime-duplicate", provider: "docker", type: "container", label: "second", status: "running", metadata: {} },
        { id: "", provider: "docker", type: "container", label: "empty", status: "running", metadata: {} }
      ],
      edges: [],
      diagnostics: [],
      lastUpdated: 0
    };
    const model = buildModel(snapshot([]), runtime);

    expect(model.runtime.nodes).toHaveLength(3);
    expect(model.runtime.idCollisions.has("runtime-duplicate")).toBe(true);
    expect(model.runtime.byId.has("runtime-duplicate")).toBe(false);
    expect(model.runtime.byId.has("")).toBe(false);
  });
});

describe("fail-closed dependency resolution for duplicate and unknown container ids", () => {
  it("keeps duplicate container_* ids unresolvable and collision-tagged for EVERY alias", () => {
    // Two records share the canonical id `container_dup`: a ref to that id —
    // or to ANY alias of either record (unique name, role, stripped id) —
    // must stay null. The old value-based owner set collapsed both records
    // into ONE owner and resolved the id to itself, entering the semantic
    // graph and attributing dependents to a duplicate occurrence.
    const model = buildModel(
      snapshot([
        container({ id: "container_dup", name: "web", role: "api", dependsOn: ["container_dup"] }),
        container({ id: "container_dup", name: "worker", role: "worker" })
      ]),
      emptyRuntime
    );
    expect(model.serviceAliasCollisions.has("container_dup")).toBe(true);
    expect(model.serviceAliasCollisions.has("web")).toBe(true);
    expect(model.serviceAliasCollisions.has("worker")).toBe(true);
    expect(model.serviceAliasCollisions.has("dup")).toBe(true);
    expect(model.services[0].dependsOn).toEqual([]);
    expect(model.services[0].dependencyOccurrences).toEqual([{ ref: "container_dup", resolvedId: null }]);
    // No semantic edge and no dependent attribution to either occurrence.
    expect(model.relationships).toHaveLength(0);
    expect(model.services[0].dependents).toEqual([]);
    expect(model.services[1].dependents).toEqual([]);
  });

  it("never resolves an alias pointing at a duplicate canonical id", () => {
    // `db` is the UNIQUE role of a record whose canonical id collides with
    // another record: resolving it would pick an arbitrary occurrence.
    const model = buildModel(
      snapshot([
        container({ id: "container_db", name: "primary", role: "db" }),
        container({ id: "container_db", name: "secondary", role: "replica" }),
        container({ id: "container_app", name: "app", dependsOn: ["db"] })
      ]),
      emptyRuntime
    );
    expect(model.serviceAliasCollisions.has("db")).toBe(true);
    expect(model.byName.get("app")!.dependsOn).toEqual([]);
    expect(model.byName.get("app")!.dependencyOccurrences).toEqual([{ ref: "db", resolvedId: null }]);
    expect(model.services[0].dependents).toEqual([]);
    expect(model.services[1].dependents).toEqual([]);
    expect(model.relationships).toHaveLength(0);
  });

  it("leaves unknown container_* references unresolved instead of self-resolving", () => {
    // The removed `container_` fallback used to resolve ANY unknown
    // container_-prefixed ref to itself, fabricating a resolvedId and a
    // semantic edge for a service that does not exist.
    const model = buildModel(
      snapshot([
        container({ id: "container_app", name: "app", dependsOn: ["container_ghost"] }),
        container({ id: "container_web", name: "web", dependsOn: ["container_app"] })
      ]),
      emptyRuntime
    );
    expect(model.services[0].dependencyOccurrences).toEqual([{ ref: "container_ghost", resolvedId: null }]);
    expect(model.services[0].dependsOn).toEqual([]);
    // The ghost ref must never emit a semantic edge FROM the app service.
    expect(model.relationships.filter((r) => r.from === "container_app")).toHaveLength(0);
    // Positive control: a UNIQUE canonical id is its own alias and still
    // resolves through the index.
    expect(model.services[1].dependencyOccurrences).toEqual([{ ref: "container_app", resolvedId: "container_app" }]);
    expect(model.services[1].dependsOn).toEqual(["container_app"]);
    expect(model.relationships).toHaveLength(1);
    expect(model.relationships[0]).toMatchObject({ from: "container_web", to: "container_app", kind: "depends_on" });
  });

  it("requires the SOURCE endpoint to be unique too — a collided source never joins semantics", () => {
    // Two records share the canonical id `dup`; only the SECOND depends on the
    // unique `target`. The target resolves fine, but the edge's SOURCE is
    // ambiguous: attributing the dependency to `dup` would point at the FIRST
    // occurrence (the layout springs to it) and report `dup` as a downstream
    // of `target` — evidence about the WRONG record. No semantic join may
    // enter dependents, relationships, impact, or (via relationships) springs.
    const model = buildModel(
      snapshot([
        container({ id: "dup", name: "first", dependsOn: [] }),
        container({ id: "dup", name: "second", dependsOn: ["target"] }),
        container({ id: "target", name: "target" })
      ]),
      emptyRuntime
    );
    const first = model.services.find((service) => service.name === "first")!;
    const second = model.services.find((service) => service.name === "second")!;
    const target = model.byName.get("target")!;

    // No semantic edge may reference the ambiguous id in EITHER direction…
    expect(model.relationships.filter((relationship) => relationship.from === "dup" || relationship.to === "dup")).toEqual([]);
    // …the unique target gains NO dependent attribution…
    expect(target.dependents).toEqual([]);
    // …impact reports nothing downstream of the target…
    expect(computeImpact(model, "target").downstream).toEqual([]);
    // …and the collided SOURCE keeps an empty semantic dependsOn while its
    // raw occurrence stays VISIBLE as occurrence-qualified unresolved
    // evidence (the ref itself is preserved, resolution is null).
    expect(second.dependsOn).toEqual([]);
    expect(second.dependencyOccurrences).toEqual([{ ref: "target", resolvedId: null }]);
    expect(first.dependsOn).toEqual([]);
    // Positive control: a UNIQUE source still joins the semantic graph.
    const control = buildModel(
      snapshot([
        container({ id: "app", name: "app", dependsOn: ["target"] }),
        container({ id: "target", name: "target" })
      ]),
      emptyRuntime
    );
    expect(control.relationships).toHaveLength(1);
    expect(control.byName.get("target")!.dependents).toEqual(["app"]);
    expect(computeImpact(control, "target").downstream).toEqual(["app"]);
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
