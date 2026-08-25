import { describe, expect, it } from "vitest";
import type { DockerSnapshot, RuntimeMap } from "@dockermap/contracts";
import { answer } from "./copilot";
import { getDemoResponse } from "./demoData";
import { buildModel } from "./model";

const runtime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], lastUpdated: 0 };
const liveSnapshot: DockerSnapshot = { containers: [{ id: "live-api", name: "api", image: "nginx:1", status: "running", role: "api", networks: [], ports: ["443:443"], mounts: [], dependsOn: [] }], images: [], networks: [], volumes: [], lastUpdated: 0 };

describe("Copilot update-status responses", () => {
  it("uses identical not-collected copy for live and demo models", () => {
    for (const snapshot of [liveSnapshot, getDemoResponse<DockerSnapshot>("/api/snapshot")]) {
      const response = answer(buildModel(snapshot, runtime), "what changed recently");
      expect(response.headline).toBe("Recent and pending change");
      expect(response.body).toEqual([
        "Update status: Not collected — Update checks not wired — DockerMap does not query registries.",
        "Change history: Not collected — Change collectors not wired — DockerMap does not record deploy, restart or failure events."
      ]);
      expect(response.references).toEqual([]);
    }
  });

  it("preserves the unrelated port-answer dispatch", () => {
    expect(answer(buildModel(liveSnapshot, runtime), "show everything using port 443").headline).toBe("Port 443");
  });
});
