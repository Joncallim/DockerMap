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
 * link. Also carries empty-ID records (network/volume/container), an empty
 * mount source vs an empty volume ID (must NOT match), an empty mount target,
 * and duplicate empty mount IDs on one service.
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
      mounts: [
        { id: "m1", kind: "named_volume", source: "vol1", target: "/data", readOnly: false },
        { id: "m_empty_src", kind: "named_volume", source: "", target: "/emptysrc", readOnly: false },
        { id: "m_empty_target", kind: "named_volume", source: "vol1", target: "", readOnly: false }
      ],
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
      mounts: [
        { id: "", kind: "named_volume", source: "vol1", target: "/dup-a", readOnly: false },
        { id: "", kind: "named_volume", source: "vol1", target: "/dup-b", readOnly: false }
      ],
      dependsOn: []
    },
    {
      id: "c_config",
      name: "config-svc",
      image: "",
      status: "running",
      role: "worker",
      networks: ["", "", "bridge1", "bridge1"],
      ports: [],
      mounts: [
        { id: "m_empty", kind: "named_volume", source: "", target: "", readOnly: false },
        { id: "m_anon", kind: "named_volume", source: null, target: "/anon", readOnly: false }
      ],
      dependsOn: []
    },
    {
      id: "",
      name: "no-id-svc",
      image: "",
      status: "running",
      role: "worker",
      networks: [],
      ports: [],
      mounts: [],
      dependsOn: []
    }
  ],
  images: [
    { image: "nginx:1", containers: ["", "app"], status: "running" },
    { image: "", containers: [""], status: "" }
  ],
  networks: [
    { id: "net1", name: "bridge1", driver: "bridge", internal: false, members: ["", "app"] },
    { id: "", name: "empty-net", driver: "bridge", internal: true, members: [] }
  ],
  volumes: [
    { id: "vol1", name: "vol1", attachedTo: ["", "app"] },
    { id: "", name: "empty-vol", attachedTo: ["app"] }
  ],
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

function renderScreen(initialPath: string, route: string, element: ReactElement, modelOverride?: typeof model) {
  const value = modelOverride ? { ...contextValue, model: modelOverride } : contextValue;
  return renderToStaticMarkup(
    <AppContext.Provider value={value}>
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
    // internal === false is labeled literally; nothing asserts exposure.
    expect(html).toContain("not internal");
    expect(html).not.toContain("externally reachable");
  });

  it("VolumeDetail renders an empty consumer as plain fallback text without a link", () => {
    const html = renderScreen("/volumes/vol1", "/volumes/:name", <VolumeDetail />);
    expect(html).toContain("Unavailable container name");
    expect(html).toContain("Mount details unavailable in this snapshot");
    expect(html).toContain('href="/services/app"');
    // A matched mount with an empty target renders the explicit fallback.
    expect(html).toContain("Unavailable mount target");
    // ConsumerList (app) + 2 matched mount rows (m1, m_empty_target) = 3; the
    // empty consumer and the unmatched empty-source mount never link.
    expect(countLinks(html)).toBe(3);
  });

  it("VolumeDetail never matches an empty mount source against an empty volume ID", () => {
    const html = renderScreen("/volumes/empty-vol", "/volumes/:name", <VolumeDetail defaultOpen />);
    // app's empty-source mount (target /emptysrc) must NOT match empty-vol's
    // empty ID: "" === "" would have inflated both counts before the guard.
    expect(html).toContain("Mount details unavailable in this snapshot");
    expect(html).toContain("<strong>0</strong><span>read-only mounts</span>");
    expect(html).toContain("<strong>0</strong><span>read-write mounts</span>");
    expect(html).not.toContain("emptysrc");
    // The expanded internals show an explicit placeholder for the empty ID.
    expect(html).toContain("Unavailable volume ID");
  });

  it("ImageDetail renders an empty consumer as plain fallback text without a link", () => {
    const html = renderScreen("/images/nginx:1", "/images/:image", <ImageDetail />);
    expect(html).toContain("Unavailable container name");
    expect(html).toContain('href="/services/app"');
    expect(countLinks(html)).toBe(1);
    // derive_images keeps the FIRST consumer's status — label it as a sample,
    // never as an image-wide aggregate.
    expect(html).toContain("Sample consumer status");
    expect(html).not.toContain("Raw aggregate status");
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

  it("ServiceDetail Configuration tab renders empty identities as visible placeholders without links", () => {
    const html = renderScreen("/services/config-svc", "/services/:name", <ServiceDetail defaultTab="config" />);
    // Empty named-volume source renders the volume placeholder; null stays "anonymous".
    expect(html).toContain("Unavailable volume name");
    expect(html).toContain("<code>anonymous</code>");
    // An empty mount target renders the explicit fallback, never an empty <code>.
    expect(html).toContain("<code>Unavailable mount target</code>");
    // Duplicate empty networks each render their own placeholder…
    expect(html.split("Unavailable network name").length - 1).toBe(2);
    // …and duplicate resolved networks each emit their own link (occurrence-qualified keys).
    expect(html.split('href="/networks/bridge1"').length - 1).toBe(2);
    // Empty identities never emit detail links.
    expect(html).not.toContain('href="/volumes/');
    expect(html).not.toContain('href="/images/');
  });

  it("ServiceDetail Overview maps each network identity independently before joining", () => {
    const html = renderScreen("/services/config-svc", "/services/:name", <ServiceDetail />);
    // Per-entry mapping preserves duplicate empties and mixed identities;
    // a raw join would have collapsed this to ", , bridge1, bridge1".
    expect(html).toContain("Unavailable network name, Unavailable network name, bridge1, bridge1");
    // The em dash is reserved for a genuinely empty array.
    const none = renderScreen("/services/app", "/services/:name", <ServiceDetail />);
    expect(none).toContain('<span class="kv-value">—</span>');
  });

  it("Map renders the empty-image/empty-network service as non-routable placeholder chips", () => {
    const html = renderScreen("/map", "/map", <MapScreen initialSelectedId="c_empty" />);
    expect(html).toContain("Service Map");
    expect(html).toContain("Unavailable image reference");
    expect(html).toContain("Unavailable network name");
    // Neither the empty image ref nor the empty network ref may link.
    expect(html).not.toContain('href="/images/');
    expect(html).not.toContain('href="/networks/');
    // Duplicate resolved mounts with duplicate EMPTY ids both render — the
    // occurrence-qualified key keeps reconciliation stable.
    expect(html.split('href="/volumes/vol1"').length - 1).toBe(2);
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

  it("NetworkDetail renders an unavailable-ID placeholder when the network ID is empty", () => {
    const expanded = renderScreen("/networks/empty-net", "/networks/:name", <NetworkDetail defaultOpen />);
    expect(expanded).toContain('id="network-internals"');
    expect(expanded).toContain('<span class="kv-label">Network ID</span>');
    expect(expanded).toContain("Unavailable network ID");
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
    expect(collapsed).toContain("Exact image references and sample consumer status are hidden until you ask for them.");

    const expanded = renderScreen("/images/nginx:1", "/images/:image", <ImageDetail defaultOpen />);
    expect(expanded).toContain('id="image-internals"');
    expect(expanded).toContain('<span class="kv-label">Exact image reference</span>');
  });

  it("ServiceDetail keeps the internals id mounted collapsed and expanded", () => {
    const collapsed = renderScreen("/services/config-svc", "/services/:name", <ServiceDetail defaultTab="config" />);
    expect(collapsed).toContain('id="service-internals"');
    expect(collapsed).toContain("Container IDs, raw image refs and port bindings are hidden until you ask for them.");

    const expanded = renderScreen("/services/config-svc", "/services/:name", <ServiceDetail defaultTab="config" defaultOpen />);
    expect(expanded).toContain('id="service-internals"');
    expect(expanded).toContain('<span class="kv-label">Container ID</span>');
    // The expanded exact-image field renders the empty image as a placeholder, never a link.
    expect(expanded).toContain("Unavailable image reference");
    expect(expanded).not.toContain('href="/images/');
  });

  it("ServiceDetail internals render an unavailable-ID placeholder when the container ID is empty", () => {
    const expanded = renderScreen("/services/no-id-svc", "/services/:name", <ServiceDetail defaultTab="config" defaultOpen />);
    expect(expanded).toContain('id="service-internals"');
    expect(expanded).toContain('<span class="kv-label">Container ID</span>');
    expect(expanded).toContain("Unavailable container ID");
  });
});

describe("image status and network driver display use one qualified fallback value", () => {
  // F1: differing consumer states — record.status is derive_images' FIRST
  // consumer sample, so it must be labeled as a sample, never image-wide truth.
  const mixed: DockerSnapshot = {
    containers: [
      { id: "c_mixed_a", name: "svc-a", image: "mixed:1", status: "running", role: "web", networks: [], ports: [], mounts: [], dependsOn: [] },
      { id: "c_mixed_b", name: "svc-b", image: "mixed:1", status: "exited", role: "worker", networks: [], ports: [], mounts: [], dependsOn: [] }
    ],
    images: [{ image: "mixed:1", containers: ["svc-a", "svc-b"], status: "running" }],
    networks: [],
    volumes: [],
    lastUpdated: 0
  };

  it("ImageDetail qualifies the header tag and reuses ONE sample status in all three locations", () => {
    const html = renderScreen("/images/mixed:1", "/images/:image", <ImageDetail defaultOpen />, buildModel(mixed, emptyRuntime));
    // The header tag is visibly qualified, never a bare unqualified status.
    expect(html).toContain('<span class="tag tag-muted">Sample consumer status: running</span>');
    // The qualified phrase appears exactly once (the header tag).
    expect(html.split("Sample consumer status: running").length - 1).toBe(1);
    // Overview and internals reuse the same single value through their own label.
    expect(html.split('<span class="kv-label">Sample consumer status</span><span class="kv-value mono">running</span>').length - 1).toBe(2);
    // Consumers keep their own differing states — the sample is not image-wide truth.
    expect(html).toContain(">offline<");
  });

  // F1: the contract permits "" — a non-empty image with an empty status must
  // render the explicit fallback in the header tag, Overview, and internals.
  const blank: DockerSnapshot = {
    containers: [
      { id: "c_blank", name: "svc-a", image: "blank:1", status: "running", role: "web", networks: [], ports: [], mounts: [], dependsOn: [] }
    ],
    images: [{ image: "blank:1", containers: ["svc-a"], status: "" }],
    networks: [],
    volumes: [],
    lastUpdated: 0
  };

  it("ImageDetail renders Unavailable image status in header, Overview, and internals when status is empty", () => {
    const html = renderScreen("/images/blank:1", "/images/:image", <ImageDetail defaultOpen />, buildModel(blank, emptyRuntime));
    expect(html).toContain('<span class="tag tag-muted">Sample consumer status: Unavailable image status</span>');
    expect(html.split("Unavailable image status").length - 1).toBe(3);
    // No empty tag or blank status value may remain.
    expect(html).not.toContain('<span class="tag tag-muted"></span>');
    expect(html).not.toContain('<span class="kv-value mono"></span>');
  });

  // F2: multiple resolved consumers in the SAME state plus one unresolved — the
  // count is distinct states among RESOLVED consumers only.
  const twin: DockerSnapshot = {
    containers: [
      { id: "c_twin_a", name: "svc-a", image: "twin:1", status: "running", role: "web", networks: [], ports: [], mounts: [], dependsOn: [] },
      { id: "c_twin_b", name: "svc-b", image: "twin:1", status: "running", role: "worker", networks: [], ports: [], mounts: [], dependsOn: [] }
    ],
    images: [{ image: "twin:1", containers: ["svc-a", "svc-b", ""], status: "running" }],
    networks: [],
    volumes: [],
    lastUpdated: 0
  };

  it("ImageDetail labels the fourth count distinct resolved service states", () => {
    const html = renderScreen("/images/twin:1", "/images/:image", <ImageDetail />, buildModel(twin, emptyRuntime));
    expect(html).toContain("<strong>2</strong><span>resolved consumers</span>");
    expect(html).toContain("<strong>1</strong><span>unresolved consumers</span>");
    expect(html).toContain("<strong>1</strong><span>distinct resolved service states</span>");
    expect(html).not.toContain("<span>service states</span>");
  });

  // F3: a schema-valid empty driver on a non-empty network must not blank the
  // header tag or the Overview value.
  const nodriver: DockerSnapshot = {
    containers: [
      { id: "c_drv", name: "app", image: "nginx:1", status: "running", role: "web", networks: [], ports: [], mounts: [], dependsOn: [] }
    ],
    images: [],
    networks: [{ id: "net_x", name: "nodriver", driver: "", internal: false, members: ["app"] }],
    volumes: [],
    lastUpdated: 0
  };

  it("NetworkDetail renders Unavailable network driver in the header tag and Overview when the driver is empty", () => {
    const html = renderScreen("/networks/nodriver", "/networks/:name", <NetworkDetail />, buildModel(nodriver, emptyRuntime));
    expect(html).toContain('<span class="tag tag-muted">Unavailable network driver</span>');
    expect(html).toContain('<span class="kv-label">Driver</span><span class="kv-value">Unavailable network driver</span>');
    expect(html.split("Unavailable network driver").length - 1).toBe(2);
    expect(html).not.toContain('<span class="kv-value"></span>');
  });
});
