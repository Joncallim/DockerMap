import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { DockerSnapshot, RuntimeMap } from "@dockermap/contracts";
import { AppContext, type AppContextValue } from "../context";
import Copilot from "../screens/Copilot";
import { answer } from "./copilot";
import { getDemoResponse } from "./demoData";
import { buildModel } from "./model";

const runtime: RuntimeMap = { nodes: [], edges: [], diagnostics: [], lastUpdated: 0 };

function snapshot(containers: DockerSnapshot["containers"]): DockerSnapshot {
  return { containers, images: [], networks: [], volumes: [], lastUpdated: 0 };
}

const healthy = (id: string, extra: Partial<DockerSnapshot["containers"][number]> = {}): DockerSnapshot["containers"][number] => ({
  id, name: id, image: "nginx:1", status: "running", role: "api", networks: [], ports: [], mounts: [], dependsOn: [], ...extra
});

describe("A. evidence authority must be exact-matched", () => {
  it("null/null authority produces no substantive answer", () => {
    const model = buildModel(snapshot([healthy("api")]), runtime);
    const response = answer(model, "show unhealthy services", null, null);
    expect(response.evidence).toBe("unavailable");
    expect(response.body.join(" ")).not.toMatch(/healthy|attention/i);
  });

  it("mismatched live/demo authority is not labelled sample data", () => {
    const model = buildModel(snapshot([healthy("api")]), runtime);
    const response = answer(model, "show unhealthy services", "live", "demo");
    expect(response.evidence).toBe("unavailable");
  });

  it("mismatched demo/live authority is not labelled sample data", () => {
    const model = buildModel(snapshot([healthy("api")]), runtime);
    const response = answer(model, "show unhealthy services", "demo", "live");
    expect(response.evidence).toBe("unavailable");
  });

  it("mock/live mismatched authority is not labelled sample data", () => {
    const model = buildModel(snapshot([healthy("api")]), runtime);
    const response = answer(model, "show unhealthy services", "mock", "live");
    expect(response.evidence).toBe("unavailable");
  });

  it("exact live/live may answer with a real kind", () => {
    const model = buildModel(snapshot([healthy("api")]), runtime);
    expect(answer(model, "show unhealthy services", "live", "live").evidence).not.toBe("unavailable");
  });

  it("exact demo/demo answers as sample data", () => {
    const demo = buildModel(getDemoResponse<DockerSnapshot>("/api/snapshot"), runtime);
    expect(answer(demo, "show unhealthy services", "demo", "demo").evidence).toBe("demo");
  });
});

describe("D. 'Everything is healthy' requires established health", () => {
  const full = (response: { headline: string; body: string[] }) => `${response.headline} ${response.body.join(" ")}`;

  it("does not claim healthy when a service is unknown", () => {
    const model = buildModel(snapshot([healthy("api", { status: "unknown" })]), runtime);
    expect(full(answer(model, "show unhealthy services", "live", "live"))).not.toContain("Everything is healthy");
  });

  it("does not claim healthy when a service is updating", () => {
    const model = buildModel(snapshot([healthy("api", { status: "restarting" })]), runtime);
    expect(full(answer(model, "show unhealthy services", "live", "live"))).not.toContain("Everything is healthy");
  });

  it("claims healthy only when every service is healthy", () => {
    const model = buildModel(snapshot([healthy("api"), healthy("worker")]), runtime);
    expect(full(answer(model, "show unhealthy services", "live", "live"))).toContain("Everything is healthy");
  });

  it("mixed healthy + unknown never claims healthy", () => {
    const model = buildModel(snapshot([healthy("api"), healthy("worker", { status: "unknown" })]), runtime);
    expect(full(answer(model, "show unhealthy services", "live", "live"))).not.toContain("Everything is healthy");
  });

  it("zero services does not claim healthy", () => {
    const model = buildModel(snapshot([]), runtime);
    expect(full(answer(model, "show unhealthy services", "live", "live"))).not.toContain("Everything is healthy");
  });
});

describe("E. whyOffline must not treat unknown/updating upstreams as unhealthy", () => {
  it("does not list an unknown upstream as an unhealthy cause", () => {
    const model = buildModel(snapshot([
      healthy("web", { status: "Exited (1)", dependsOn: ["db"] }),
      healthy("db", { status: "unknown" })
    ]), runtime);
    const response = answer(model, "why is web offline", "live", "live");
    expect(response.body.join(" ")).not.toContain("upstream dependency is also unhealthy");
  });

  it("does not list an updating upstream as an unhealthy cause", () => {
    const model = buildModel(snapshot([
      healthy("web", { status: "Exited (1)", dependsOn: ["db"] }),
      healthy("db", { status: "restarting" })
    ]), runtime);
    const response = answer(model, "why is web offline", "live", "live");
    expect(response.body.join(" ")).not.toContain("upstream dependency is also unhealthy");
  });
});

describe("F. port matching must be exact numeric", () => {
  it("port 80 does not match 8080", () => {
    const model = buildModel(snapshot([healthy("api", { ports: ["8080/tcp"] })]), runtime);
    const response = answer(model, "show everything using port 80", "live", "live");
    expect(response.headline).toBe("No service publishes port 80");
    expect(response.body.join(" ")).not.toContain("api");
  });

  it("port 443 does not match 8443", () => {
    const model = buildModel(snapshot([healthy("api", { ports: ["8443/tcp"] })]), runtime);
    const response = answer(model, "show everything using port 443", "live", "live");
    expect(response.headline).toBe("No service publishes port 443");
  });

  it("exact port match still answers", () => {
    const model = buildModel(snapshot([healthy("api", { ports: ["8080/tcp"] })]), runtime);
    const response = answer(model, "show everything using port 8080", "live", "live");
    expect(response.headline).toBe("Port 8080");
    expect(response.body.join(" ")).toContain("api");
  });

  it("uses publication wording, not generic usage", () => {
    const model = buildModel(snapshot([healthy("api", { ports: [] })]), runtime);
    const response = answer(model, "show everything using port 9999", "live", "live");
    expect(response.body.join(" ")).toContain("publishes port 9999");
  });
});

describe("G. image identity must be exact", () => {
  it("preserves a digest reference exactly", () => {
    const model = buildModel(snapshot([healthy("api", { image: "nginx@sha256:0123456789abcdef" })]), runtime);
    const response = answer(model, "tell me about api", "live", "live");
    expect(response.body.join(" ")).toContain("nginx@sha256:0123456789abcdef");
  });

  it("does not invent a :latest tag for tagless images", () => {
    const model = buildModel(snapshot([healthy("api", { image: "registry.example/app" })]), runtime);
    const response = answer(model, "tell me about api", "live", "live");
    expect(response.body.join(" ")).not.toContain("registry.example/app:latest");
  });
});

describe("B. user-facing copy must be source-neutral", () => {
  it("does not claim 'live map' in demo mode", () => {
    const demo = buildModel(getDemoResponse<DockerSnapshot>("/api/snapshot"), runtime);
    const value: AppContextValue = { model: demo, modelProvenance: "demo", loading: false, error: null, health: null, tick: 0, evidenceMode: "demo", openCommand: () => {} };
    const html = renderToStaticMarkup(<AppContext.Provider value={value}><MemoryRouter><Copilot /></MemoryRouter></AppContext.Provider>);
    expect(html).not.toContain("Reasons over your live map");
    expect(html).toContain("Reasons over your service map");
  });
});

describe("C. evidence kinds must be accurate", () => {
  it("an aggregated health conclusion is derived, not observed", () => {
    const model = buildModel(snapshot([healthy("api")]), runtime);
    const response = answer(model, "show unhealthy services", "live", "live");
    expect(response.evidence).toBe("derived");
  });

  it("a normalized state answer is derived, not observed", () => {
    const model = buildModel(snapshot([healthy("api", { status: "Exited (1)" })]), runtime);
    const response = answer(model, "why is api offline", "live", "live");
    expect(response.evidence).toBe("inferred");
  });

  it("renders the visible Inferred evidence label for a causal answer", () => {
    const model = buildModel(snapshot([healthy("api", { status: "Exited (1)" })]), runtime);
    const value: AppContextValue = { model, modelProvenance: "live", loading: false, error: null, health: null, tick: 0, evidenceMode: "live", openCommand: () => {} };
    const html = renderToStaticMarkup(
      <AppContext.Provider value={value}>
        <MemoryRouter initialEntries={["/copilot?q=why+is+api+offline"]}><Copilot /></MemoryRouter>
      </AppContext.Provider>
    );
    expect(html).toContain(">Inferred<");
    expect(html).toContain("A heuristic guess, not measured");
  });
});

describe("A4. direct-vs-transitive downstream claims", () => {
  it("two-hop chain: C does NOT directly declare start order after A", () => {
    const model = buildModel(snapshot([
      healthy("a", { id: "a", dependsOn: [] }),
      healthy("b", { id: "b", dependsOn: ["a"] }),
      healthy("c", { id: "c", dependsOn: ["b"] })
    ]), runtime);
    const response = answer(model, "what declares start order after a", "live", "live");
    // Only B declares directly after A; C is transitively downstream.
    expect(response.headline).toBe("1 service declares start order after a");
    expect(response.body.join(" ")).toContain("• b");
    expect(response.body.join(" ")).not.toContain("• c");
  });

  it("service overview counts only direct downstream declarations", () => {
    const model = buildModel(snapshot([
      healthy("a", { id: "a", dependsOn: [] }),
      healthy("b", { id: "b", dependsOn: ["a"] }),
      healthy("c", { id: "c", dependsOn: ["b"] })
    ]), runtime);
    const response = answer(model, "tell me about a", "live", "live");
    expect(response.body.join(" ")).toContain("1 declare start order after it");
    expect(response.body.join(" ")).not.toContain("2 declare start order after it");
  });
});

describe("A5. no unsupported causal localization", () => {
  it("unknown upstream: cause not established, never local inference", () => {
    const model = buildModel(snapshot([
      healthy("web", { id: "web", status: "Exited (1)", dependsOn: ["db"] }),
      healthy("db", { id: "db", status: "unknown" })
    ]), runtime);
    const response = answer(model, "why is web offline", "live", "live");
    const text = response.body.join(" ");
    expect(text).not.toContain("likely local");
    expect(text).not.toContain("cause is local");
    expect(text).toMatch(/not established|unknown/i);
  });

  it("updating upstream: cause not established, never local inference", () => {
    const model = buildModel(snapshot([
      healthy("web", { id: "web", status: "Exited (1)", dependsOn: ["db"] }),
      healthy("db", { id: "db", status: "restarting" })
    ]), runtime);
    const response = answer(model, "why is web offline", "live", "live");
    const text = response.body.join(" ");
    expect(text).not.toContain("likely local");
    expect(text).not.toContain("cause is local");
  });

  it("healthy upstreams: no upstream problem observed, but cause remains unknown", () => {
    const model = buildModel(snapshot([
      healthy("web", { id: "web", status: "Exited (1)", dependsOn: ["db"] }),
      healthy("db", { id: "db", status: "running" })
    ]), runtime);
    const response = answer(model, "why is web offline", "live", "live");
    const text = response.body.join(" ");
    expect(text).not.toContain("cause is likely local");
    expect(text).toMatch(/cause remains unknown|no upstream problem observed|not established/i);
  });
});

describe("A6. exposed vs published port claims", () => {
  it("private-only port is exposed, not published", () => {
    const model = buildModel(snapshot([healthy("api", { ports: ["8080/tcp"] })]), runtime);
    const response = answer(model, "show everything using port 8080", "live", "live");
    const text = response.body.join(" ");
    expect(text).toContain("exposes port 8080");
    expect(text).not.toContain("publishes port 8080");
  });

  it("public:private port publishes the public side", () => {
    const model = buildModel(snapshot([healthy("api", { ports: ["80:8080/tcp"] })]), runtime);
    const response = answer(model, "show everything using port 80", "live", "live");
    expect(response.body.join(" ")).toContain("publishes port 80");
  });

  it("public:private port does not claim the private side is published", () => {
    const model = buildModel(snapshot([healthy("api", { ports: ["80:8080/tcp"] })]), runtime);
    const response = answer(model, "show everything using port 8080", "live", "live");
    const text = response.body.join(" ");
    expect(text).toContain("exposes port 8080");
    expect(text).not.toContain("publishes port 8080");
  });

  it("no-match wording uses published only for true publications", () => {
    const model = buildModel(snapshot([healthy("api", { ports: ["8080/tcp"] })]), runtime);
    const response = answer(model, "show everything using port 80", "live", "live");
    expect(response.headline).toBe("No service publishes port 80");
  });
});

describe("A8. expose/listening phrasings share the port grammar", () => {
  it("'what is listening on 8443?' resolves the exposed side", () => {
    const model = buildModel(snapshot([healthy("api", { ports: ["443:8443/tcp"] })]), runtime);
    const response = answer(model, "what is listening on 8443", "live", "live");
    expect(response.body.join(" ")).toContain("api");
    expect(response.body.join(" ")).toContain("exposes port 8443");
  });

  it("'what is listening on 443?' answers the exposed side, not the published side", () => {
    // A `443:8443/tcp` service publishes 443 but EXPOSES 8443 — an exposure
    // question about 443 must not be answered with the published side (#89 P2).
    const model = buildModel(snapshot([healthy("api", { ports: ["443:8443/tcp"] })]), runtime);
    const response = answer(model, "what is listening on 443", "live", "live");
    expect(response.headline).toBe("No service exposes port 443");
    expect(response.body.join(" ")).not.toContain("publishes port 443");
  });

  it("'what exposes 8080?' resolves the port", () => {
    const model = buildModel(snapshot([healthy("api", { ports: ["8080/tcp"] })]), runtime);
    const response = answer(model, "what exposes 8080", "live", "live");
    expect(response.body.join(" ")).toContain("api");
  });

  it("'what is listening on 9999?' with no match does not list everything", () => {
    const model = buildModel(snapshot([healthy("api", { ports: ["8080/tcp"] })]), runtime);
    const response = answer(model, "what is listening on 9999", "live", "live");
    expect(response.headline).toBe("No service exposes port 9999");
    expect(response.body.join(" ")).not.toContain("api");
  });
});

describe("A7. authority failure is not presented as collector-unavailable", () => {
  it("unresolved authority renders a dedicated source-authority status", () => {
    const model = buildModel(snapshot([healthy("api")]), runtime);
    const response = answer(model, "show unhealthy services", null, null);
    expect(response.authorityUnresolved).toBe(true);
    const value: AppContextValue = { model, modelProvenance: null, loading: false, error: null, health: null, tick: 0, evidenceMode: null, openCommand: () => {} };
    const html = renderToStaticMarkup(
      <AppContext.Provider value={value}>
        <MemoryRouter initialEntries={["/copilot?q=show+unhealthy+services"]}><Copilot /></MemoryRouter>
      </AppContext.Provider>
    );
    expect(html).toContain("Source authority unresolved");
    expect(html).not.toContain("DockerMap does not collect this yet");
  });

  it("resolved answers keep the claim-kind label", () => {
    const model = buildModel(snapshot([healthy("api")]), runtime);
    const response = answer(model, "show unhealthy services", "live", "live");
    expect(response.authorityUnresolved).toBeUndefined();
  });
});
