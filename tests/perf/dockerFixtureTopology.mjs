/**
 * Deterministic Docker fixture topology for the time-to-answer benchmark
 * (#335). One generator, shared by the fixture daemon that the benchmark
 * collects from and by anything that needs to describe the same host.
 *
 * Properties this module deliberately guarantees:
 * - deterministic: same (containers, scenario) always yields byte-identical JSON
 * - secret-free: every value is generated here; nothing is read from the host
 * - contract-bounded: sizes stay inside the published DockerMap caps
 * - no host contact: it never talks to Docker, the network, or the filesystem
 */
import { createHash } from "node:crypto";

export const FIXTURE_REVISION = "dockermap-v1/time-to-answer-fixtures-1";

/** Reference container counts from the issue. */
export const REFERENCE_SIZES = [25, 100, 250];

/** The closed fixture set the evidence contract measures. */
export const FIXTURE_NAMES = [
  "reference-25",
  "reference-100",
  "reference-250",
  "provider-only-revision-change",
  "docker-topology-change",
  "slow-bounded-compose-projection",
  "unavailable-optional-provider"
];

const SCENARIOS = [
  "reference",
  "provider-only-revision-change",
  "docker-topology-change",
  "slow-bounded-compose-projection",
  "unavailable-optional-provider"
];

/** Bounded, deterministic CPU-only cost used by the slow-Compose scenario. */
export const SLOW_COMPOSE_SERVICES = 400;

function digest(seed) {
  return createHash("sha256").update(seed).digest("hex");
}

function id(seed) {
  return digest(seed);
}

function name(index) {
  return `dockermap-fixture-${String(index).padStart(4, "0")}`;
}

function networkName(index) {
  return index === 0 ? "dockermap-fixture-internal" : `dockermap-fixture-net-${index}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

/**
 * Build the container summary list for a size and scenario.
 *
 * `topologyGeneration` lets the docker-topology-change scenario publish a
 * changed inventory from the SAME fixture daemon without touching anything
 * else, so the only difference the daemon observes is the Docker model.
 */
export function buildContainers(containers, scenario = "reference", topologyGeneration = 0) {
  if (!Number.isInteger(containers) || containers < 1 || containers > 250) {
    throw new Error("Fixture container count must be an integer between 1 and 250.");
  }
  if (!SCENARIOS.includes(scenario)) throw new Error(`Unknown fixture scenario: ${scenario}`);
  const suffix = topologyGeneration === 0 ? "" : `-g${topologyGeneration}`;
  const list = [];
  for (let index = 0; index < containers; index += 1) {
    const base = `${scenario}${suffix}/${index}`;
    const label = (key) => `${key}`;
    const networks = {
      [networkName(index % 5)]: {
        NetworkID: id(`network/${index % 5}`),
        EndpointID: id(`endpoint/${base}`),
        Gateway: "172.30.0.1",
        IPAddress: `172.30.${Math.floor(index / 250) + 1}.${(index % 250) + 2}`,
        IPPrefixLen: 24,
        MacAddress: `02:42:ac:1e:00:${pad((index % 250) + 2)}`,
        Aliases: [name(index)]
      }
    };
    const ports = [];
    const mounts = [];
    if (index % 11 === 0) {
      ports.push({
        IP: "0.0.0.0",
        PrivatePort: 80,
        PublicPort: 8000 + (index % 1000),
        Type: "tcp"
      });
    }
    if (index % 17 === 0) {
      ports.push({ IP: "127.0.0.1", PrivatePort: 443, PublicPort: 9000 + (index % 1000), Type: "tcp" });
    }
    if (index % 13 === 0) {
      mounts.push({
        Type: "bind",
        Source: "/var/run/docker.sock",
        Destination: "/var/run/docker.sock",
        Mode: "",
        RW: true
      });
    }
    if (index % 5 === 0) {
      mounts.push({
        Type: "volume",
        Name: `dockermap-fixture-vol-${index % 25}`,
        Source: `/var/lib/docker/volumes/dockermap-fixture-vol-${index % 25}/_data`,
        Destination: "/data",
        Mode: "",
        RW: true
      });
    }
    const labels = {
      "com.dockermap.fixture": label(`${scenario}${suffix}`),
      "com.dockermap.fixture.index": String(index)
    };
    if (index % 7 === 0) {
      // A bounded subset carries a complete Compose identity so the private
      // Compose/runtime binding path has deterministic candidates.
      labels["com.docker.compose.project"] = "dockermap-fixture";
      labels["com.docker.compose.service"] = `fixture-service-${index % 40}`;
      labels["com.docker.compose.config-hash"] = digest(`config-hash/${index % 40}`).slice(0, 64);
      labels["com.docker.compose.project.config_files"] = "/srv/dockermap-fixture/compose.yaml";
    }
    const exited = scenario === "docker-topology-change" && index % 3 === 0;
    list.push({
      Id: id(`container/${base}`),
      Names: [`/${name(index)}`],
      Image: "dockermap/fixture:1",
      ImageID: id("image/1").slice(0, 12),
      Command: "/bin/dockermap-fixture",
      Created: 1_700_000_000 + index,
      Ports: ports,
      Labels: labels,
      State: exited ? "exited" : "running",
      Status: exited ? "Exited (0) 1 hours ago" : "Up 1 hours",
      HostConfig: { NetworkMode: "bridge" },
      NetworkSettings: { Networks: networks },
      Mounts: mounts
    });
  }
  return list;
}

export function buildNetworks(containers) {
  const count = Math.min(5, Math.max(1, Math.ceil(containers / 50)));
  const list = [];
  for (let index = 0; index < count; index += 1) {
    list.push({
      Name: networkName(index),
      Id: id(`network/${index}`),
      Created: "2026-09-23T00:00:00.000000000Z",
      Scope: "local",
      Driver: "bridge",
      EnableIPv6: false,
      IPAM: {
        Driver: "default",
        Options: null,
        Config: [{ Subnet: "172.30.0.0/24", Gateway: "172.30.0.1" }]
      },
      Internal: index === 0,
      Attachable: false,
      Ingress: false,
      ConfigFrom: { Network: "" },
      ConfigOnly: false,
      Containers: {},
      Options: {},
      Labels: { "com.dockermap.fixture": "network" }
    });
  }
  return list;
}

export function buildVolumes(containers) {
  const count = Math.max(1, Math.ceil(containers / 5));
  const list = [];
  for (let index = 0; index < count; index += 1) {
    list.push({
      CreatedAt: "2026-09-23T00:00:00Z",
      Driver: "local",
      Labels: { "com.dockermap.fixture": "volume" },
      Mountpoint: `/var/lib/docker/volumes/dockermap-fixture-vol-${index}/_data`,
      Name: `dockermap-fixture-vol-${index}`,
      Options: {},
      Scope: "local"
    });
  }
  return list;
}

/** One deterministic Compose project tree for the slow-but-bounded scenario. */
export function buildSlowComposeProject(services = SLOW_COMPOSE_SERVICES) {
  const lines = ["name: dockermap-fixture", "services:"];
  for (let index = 0; index < services; index += 1) {
    lines.push(`  fixture-service-${index}:`);
    lines.push("    image: dockermap/fixture:1");
    lines.push("    volumes:");
    lines.push(`      - ./fixture-data-${index}:/data`);
    lines.push("    depends_on:");
    lines.push(`      - fixture-service-${(index + 1) % services}`);
  }
  return `${lines.join("\n")}\n`;
}

export function buildTopology({ containers, scenario = "reference", topologyGeneration = 0 }) {
  return {
    revision: FIXTURE_REVISION,
    scenario,
    containers: buildContainers(containers, scenario, topologyGeneration),
    networks: buildNetworks(containers),
    volumes: buildVolumes(containers)
  };
}
