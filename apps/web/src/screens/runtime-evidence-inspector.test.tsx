import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DockerSnapshot, RuntimeMap } from "@dockermap/contracts";
import { buildModel } from "../lib/model";
import { testProviderStates } from "../lib/testProviderStates";
import { RuntimeEvidenceInspector } from "./Runtime";

const snapshot: DockerSnapshot = {
  containers: [], images: [], networks: [], volumes: [], lastUpdated: 1, modelRevision: "test-revision"
};

const runtime: RuntimeMap = {
  nodes: [
    { id: "container-api", provider: "docker", type: "container", label: "api", status: "running", metadata: {} },
    { id: "network-app", provider: "docker", type: "docker_network", label: "app-net", status: null, metadata: {} }
  ],
  edges: [
    {
      source: "container-api",
      target: "network-app",
      relationship: "connected_to",
      metadata: {},
      evidenceRefs: [{
        version: 1,
        id: "docker-network-membership-api-app",
        provider: "docker",
        kind: "docker_network_membership",
        assertionKind: "observed",
        summary: "Docker reported container network membership",
        subjectRef: "container-api",
        collectedAt: 1,
        providerRevision: "docker-observation-1",
        freshness: "fresh"
      }]
    },
    {
      source: "container-api",
      target: "network-app",
      relationship: "related_to",
      metadata: {},
      evidenceRefs: []
    }
  ],
  diagnostics: [],
  lastUpdated: 1,
  modelRevision: "test-revision",
  providerStates: testProviderStates
};

const model = buildModel(snapshot, runtime);

describe("Runtime relationship evidence inspector", () => {
  it("renders canonical observed evidence rather than inventing confidence", () => {
    const html = renderToStaticMarkup(<RuntimeEvidenceInspector edge={runtime.edges[0]} model={model} />);

    expect(html).toContain("Relationship evidence");
    expect(html).toContain("api");
    expect(html).toContain("app-net");
    expect(html).toContain("Observed fact");
    expect(html).toContain("docker network membership");
    expect(html).toContain("Docker reported container network membership");
    expect(html).toContain("Current at collection");
    expect(html).toContain("docker-observation-1");
    expect(html).not.toContain("Confidence");
  });

  it("makes a relationship with no migrated evidence explicit", () => {
    const html = renderToStaticMarkup(<RuntimeEvidenceInspector edge={runtime.edges[1]} model={model} />);

    expect(html).toContain("No evidence references yet — this relationship family is still migrating.");
    expect(html).not.toContain("Observed fact");
  });
});
