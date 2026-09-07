import { describe, expect, it } from "vitest";
import { ATLAS_PRESENTATION_POLICY, compactPresentationText, presentationMarkers, presentationText } from "./presentation";
import type { AtlasPresentationChannels } from "./presentation";

const cases: readonly [string, AtlasPresentationChannels, readonly string[]][] = [
  ["healthy stale", { operationalState: "healthy", freshness: "stale", attention: "none", ambiguity: "none" }, ["healthy", "stale observation"]],
  ["healthy finding", { operationalState: "healthy", freshness: "fresh", attention: "warning", ambiguity: "none" }, ["warning attention", "healthy", "fresh observation"]],
  ["offline fresh", { operationalState: "offline", freshness: "fresh", attention: "none", ambiguity: "none" }, ["offline", "fresh observation"]],
  ["unknown timeout", { operationalState: "unknown", freshness: "timed_out", attention: "none", ambiguity: "none" }, ["unknown state", "timed out observation"]],
  ["collision healthy", { operationalState: "healthy", freshness: "fresh", attention: "none", ambiguity: "collision" }, ["ambiguous collision", "healthy", "fresh observation"]],
  ["advisory degraded unavailable", { operationalState: "degraded", freshness: "unavailable", attention: "advisory", ambiguity: "none" }, ["advisory attention", "degraded", "unavailable observation"]],
  ["unresolved warning disabled", { operationalState: "warning", freshness: "disabled", attention: "none", ambiguity: "unresolved" }, ["unresolved identity", "warning state", "disabled observation"]],
  ["unsupported updating unknown", { operationalState: "updating", freshness: "unknown", attention: "none", ambiguity: "unsupported" }, ["unsupported identity", "updating", "unknown freshness"]]
];

describe("Atlas orthogonal presentation semantics", () => {
  it.each(cases)("keeps %s as independent labelled channels", (_name, channels, expected) => {
    const text = presentationText("Safe subject", channels);
    for (const value of expected) expect(text).toContain(value);
    expect(text).toContain(channels.attention === "none" ? "no attention" : `${channels.attention} attention`);
  });

  it("does not turn attention, ambiguity, or freshness into an operational state", () => {
    const healthyFinding = cases[1]![1];
    const collisionHealthy = cases[4]![1];
    expect(presentationMarkers(healthyFinding).map((marker) => marker.channel)).toEqual(["attention", "operational_state", "freshness"]);
    expect(presentationMarkers(collisionHealthy).map((marker) => marker.channel)).toEqual(["ambiguity", "operational_state", "freshness"]);
    expect(compactPresentationText(healthyFinding)).toBe("warning attention · healthy · fresh observation");
    expect(ATLAS_PRESENTATION_POLICY.compactSummaryPrecedence).toEqual(["attention", "ambiguity", "operational_state", "freshness"]);
  });

  it("uses non-colour glyphs for every represented channel", () => {
    for (const [, channels] of cases) {
      const markers = presentationMarkers(channels);
      expect(markers.every((marker) => marker.glyph.length > 0 && marker.label.length > 0)).toBe(true);
    }
  });
});
