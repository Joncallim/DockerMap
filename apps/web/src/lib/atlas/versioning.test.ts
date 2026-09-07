import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import daemonRuntimeMapFixture from "../../../../../tests/fixtures/contracts/runtime-map-daemon-emitted.json";
import policyGolden from "./__goldens__/policy-versions.json";
import { ATLAS_LOCAL_CONTEXT_POLICY } from "./localContext";
import {
  ATLAS_GOLDEN_MANIFEST,
  ATLAS_LAYOUT_DEPENDENCY_POLICY,
  ATLAS_POLICY_VERSIONS,
  restoreAtlasSemanticState,
  serializeAtlasSemanticState
} from "./versioning";

const SOURCE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

function localModule(from: URL, specifier: string): URL | null {
  if (!specifier.startsWith(".")) return null;
  const base = new URL(specifier, from);
  for (const suffix of SOURCE_EXTENSIONS) {
    const candidate = new URL(`${base.pathname}${suffix}`, base);
    if (existsSync(candidate)) return candidate;
  }
  for (const extension of SOURCE_EXTENSIONS.slice(1)) {
    const candidate = new URL(`index${extension}`, base.pathname.endsWith("/") ? base : new URL(`${base.pathname}/`, base));
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function atlasProductionImportGraph() {
  const entry = new URL("../../screens/AtlasOverview.tsx", import.meta.url);
  const pending = [entry];
  const visited = new Set<string>();
  const external = new Set<string>();
  const dynamic = new Set<string>();
  const sideEffect = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file.href)) continue;
    if (visited.size >= 80) throw new Error("Atlas production import graph exceeded its fixed review cap");
    visited.add(file.href);
    const source = readFileSync(file, "utf8");
    const staticFrom = [...source.matchAll(/^\s*(?:import|export)\s+(?:type\s+)?[\s\S]*?\sfrom\s+["']([^"']+)["'];?\s*$/gm)].map((match) => match[1]!);
    const staticSideEffect = [...source.matchAll(/^\s*import\s+["']([^"']+)["'];?\s*$/gm)].map((match) => match[1]!);
    const dynamicImports = [...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]!);
    for (const specifier of staticSideEffect) sideEffect.add(specifier);
    for (const specifier of dynamicImports) dynamic.add(specifier);
    for (const specifier of [...staticFrom, ...staticSideEffect, ...dynamicImports]) {
      const local = localModule(file, specifier);
      if (local) pending.push(local);
      else if (!specifier.startsWith(".")) external.add(specifier);
    }
  }
  return { visited: [...visited].sort(), external: [...external].sort(), dynamic: [...dynamic].sort(), sideEffect: [...sideEffect].sort() };
}

describe("Atlas versioning authority", () => {
  it("ties checked-in exact goldens to named internal policy versions", () => {
    expect(ATLAS_GOLDEN_MANIFEST).toEqual(policyGolden);
    expect(ATLAS_POLICY_VERSIONS).toEqual({
      projection: "atlas-v1/projection-1",
      layout: "atlas-v1/local-lanes",
      visual: "atlas-v1/visual-grammar-1",
      renderer: "atlas-v1/renderer-spike-1"
    });
  });

  it("binds the selected-local rail artifact to its actual frozen policy", () => {
    expect(ATLAS_GOLDEN_MANIFEST.artifacts.localAttachment.policy).toBe(ATLAS_LOCAL_CONTEXT_POLICY.version);
    expect(policyGolden.artifacts.localAttachment.policy).toBe(ATLAS_LOCAL_CONTEXT_POLICY.version);
  });

  it("records and verifies the V1 no-dependency decision against the actual web manifest, lockfile, and recursive production Atlas import graph", () => {
    expect(ATLAS_LAYOUT_DEPENDENCY_POLICY).toEqual({ kind: "none", packageName: null, packageVersion: null });
    const webManifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    const lockfile = JSON.parse(readFileSync(new URL("../../../../../package-lock.json", import.meta.url), "utf8")) as { packages: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }> };
    expect(webManifest.dependencies).toEqual({
      "@dockermap/contracts": "0.1.0",
      react: "^19.1.1",
      "react-dom": "^19.1.1",
      "react-router-dom": "^7.18.2"
    });
    expect(lockfile.packages["apps/web"]?.dependencies).toEqual(webManifest.dependencies);
    expect(webManifest.devDependencies).toEqual({
      "@types/react": "^19.1.10",
      "@types/react-dom": "^19.1.7",
      "@vitejs/plugin-react": "^5.0.2",
      jsdom: "^30.0.1",
      typescript: "^5.9.2",
      vite: "^8.0.16",
      vitest: "^4.1.9"
    });
    expect(lockfile.packages["apps/web"]?.devDependencies).toEqual(webManifest.devDependencies);

    const graph = atlasProductionImportGraph();
    expect(graph.visited.length).toBeGreaterThanOrEqual(5);
    expect(graph.external).toEqual(["@dockermap/contracts", "react"]);
    expect(graph.dynamic).toEqual([]);
    expect(graph.sideEffect).toEqual([]);
  });

  it("serializes only semantic lens and selected identity, never coordinates", () => {
    const stored = serializeAtlasSemanticState({ lens: "connectivity", selectedKey: "docker_container_container_000" });
    expect(stored).toEqual({
      schemaVersion: 1,
      policyVersions: {
        projection: "atlas-v1/projection-1",
        layout: "atlas-v1/local-lanes",
        visual: "atlas-v1/visual-grammar-1"
      },
      lens: "connectivity",
      selectedKey: "docker_container_container_000"
    });
    expect(JSON.stringify(stored)).not.toMatch(/(?:camera|coordinate|zoom|viewport|\"x\"|\"y\")/i);
  });

  it("fails closed to unselected orientation after an old policy, schema, or unsafe state", () => {
    const current = serializeAtlasSemanticState({ lens: "storage", selectedKey: "docker_container_container_000" });
    expect(restoreAtlasSemanticState(current)).toEqual({ lens: "storage", selectedKey: "docker_container_container_000", degraded: false });
    expect(restoreAtlasSemanticState({ ...current, policyVersions: { ...current.policyVersions, layout: "atlas-v0/old-layout" } })).toEqual({ lens: "overview", selectedKey: null, degraded: true });
    expect(restoreAtlasSemanticState({ ...current, schemaVersion: 0 })).toEqual({ lens: "overview", selectedKey: null, degraded: true });
    expect(restoreAtlasSemanticState({ ...current, selectedKey: "x".repeat(1_000) })).toEqual({ lens: "overview", selectedKey: null, degraded: true });
    for (const selectedKey of ["docker_container_safe", "docker_network_app", "docker_volume_app_cache", "network_listener_443_8443_tcp", "host_local", "systemd_service_docker.service", ...daemonRuntimeMapFixture.nodes.map((node) => node.id)]) {
      expect(restoreAtlasSemanticState({ ...current, selectedKey })).toEqual({ lens: "storage", selectedKey, degraded: false });
    }
    for (const selectedKey of ["/var/run/docker.sock", "database primary", "docker_evidence_container_api", "atlas:attachment:0", "docker_container_container_api?source=label"]) {
      expect(restoreAtlasSemanticState({ ...current, selectedKey })).toEqual({ lens: "overview", selectedKey: null, degraded: true });
    }
  });
});
