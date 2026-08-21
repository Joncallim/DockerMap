import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { DockerSnapshot, RuntimeMap } from "@dockermap/contracts";
import { AppContext, type AppContextValue } from "../context";
import { buildModel } from "../lib/model";
import { changeFeed, causalChain } from "../lib/stubs";
import Changes from "./Changes";
import Home from "./Home";

const emptyRuntime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], lastUpdated: 0 };

function baseContainer(partial: Partial<DockerSnapshot["containers"][number]>): DockerSnapshot["containers"][number] {
  return {
    id: "c_x",
    name: "svc",
    image: "busybox:latest",
    status: "running",
    role: "",
    networks: [],
    ports: [],
    mounts: [],
    dependsOn: [],
    ...partial
  };
}

/**
 * Empty-name fixture: an offline service with NO name recorded. The stub
 * change feed and causal chain must render the explicit "Unavailable service
 * name" fallback in their summaries, never a malformed " became unavailable"
 * sentence, and never emit a /services/ route (the old code produced
 * to="/services/" for the empty name).
 */
const emptyNameSnapshot: DockerSnapshot = {
  containers: [
    baseContainer({ id: "c_empty", name: "", status: "Exited (1)" }),
    baseContainer({ id: "c_api", name: "api", image: "nginx:1", role: "api" })
  ],
  images: [],
  networks: [],
  volumes: [],
  lastUpdated: 0
};

/**
 * Collided-name fixture: two distinct services that both publish "dup" (the
 * daemon redacts distinct identities to the same string). Their events stay
 * visible with the raw identity but must never become /services/dup links.
 */
const collidedNameSnapshot: DockerSnapshot = {
  containers: [
    baseContainer({ id: "c_dup1", name: "dup", status: "Exited (1)" }),
    baseContainer({ id: "c_dup2", name: "dup" }),
    baseContainer({ id: "c_api", name: "api", image: "nginx:1", role: "api" })
  ],
  images: [],
  networks: [],
  volumes: [],
  lastUpdated: 0
};

function contextFor(snapshot: DockerSnapshot): AppContextValue {
  return {
    model: buildModel(snapshot, emptyRuntime),
    loading: false,
    error: null,
    health: null,
    tick: 0,
    openCommand: () => {}
  };
}

function renderScreen(initialPath: string, route: string, element: ReactElement, snapshot: DockerSnapshot) {
  return renderToStaticMarkup(
    <AppContext.Provider value={contextFor(snapshot)}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path={route} element={element} />
        </Routes>
      </MemoryRouter>
    </AppContext.Provider>
  );
}

describe("change-feed and causal-chain identities fail closed", () => {
  it("changeFeed normalizes empty names and carries a null route target", () => {
    const model = buildModel(emptyNameSnapshot, emptyRuntime);
    const events = changeFeed(model);
    // The offline empty-name service ALWAYS produces a failure event.
    const failure = events.find((event) => event.kind === "failure" && event.serviceId === "c_empty");
    expect(failure).toBeDefined();
    expect(failure!.serviceName).toBe("Unavailable service name");
    expect(failure!.routeName).toBeNull();
    expect(failure!.summary).toBe("Unavailable service name became unavailable");
  });

  it("changeFeed keeps collided names visible with a null route target", () => {
    const model = buildModel(collidedNameSnapshot, emptyRuntime);
    expect(model.serviceNameCollisions.has("dup")).toBe(true);
    const failure = changeFeed(model).find((event) => event.kind === "failure" && event.serviceId === "c_dup1");
    expect(failure).toBeDefined();
    expect(failure!.serviceName).toBe("dup");
    expect(failure!.routeName).toBeNull();
    expect(failure!.summary).toBe("dup became unavailable");
    // Unique identities still route.
    const apiEvent = changeFeed(model).find((event) => event.serviceId === "c_api");
    if (apiEvent) expect(apiEvent.routeName).toBe("api");
  });

  it("causalChain uses the explicit fallback for an empty root name", () => {
    const model = buildModel(emptyNameSnapshot, emptyRuntime);
    const chain = causalChain(model);
    expect(chain).not.toBeNull();
    expect(chain![0].serviceName).toBe("Unavailable service name");
    expect(chain![0].text).toBe("Unavailable service name went offline");
  });

  it("Home renders empty-name events as visible non-routable plain text", () => {
    const html = renderScreen("/", "/", <Home />, emptyNameSnapshot);
    // The malformed empty interpolation is gone (old bug: the summary began
    // with a leading space, e.g. " became unavailable"); the fallback summary
    // is visible instead…
    expect(html).toContain("Unavailable service name became unavailable");
    expect(html).toContain("Unavailable service name went offline");
    expect(html).not.toContain("> became unavailable");
    expect(html).not.toContain("> went offline");
    // …and the empty name never emits a /services/ route (old bug: to="/services/").
    expect(html).not.toContain('href="/services/"');
  });

  it("Home renders collided-name events as visible non-routable plain text", () => {
    const html = renderScreen("/", "/", <Home />, collidedNameSnapshot);
    expect(html).toContain("dup became unavailable");
    expect(html).toContain("dup went offline");
    // The collided identity never becomes a /services/dup link.
    expect(html).not.toContain('href="/services/dup"');
  });

  it("Changes renders empty and collided events as plain timeline rows without routes", () => {
    const emptyHtml = renderScreen("/changes", "/changes", <Changes />, emptyNameSnapshot);
    expect(emptyHtml).toContain("Unavailable service name became unavailable");
    expect(emptyHtml).not.toContain('href="/services/"');

    const collidedHtml = renderScreen("/changes", "/changes", <Changes />, collidedNameSnapshot);
    expect(collidedHtml).toContain("dup became unavailable");
    expect(collidedHtml).not.toContain('href="/services/dup"');
  });
});
