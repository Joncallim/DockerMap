import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { DockerSnapshot } from "@dockermap/contracts";
import { AppContext, type AppContextValue } from "../context";
import { runtimeFixture } from "../lib/atlas/fixtures";
import { projectRuntimeMap } from "../lib/atlas/project";
import { buildModel } from "../lib/model";
import RuntimeScreen from "./Runtime";

const snapshot: DockerSnapshot = { containers: [], images: [], networks: [], volumes: [], lastUpdated: 1, modelRevision: "atlas-handoff-r1" };

describe("Atlas source-exact cross-screen handoffs", () => {
  it("offers Runtime handoff only for a current exact Atlas runtime source", () => {
    const runtime = runtimeFixture(2);
    const atlas = projectRuntimeMap(runtime);
    const first = atlas.model.subjects.find((subject) => subject.routability === "routable")!;
    const value: AppContextValue = {
      model: buildModel(snapshot, runtime), atlas, modelProvenance: "live", loading: false, error: null,
      health: null, tick: 0, evidenceMode: "live", openCommand: () => {}
    };
    const html = renderToStaticMarkup(<AppContext.Provider value={value}><MemoryRouter><RuntimeScreen /></MemoryRouter></AppContext.Provider>);
    expect(html).toContain(`href="/atlas?subject=${encodeURIComponent(first.key)}"`);
    expect(html).toContain("Open in Atlas");
    expect(html).not.toContain("runtime_subject_000&amp;label");
  });
});
