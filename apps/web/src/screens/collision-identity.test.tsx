import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { DockerSnapshot, RuntimeMap } from "@dockermap/contracts";
import { AppContext, type AppContextValue } from "../context";
import { buildModel } from "../lib/model";
import { COLLISION_HINT } from "../lib/identity";
import ImageDetail from "./ImageDetail";
import Images from "./Images";
import MapScreen from "./Map";
import NetworkDetail from "./NetworkDetail";
import Networking from "./Networking";
import ServiceDetail from "./ServiceDetail";
import Storage from "./Storage";
import VolumeDetail from "./VolumeDetail";

const emptyRuntime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], lastUpdated: 0 };

/**
 * Collision fixture: DISTINCT records whose identities sanitize to the SAME
 * published value ("[redacted]") after the daemon's publication redaction.
 * Before the collision-safe fix, first-wins maps kept only the FIRST record
 * under the collided key: the second record was unreachable and every list
 * link for the value opened the WRONG record. Both records must stay visible,
 * and neither may route anywhere.
 */
const fixture: DockerSnapshot = {
  containers: [
    {
      id: "c_gw",
      name: "gateway",
      image: "[redacted]",
      status: "running",
      role: "edge proxy",
      networks: ["[redacted]"],
      ports: [],
      mounts: [
        // Collided named-volume mount: its source sanitizes to the same
        // "[redacted]" as BOTH volume records, so volumeByName excludes it.
        // The Map inspector must keep the mount visible as non-routable
        // evidence (collision hint/tag) and never emit a /volumes/ link.
        { id: "m_gw_vol", kind: "named_volume", source: "[redacted]", target: "/data", readOnly: false }
      ],
      dependsOn: []
    },
    {
      id: "c_api",
      name: "api",
      image: "nginx:1",
      status: "running",
      role: "api",
      networks: ["bridge1"],
      ports: [],
      mounts: [],
      dependsOn: []
    }
  ],
  images: [
    { image: "[redacted]", containers: ["gateway"], status: "running" },
    { image: "[redacted]", containers: [], status: "exited" },
    { image: "nginx:1", containers: ["api"], status: "running" }
  ],
  networks: [
    { id: "net_a", name: "[redacted]", driver: "bridge", internal: false, members: ["gateway"] },
    { id: "net_b", name: "[redacted]", driver: "overlay", internal: true, members: [] },
    { id: "net_ok", name: "bridge1", driver: "bridge", internal: false, members: ["api"] }
  ],
  volumes: [
    { id: "vol_a", name: "[redacted]", attachedTo: ["gateway"] },
    { id: "vol_b", name: "[redacted]", attachedTo: ["api"] }
  ],
  lastUpdated: 0
};

const model = buildModel(fixture, emptyRuntime);

const contextValue: AppContextValue = {
  model,
  modelProvenance: "daemon",
  loading: false,
  error: null,
  health: null,
  tick: 0,
  evidenceMode: "live",
  openCommand: () => {}
};

function renderScreen(initialPath: string, route: string, element: ReactElement) {
  return renderToStaticMarkup(
    <AppContext.Provider value={contextValue}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path={route} element={element} />
        </Routes>
      </MemoryRouter>
    </AppContext.Provider>
  );
}

describe("collided redacted identities stay visible and never route", () => {
  it("Networking renders BOTH collided panels as plain text without links or actions", () => {
    const html = renderScreen("/networking", "/networking", <Networking />);
    // Both records render (evidence stays visible)…
    expect(html.split("[redacted]").length - 1).toBe(2);
    // …each carries the collision hint and tag…
    expect(html.split("identity collision").length - 1).toBe(2);
    expect(html.split("Multiple records share this identity after redaction — detail routing is unavailable.").length - 1).toBe(2);
    // …and neither collided row emits a detail link (the encoded identity) or
    // an "Open detail" action.
    expect(html).not.toContain('href="/networks/%5Bredacted%5D"');
    expect(html).not.toContain("Open [redacted]");
    // The unique network keeps its link and action.
    expect(html).toContain('href="/networks/bridge1"');
    expect(html).toContain('aria-label="Open bridge1 network detail"');
  });

  it("NetworkDetail shows a collision state instead of the wrong record", () => {
    const html = renderScreen("/networks/[redacted]", "/networks/:name", <NetworkDetail />);
    expect(html).toContain("Network unavailable");
    expect(html).toContain("Multiple networks share the identity");
    expect(html).toContain("[redacted]");
    expect(html).toContain("after redaction");
    expect(html).toContain('href="/networking"');
    // No record payload may leak: neither the first record's members nor any
    // panel may render, and the not-found copy must not appear either.
    expect(html).not.toContain("Connected containers");
    expect(html).not.toContain("gateway");
    expect(html).not.toContain("Network not found");
  });

  it("Storage renders BOTH collided panels as plain text without links", () => {
    const html = renderScreen("/storage", "/storage", <Storage />);
    expect(html.split("[redacted]").length - 1).toBe(2);
    expect(html.split("identity collision").length - 1).toBe(2);
    expect(html).not.toContain('href="/volumes/%5Bredacted%5D"');
    expect(html).not.toContain("Open detail");
  });

  it("VolumeDetail shows a collision state instead of the wrong record", () => {
    const html = renderScreen("/volumes/[redacted]", "/volumes/:name", <VolumeDetail />);
    expect(html).toContain("Volume unavailable");
    expect(html).toContain("Multiple volumes share the identity");
    expect(html).toContain("[redacted]");
    expect(html).toContain("after redaction");
    expect(html).toContain('href="/storage"');
    expect(html).not.toContain("Connected containers");
    expect(html).not.toContain("gateway");
    expect(html).not.toContain("Volume not found");
  });

  it("Images renders collided rows as plain code text without image-detail links", () => {
    const html = renderScreen("/images", "/images", <Images />);
    // Both collided image rows render (2 "[redacted]" identities + 1 unique)…
    expect(html.split("[redacted]").length - 1).toBe(2);
    expect(html.split("identity collision").length - 1).toBe(2);
    // …and only the unique image emits an image-detail link.
    expect(html.split('href="/images/').length - 1).toBe(1);
    expect(html).toContain('href="/images/nginx%3A1"');
  });

  it("ImageDetail shows a collision state instead of the wrong record", () => {
    const html = renderScreen("/images/[redacted]", "/images/:image", <ImageDetail />);
    expect(html).toContain("Image unavailable");
    expect(html).toContain("Multiple images share the identity");
    expect(html).toContain("[redacted]");
    expect(html).toContain("after redaction");
    expect(html).toContain('href="/images"');
    expect(html).not.toContain("Connected containers");
    expect(html).not.toContain("gateway");
    expect(html).not.toContain("Image not found");
  });

  it("Map and ServiceDetail render collided identities as non-routable chips/text", () => {
    const mapHtml = renderScreen("/map", "/map", <MapScreen initialSelectedId="c_gw" />);
    // The collided network chip and image value stay visible as plain text…
    expect(mapHtml).toContain("[redacted]");
    // …the collided named-volume MOUNT stays visible too: the section renders
    // with the collision hint and tag (pre-fix the mount was filtered out and
    // the whole section disappeared)…
    expect(mapHtml).toContain("Named volumes");
    expect(mapHtml).toContain("identity collision");
    expect(mapHtml).toContain(COLLISION_HINT);
    // …and none of them emit a detail link (map lookups fail closed).
    expect(mapHtml).not.toContain('href="/networks/');
    expect(mapHtml).not.toContain('href="/images/');
    expect(mapHtml).not.toContain('href="/volumes/');

    const detailHtml = renderScreen("/services/gateway", "/services/:name", <ServiceDetail />);
    expect(detailHtml).toContain("[redacted]");
    expect(detailHtml).not.toContain('href="/networks/');
    expect(detailHtml).not.toContain('href="/images/');
    expect(detailHtml).not.toContain('href="/volumes/');
  });
});
