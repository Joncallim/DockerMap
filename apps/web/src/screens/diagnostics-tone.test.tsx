// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DiagnosticsReport } from "@dockermap/contracts";
import { AppContext, type AppContextValue } from "../context";
import Diagnostics from "./Diagnostics";

/**
 * The Diagnostics screen must map severity to ONE semantic palette: the
 * summary metrics and the detailed findings rows must agree (info → muted,
 * warning → warn, error/blocked → error). Before the fix, the summary mapped
 * error AND blocked to the "accent" tone while the rows used "error" — two
 * different semantics for the same severity on one screen.
 */
const { report } = vi.hoisted(() => {
  const report: DiagnosticsReport = {
    generatedAt: 0,
    entries: [
      { id: "e1", severity: "blocked", source: "compose", message: "port 8080 already in use", service: null, file: null },
      { id: "e2", severity: "error", source: "runtime", message: "provider failed to report", service: "api", file: null },
      { id: "e3", severity: "warning", source: "api", message: "snapshot refresh slowed", service: null, file: null },
      { id: "e4", severity: "info", source: "compose", message: "compose file parsed", service: null, file: "compose.yaml" }
    ]
  };
  return { report };
});

vi.mock("../hooks/useApiResource", () => ({
  useApiResource: () => ({ data: report, error: null, loading: false, generation: 1 })
}));

const contextValue: AppContextValue = {
  model: null,
  loading: false,
  error: null,
  health: null,
  tick: 0,
  openCommand: () => {}
};

describe("Diagnostics severity tone consistency", () => {
  it("maps every summary severity to the same semantic tone as the findings rows", () => {
    const html = renderToStaticMarkup(
      <AppContext.Provider value={contextValue}>
        <Diagnostics />
      </AppContext.Provider>
    );

    // Summary metrics: info → tag-muted, warning → tag-warn, error/blocked → tag-error.
    expect(html).toContain('<span class="tag tag-muted">info</span>');
    expect(html).toContain('<span class="tag tag-warn">warning</span>');
    expect(html).toContain('<span class="tag tag-error">error</span>');
    expect(html).toContain('<span class="tag tag-error">blocked</span>');
    // The accent tone must never be used for a severity on this screen.
    expect(html).not.toContain("tag-accent");

    // Findings rows agree with the summary (same tone per severity).
    expect(html).toContain('<span class="tag tag-error">blocked</span>');
    expect(html.split('<span class="tag tag-error">').length - 1).toBeGreaterThanOrEqual(2);
    expect(html.split('<span class="tag tag-muted">').length - 1).toBeGreaterThanOrEqual(2);
  });
});
