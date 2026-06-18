import { describe, expect, it } from "vitest";
import type {
  ComposeGraph,
  ComposeScan,
  DockerSnapshot,
  RuntimeMap
} from "./index";
import composeGraphFixture from "../../../tests/fixtures/contracts/compose-graph.json";
import composeScanFixture from "../../../tests/fixtures/contracts/compose-scan.json";
import snapshotFixture from "../../../tests/fixtures/contracts/mock-snapshot.json";
import runtimeMapFixture from "../../../tests/fixtures/contracts/runtime-map.json";

describe("contract fixtures", () => {
  it("match the TypeScript API contracts", () => {
    const snapshot: DockerSnapshot = snapshotFixture;
    const composeScan: ComposeScan = composeScanFixture;
    const composeGraph: ComposeGraph = composeGraphFixture;
    const runtimeMap: RuntimeMap = runtimeMapFixture;

    expect(snapshot.containers[0]?.mounts[0]?.kind).toBe("bind");
    expect(composeScan.correlations[0]?.status).toBe("matched");
    expect(composeGraph.edges[0]?.relationship).toBe("declares_mount");
    expect(runtimeMap.nodes[0]?.provider).toBe("docker");
  });
});
