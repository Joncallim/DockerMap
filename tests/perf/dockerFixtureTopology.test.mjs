import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FIXTURE_NAMES,
  FIXTURE_REVISION,
  REFERENCE_SIZES,
  SLOW_COMPOSE_SERVICES,
  buildContainers,
  buildNetworks,
  buildSlowComposeProject,
  buildTopology,
  buildVolumes
} from "./dockerFixtureTopology.mjs";

describe("deterministic Docker fixture topology", () => {
  it("is byte-identical for the same size and scenario", () => {
    for (const size of REFERENCE_SIZES) {
      assert.equal(
        JSON.stringify(buildTopology({ containers: size })),
        JSON.stringify(buildTopology({ containers: size }))
      );
    }
  });

  it("publishes exactly the requested container count with unique identities", () => {
    for (const size of REFERENCE_SIZES) {
      const containers = buildContainers(size);
      assert.equal(containers.length, size);
      assert.equal(new Set(containers.map((container) => container.Id)).size, size);
      assert.equal(new Set(containers.map((container) => container.Names[0])).size, size);
    }
  });

  it("stays inside the published contract bounds and is secret-free", () => {
    const topology = buildTopology({ containers: 250 });
    assert.ok(topology.volumes.length <= 250);
    assert.ok(topology.networks.length <= 5);
    for (const container of topology.containers) {
      assert.match(container.Id, /^[a-f0-9]{64}$/);
      assert.ok(container.Mounts.length <= 2);
      assert.ok(container.Ports.length <= 2);
      for (const value of Object.values(container.Labels)) {
        assert.doesNotMatch(String(value), /(password|secret|token|api[-_]?key)/i);
      }
    }
    assert.equal(topology.revision, FIXTURE_REVISION);
  });

  it("rejects unsupported sizes and scenarios instead of inventing a host", () => {
    assert.throws(() => buildContainers(0), /between 1 and 250/);
    assert.throws(() => buildContainers(251), /between 1 and 250/);
    assert.throws(() => buildContainers(25.5), /between 1 and 250/);
    assert.throws(() => buildContainers(25, "not-a-scenario"), /Unknown fixture scenario/);
  });

  it("changes only the Docker inventory when the topology generation advances", () => {
    const before = buildTopology({ containers: 100, scenario: "docker-topology-change" });
    const after = buildTopology({
      containers: 100,
      scenario: "docker-topology-change",
      topologyGeneration: 1
    });
    assert.equal(before.containers.length, after.containers.length);
    assert.notDeepEqual(
      before.containers.map((container) => container.Id),
      after.containers.map((container) => container.Id)
    );
    // Networks and volumes are unchanged, so the observed change is Docker topology only.
    assert.deepEqual(before.networks, after.networks);
    assert.deepEqual(before.volumes, after.volumes);
  });

  it("produces a bounded, valid Compose project for the slow-projection scenario", () => {
    const project = buildSlowComposeProject();
    assert.match(project, /^name: dockermap-fixture\nservices:\n/);
    assert.equal(project.trimEnd().split("\n").length, 2 + SLOW_COMPOSE_SERVICES * 6);
    assert.ok(SLOW_COMPOSE_SERVICES <= 400);
  });

  it("declares exactly the fixture names the evidence contract measures", () => {
    // Pinned on both sides on purpose: the contract declares these seven names
    // and the fixture daemon must be able to serve every one of them. The
    // collector validates its artifact against the contract matrix, so any
    // drift here fails the capture closed rather than producing a quiet gap.
    assert.deepEqual([...FIXTURE_NAMES].sort(), [
      "docker-topology-change",
      "provider-only-revision-change",
      "reference-100",
      "reference-25",
      "reference-250",
      "slow-bounded-compose-projection",
      "unavailable-optional-provider"
    ]);
  });

  it("keeps volumes and networks sized from the container count", () => {
    assert.equal(buildVolumes(25).length, 5);
    assert.equal(buildVolumes(100).length, 20);
    assert.equal(buildNetworks(25).length, 1);
    assert.equal(buildNetworks(250).length, 5);
  });
});
