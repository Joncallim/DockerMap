import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { DockerSnapshot, RuntimeMap } from "@dockermap/contracts";
import { AppContext, type AppContextValue } from "../context";
import { buildModel } from "../lib/model";
import ImageDetail from "./ImageDetail";
import Images from "./Images";
import MapScreen from "./Map";
import NetworkDetail from "./NetworkDetail";
import ServiceDetail from "./ServiceDetail";
import VolumeDetail from "./VolumeDetail";

const emptyRuntime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], lastUpdated: 0 };

/**
 * Fixture with schema-valid EMPTY identity strings in every new detail
 * relationship: a network member, a volume consumer, an image consumer, a
 * service image/network ref, and an empty-name container (which puts the ""
 * key into byName so the resolved-count guard must exclude it). Empty strings
 * must stay VISIBLY RENDERABLE as "Unavailable …" plain text and never emit a
 * link.
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
    },
    {
      id: "c_anon",
      name: "",
      image: "nginx:1",
      status: "running",
      role: "worker",
      networks: [],
      ports: [],
      mounts: [],
      dependsOn: []
    },
    {
      id: "c_empty",
      name: "empty-svc",
      image: "",
      status: "running",
      role: "worker",
      networks: [""],
      ports: [],
      mounts: [],
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
    // byName carries the "" key (empty-name container), but the resolved count
    // must exclude the empty member identity: members ["", "app"] → 1 resolved.
    expect(html).toContain("<strong>1</strong><span>resolved members</span>");
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
    // Exactly one image-detail link (nginx:1) — an erroneous anchor on the
    // empty image row would fail this count.
    expect(html.split('href="/images/').length - 1).toBe(1);
    // The empty row's placeholder is a <code>, not an anchor.
    expect(html).toContain('<code class="image-name">Unavailable image reference</code>');
  });

  it("ServiceDetail links a resolvable image reference and renders an empty one as plain text", () => {
    const resolved = renderScreen("/services/app", "/services/:name", <ServiceDetail />);
    expect(resolved).toContain('href="/images/nginx%3A1"');
    expect(resolved).toContain("nginx:1");

    const empty = renderScreen("/services/empty-svc", "/services/:name", <ServiceDetail />);
    expect(empty).toContain("Unavailable image reference");
    // The empty image reference must never emit an image-detail link.
    expect(empty).not.toContain('href="/images/');
  });

  it("Map renders the empty-image/empty-network service as non-routable placeholder chips", () => {
    const html = renderScreen("/map", "/map", <MapScreen initialSelectedId="c_empty" />);
    expect(html).toContain("Service Map");
    expect(html).toContain("Unavailable image reference");
    expect(html).toContain("Unavailable network name");
    // Neither the empty image ref nor the empty network ref may link.
    expect(html).not.toContain('href="/images/');
    expect(html).not.toContain('href="/networks/');
  });
});

describe("disclosure aria-controls targets stay mounted in both states", () => {
  it("NetworkDetail keeps the internals id mounted collapsed and expanded", () => {
    const collapsed = renderScreen("/networks/bridge1", "/networks/:name", <NetworkDetail />);
    expect(collapsed).toContain('id="network-internals"');
    expect(collapsed).toContain("Network IDs are hidden until you ask for them.");

    const expanded = renderScreen("/networks/bridge1", "/networks/:name", <NetworkDetail defaultOpen />);
    expect(expanded).toContain('id="network-internals"');
    expect(expanded).toContain('<span class="kv-label">Network ID</span>');
  });

  it("VolumeDetail keeps the internals id mounted collapsed and expanded", () => {
    const collapsed = renderScreen("/volumes/vol1", "/volumes/:name", <VolumeDetail />);
    expect(collapsed).toContain('id="volume-internals"');
    expect(collapsed).toContain("Volume IDs are hidden until you ask for them.");

    const expanded = renderScreen("/volumes/vol1", "/volumes/:name", <VolumeDetail defaultOpen />);
    expect(expanded).toContain('id="volume-internals"');
    expect(expanded).toContain('<span class="kv-label">Volume ID</span>');
  });

  it("ImageDetail keeps the internals id mounted collapsed and expanded", () => {
    const collapsed = renderScreen("/images/nginx:1", "/images/:image", <ImageDetail />);
    expect(collapsed).toContain('id="image-internals"');
    expect(collapsed).toContain("Exact image references and raw status are hidden until you ask for them.");

    const expanded = renderScreen("/images/nginx:1", "/images/:image", <ImageDetail defaultOpen />);
    expect(expanded).toContain('id="image-internals"');
    expect(expanded).toContain('<span class="kv-label">Exact image reference</span>');
  });
});
