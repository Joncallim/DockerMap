import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { DockerSnapshot, RuntimeMap } from "@dockermap/contracts";
import { AppContext, type AppContextValue } from "../context";
import { buildModel } from "../lib/model";
import ImageDetail from "./ImageDetail";
import Images from "./Images";
import NetworkDetail from "./NetworkDetail";
import VolumeDetail from "./VolumeDetail";

const emptyRuntime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], lastUpdated: 0 };

/**
 * Fixture with schema-valid EMPTY identity strings in every new detail
 * relationship: a network member, a volume consumer, an image consumer, and a
 * service image/network ref. Empty strings must stay VISIBLY RENDERABLE as
 * "Unavailable …" plain text and never emit a link.
 */
const fixture: DockerSnapshot = {
  containers: [
    {
      id: "c_app",
      name: "app",
      image: "nginx:1",
      status: "running",
      role: "web",
      networks: [],
      ports: [],
      mounts: [{ id: "m1", kind: "named_volume", source: "vol1", target: "/data", readOnly: false }],
      dependsOn: []
    }
  ],
  images: [
    { image: "nginx:1", containers: ["", "app"], status: "running" },
    { image: "", containers: [""], status: "" }
  ],
  networks: [{ id: "net1", name: "bridge1", driver: "bridge", internal: false, members: ["", "app"] }],
  volumes: [{ id: "vol1", name: "vol1", attachedTo: ["", "app"] }],
  lastUpdated: 0
};

const model = buildModel(fixture, emptyRuntime);

const contextValue: AppContextValue = {
  model,
  loading: false,
  error: null,
  health: null,
  tick: 0,
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

function countLinks(html: string): number {
  return html.split('href="/services/').length - 1;
}

describe("detail surfaces keep empty identities visible and non-routable", () => {
  it("NetworkDetail renders an empty member as plain fallback text without a link", () => {
    const html = renderScreen("/networks/bridge1", "/networks/:name", <NetworkDetail />);
    expect(html).toContain("Unavailable container name");
    expect(html).toContain('href="/services/app"');
    // Only the resolved "app" member may link; the empty member must not.
    expect(countLinks(html)).toBe(1);
  });

  it("VolumeDetail renders an empty consumer as plain fallback text without a link", () => {
    const html = renderScreen("/volumes/vol1", "/volumes/:name", <VolumeDetail />);
    expect(html).toContain("Unavailable container name");
    expect(html).toContain("Mount details unavailable in this snapshot");
    expect(html).toContain('href="/services/app"');
    // ConsumerList (app) + mount row (app) = 2; the empty consumer never links.
    expect(countLinks(html)).toBe(2);
  });

  it("ImageDetail renders an empty consumer as plain fallback text without a link", () => {
    const html = renderScreen("/images/nginx:1", "/images/:image", <ImageDetail />);
    expect(html).toContain("Unavailable container name");
    expect(html).toContain('href="/services/app"');
    expect(countLinks(html)).toBe(1);
  });

  it("Images renders an empty consumer chip and empty image row as fallback text without links", () => {
    const html = renderScreen("/images", "/images", <Images />);
    expect(html).toContain("Unavailable container name");
    expect(html).toContain("Unavailable image reference");
    expect(html).toContain('href="/images/nginx%3A1"');
    expect(html).toContain('href="/services/app"');
    // Only the resolved "app" chip links; the empty chip must not.
    expect(countLinks(html)).toBe(1);
  });
});
