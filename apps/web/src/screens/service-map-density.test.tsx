import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { DockerSnapshot, RuntimeMap } from "@dockermap/contracts";
import { AppContext, type AppContextValue } from "../context";
import ServiceMap from "../components/ServiceMap";
import { buildModel } from "../lib/model";
import MapScreen from "./Map";

const runtime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], lastUpdated: 0 };
const containers = Array.from({ length: 32 }, (_, index) => ({
  id: `service-${String(index).padStart(2, "0")}`,
  name: `service-${String(index).padStart(2, "0")}`,
  image: "busybox:1",
  status: index === 0 ? "Exited (1)" : "running",
  role: index === 0 ? "database" : "service",
  networks: ["network-main"],
  ports: index < 3 ? [`${8000 + index}/tcp`] : [],
  mounts: [],
  dependsOn: index === 1 ? ["service-00"] : index === 2 ? ["service-01"] : []
}));
const snapshot = (records = containers): DockerSnapshot => ({
  containers: records,
  images: [],
  networks: [{ id: "network-main", name: "main", driver: "bridge", internal: false, members: records.map((service) => service.name) }],
  volumes: [],
  lastUpdated: 0
});

function renderMap(source: DockerSnapshot) {
  const value: AppContextValue = { model: buildModel(source, runtime), modelProvenance: "live", loading: false, error: null, health: null, tick: 0, evidenceMode: "live", openCommand: () => {} };
  return renderToStaticMarkup(<AppContext.Provider value={value}><MemoryRouter initialEntries={["/map"]}><Routes><Route path="/map" element={<MapScreen />} /></Routes></MemoryRouter></AppContext.Provider>);
}

describe("high-density Service Map", () => {
  it("keeps the default graph to recorded topology while retaining every observed service in the directory", () => {
    const html = renderMap(snapshot());
    expect(html).toContain("Observed services</span><strong class=\"metric-value\">32");
    expect(html).toContain("Recorded start-order links</span><strong class=\"metric-value\">2");
    expect(html).toContain("No recorded start order</span><strong class=\"metric-value\">29");
    // The graph has only the three evidence-connected services, not 32 labels.
    expect(html.split('<g class="node').length - 1).toBe(3);
    // The directory keeps every service reachable, including the 29 isolates.
    expect(html.split('class="runtime-node-btn').length - 1).toBe(32);
    expect(html).toContain("Shared networks and storage are context, not proof of communication or causality.");
    expect(html).not.toContain("via main");
  });

  it("renders identically after an equivalent container reorder", () => {
    expect(renderMap(snapshot([...containers].reverse()))).toBe(renderMap(snapshot()));
  });

  it("keeps the map text alternative scoped to rendered relationships", () => {
    const model = buildModel(snapshot(), runtime);
    const html = renderToStaticMarkup(<ServiceMap model={model} selectedId={null} onSelect={() => {}} filter={(service) => service.id === "service-00"} />);
    expect(html).toContain("No Compose start-order declarations are visible in this graph.");
    expect(html).not.toContain("service-01 declares start order after service-00.");
  });

  it("explains an empty filtered graph visibly", () => {
    const model = buildModel(snapshot(), runtime);
    const html = renderToStaticMarkup(<ServiceMap model={model} selectedId={null} onSelect={() => {}} filter={() => false} emptyMessage="No attention services in this snapshot." />);
    expect(html).toContain("No attention services in this snapshot.");
    expect(html).toContain('role="status"');
  });
});
