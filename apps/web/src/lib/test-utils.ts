/**
 * Shared test helpers for render assertions (U10): strip markup so assertions
 * target VISIBLE TEXT, not serialized HTML — `toContain(label)` on markup
 * would pass if the label drifted into a `title` attribute (G-22), which users
 * and screen readers never see. Moved out of evidence-render.test.tsx so every
 * surface test uses the ONE helper instead of inlining its own regex.
 */
export function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}
