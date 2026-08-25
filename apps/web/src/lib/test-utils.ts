/**
 * Shared test helpers for render assertions (U10): strip markup so assertions
 * target VISIBLE TEXT, not serialized HTML — `toContain(label)` on markup
 * would pass if the label drifted into a `title` attribute (G-22), which users
 * and screen readers never see. Moved out of evidence-render.test.tsx so every
 * surface test uses the ONE helper instead of inlining its own regex.
 */
import type { EvidenceMode, ModelProvenance } from "./evidence";

export function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}

/** Hard-coded 16-pair policy matrix; never derive it from the source gate. */
export const RESOURCE_CLAIM_MATRIX: [EvidenceMode | null, ModelProvenance | null, "demo" | "unavailable"][] = [
  ["live", "live", "unavailable"], ["live", "mock", "unavailable"], ["live", "demo", "unavailable"], ["live", null, "unavailable"],
  ["mock", "live", "unavailable"], ["mock", "mock", "unavailable"], ["mock", "demo", "unavailable"], ["mock", null, "unavailable"],
  ["demo", "live", "unavailable"], ["demo", "mock", "unavailable"], ["demo", "demo", "demo"], ["demo", null, "unavailable"],
  [null, "live", "unavailable"], [null, "mock", "unavailable"], [null, "demo", "unavailable"], [null, null, "unavailable"]
];
