import { describe, expect, it } from "vitest";
import type { DockerSnapshot, RuntimeMap } from "@dockermap/contracts";
import { getDemoResponse } from "./demoData";
import { buildModel, summarize } from "./model";
import { changeFeed } from "./stubs";

const runtime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], lastUpdated: 0 };
const liveSnapshot: DockerSnapshot = {
  containers: [{ id: "live-api", name: "api", image: "nginx:1", status: "running", role: "api", networks: [], ports: [], mounts: [], dependsOn: [] }],
  images: [], networks: [], volumes: [], lastUpdated: 0
};

describe("no synthetic update claim reaches the model", () => {
  it("key-scans live and demo models and their feeds", () => {
    const demoSnapshot = getDemoResponse<DockerSnapshot>("/api/snapshot");
    for (const snapshot of [liveSnapshot, demoSnapshot]) {
      const model = buildModel(snapshot, runtime);
      const summary = summarize(model);
      for (const value of [...model.services, summary]) {
        expect(Object.keys(value).some((key) => /update/i.test(key))).toBe(false);
      }
      for (const event of changeFeed(model)) {
        expect(`${event.kind} ${event.summary} ${event.detail ?? ""}`).not.toMatch(/updat/i);
      }
      const service = model.services[0];
      // @ts-expect-error update claims are not part of Service.
      expect(service["update" + "Available"]).toBeUndefined();
      // @ts-expect-error update claims are not part of SystemSummary.
      expect(summary["updates" + "Available"]).toBeUndefined();
    }
  });
});
