import { describe, expect, it } from "vitest";
import type {
  ComposeGraph,
  ComposeScan,
  DiagnosticsReport,
  DockerSnapshot,
  RuntimeMap,
  StatusResponse
} from "./index";
import composeGraphFixture from "../../../tests/fixtures/contracts/compose-graph.json";
import composeScanFixture from "../../../tests/fixtures/contracts/compose-scan.json";
import diagnosticsFixture from "../../../tests/fixtures/contracts/diagnostics.json";
import snapshotFixture from "../../../tests/fixtures/contracts/mock-snapshot.json";
import runtimeMapDaemonFixture from "../../../tests/fixtures/contracts/runtime-map-daemon-emitted.json";
import runtimeMapFixture from "../../../tests/fixtures/contracts/runtime-map-expanded.json";
import statusFixture from "../../../tests/fixtures/contracts/status.json";

describe("contract fixtures", () => {
  it("match the TypeScript API contracts", () => {
    const snapshot: DockerSnapshot = snapshotFixture;
    const composeScan: ComposeScan = composeScanFixture;
    const composeGraph: ComposeGraph = composeGraphFixture;
    const runtimeMap: RuntimeMap = runtimeMapFixture;
    const runtimeMapDaemon: RuntimeMap = runtimeMapDaemonFixture;
    const status: StatusResponse = statusFixture;
    const diagnostics: DiagnosticsReport = diagnosticsFixture;

    expect(snapshot.containers[0]?.mounts[0]?.kind).toBe("bind");
    expect(composeScan.correlations[0]?.status).toBe("matched");
    expect(composeGraph.edges[0]?.relationship).toBe("declares_mount");
    expect(runtimeMap.nodes.find((node) => node.id === "runtime_cloudflare_edge")?.service?.health?.state).toBe("healthy");
    expect(runtimeMap.nodes.find((node) => node.id === "runtime_npm_app")?.package?.update?.advisories[0]?.severity).toBe("high");
    expect(runtimeMap.nodes.find((node) => node.id === "runtime_package_tsx")?.package?.update?.available).toBe(true);
    expect(runtimeMap.edges.some((edge) => edge.relationship === "wants")).toBe(true);
    expect(status.service).toBe("dockermap");
    expect(status.containers).toBe(status.healthy + status.attention + status.offline);
    expect(status.containersRunning).toBeGreaterThan(0);
    expect(diagnostics.generatedAt).toBeGreaterThan(0);
    expect(diagnostics.entries.some((entry) => entry.source === "compose")).toBe(true);
    expect(diagnostics.entries.some((entry) => entry.source === "runtime")).toBe(true);
  });

  it("daemon-emitted runtime map fixture matches the contract and real collector shape", () => {
    const runtimeMap: RuntimeMap = runtimeMapDaemonFixture;
    const container = runtimeMap.nodes.find((node) => node.type === "container");
    expect(container?.layer).toBe("container");
    expect(container?.service?.name).toBe(container?.label);
    expect(container?.service?.status).toBe("running");
    expect(runtimeMap.nodes.some((node) => node.type === "docker_network" && node.layer === "network")).toBe(true);
    expect(runtimeMap.nodes.some((node) => node.type === "docker_volume" && node.layer === "storage")).toBe(true);
  });
});
