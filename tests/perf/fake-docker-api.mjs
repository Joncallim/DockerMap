#!/usr/bin/env node
/**
 * Deterministic fake Docker Engine API for the time-to-answer benchmark (#335).
 *
 * It serves only the three inventory endpoints the daemon's read-only
 * collector uses, from the shared fixture topology generator, over a unix
 * socket. It never touches a real Docker daemon, the network, or the host
 * filesystem beyond its own socket.
 *
 * Usage:
 *   node tests/perf/fake-docker-api.mjs --socket /tmp/fake.sock \
 *     --containers 100 --scenario reference [--ready-file /tmp/fake.ready]
 *
 * Control (benchmark harness only, not a Docker route):
 *   POST /__fixture/topology-generation/<n>  -> bump the published generation
 *   GET  /__fixture/state                    -> current generation and counts
 */
import { createServer } from "node:http";
import { unlinkSync, writeFileSync } from "node:fs";
import { buildContainers, buildNetworks, buildVolumes, FIXTURE_REVISION } from "./dockerFixtureTopology.mjs";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .flatMap((value, index, all) => (value.startsWith("--") ? [[value.slice(2), all[index + 1]]] : []))
);
const socketPath = args.socket;
if (!socketPath || socketPath.startsWith("--")) {
  throw new Error("Usage: fake-docker-api.mjs --socket <path> --containers <n> [--scenario <name>] [--ready-file <path>]");
}
const containers = Number(args.containers ?? 25);
const scenario = args.scenario ?? "reference";
if (!Number.isInteger(containers) || containers < 1 || containers > 250) {
  throw new Error("--containers must be an integer between 1 and 250.");
}

const state = { generation: 0, requests: 0 };

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload)
  });
  response.end(payload);
}

const server = createServer((request, response) => {
  state.requests += 1;
  const raw = request.url ?? "/";
  const [path, query = ""] = raw.split("?");
  // bollard addresses the versioned path; accept both shapes.
  const route = path.replace(/^\/v\d+(?:\.\d+)?/, "") || "/";

  const control = /^\/__fixture\/topology-generation\/(\d+)$/.exec(path);
  if (control && request.method === "POST") {
    state.generation = Number(control[1]);
    json(response, 200, { generation: state.generation });
    return;
  }
  if (path === "/__fixture/state") {
    json(response, 200, { ...state, containers, scenario, fixtureRevision: FIXTURE_REVISION });
    return;
  }
  if (route === "/_ping") {
    response.writeHead(200, {
      "content-type": "text/plain",
      "api-version": "1.44",
      "docker-experimental": "false",
      "ostype": "linux"
    });
    response.end("OK");
    return;
  }
  if (route === "/version") {
    json(response, 200, {
      Platform: { Name: "DockerMap fixture" },
      Components: [{ Name: "Engine", Version: "29.0.0", Details: { ApiVersion: "1.44", Os: "linux" } }],
      Version: "29.0.0",
      ApiVersion: "1.44",
      MinAPIVersion: "1.24",
      GitCommit: "fixture",
      GoVersion: "fixture",
      Os: "linux",
      Arch: "amd64",
      KernelVersion: args.kernel ?? "fixture",
      BuildTime: "2026-09-23T00:00:00.000000000+00:00"
    });
    return;
  }
  if (route === "/info") {
    json(response, 200, {
      ID: "FIXTURE:DOCKER:ENGINE",
      Containers: containers,
      ContainersRunning: containers,
      ContainersPaused: 0,
      ContainersStopped: 0,
      Images: 1,
      Driver: "overlay2",
      ServerVersion: "29.0.0",
      OperatingSystem: "DockerMap fixture",
      OSType: "linux",
      Architecture: "x86_64",
      NCPU: 4,
      MemTotal: 8_589_934_592,
      Name: "dockermap-fixture"
    });
    return;
  }
  if (route === "/containers/json") {
    json(response, 200, buildContainers(containers, scenario, state.generation));
    return;
  }
  if (route === "/networks") {
    json(response, 200, buildNetworks(containers));
    return;
  }
  if (route === "/volumes") {
    json(response, 200, { Volumes: buildVolumes(containers), Warnings: [] });
    return;
  }
  json(response, 404, {
    message: `fixture daemon does not serve ${request.method} ${raw} (query: ${query})`
  });
});

try {
  unlinkSync(socketPath);
} catch {
  // no stale socket
}
server.listen(socketPath, () => {
  if (args["ready-file"]) writeFileSync(args["ready-file"], String(process.pid));
  process.stdout.write(`fake-docker-api listening on ${socketPath} (${containers} containers, ${scenario})\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
