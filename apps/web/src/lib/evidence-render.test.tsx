import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Metric, Panel, Tag } from "../components/primitives";
import { EVIDENCE_KINDS, evidenceLabel, unavailable } from "./evidence";

describe("evidence label rendering", () => {
  it("11. renders every kind through Panel.hint, Tag, and Metric", () => {
    for (const kind of EVIDENCE_KINDS) {
      const { label } = evidenceLabel(kind);

      const panel = renderToStaticMarkup(
        <Panel title="Panel" hint={label}>
          content
        </Panel>
      );
      expect(panel, `${kind} panel`).toContain(label);

      const tag = renderToStaticMarkup(<Tag>{label}</Tag>);
      expect(tag, `${kind} tag`).toContain(label);

      const metric = renderToStaticMarkup(<Metric label="Metric" value={label} />);
      expect(metric, `${kind} metric`).toContain(label);
    }
  });

  it("12. unavailable renders 'Not collected' in Metric and does not render as 0, -, or empty", () => {
    const claim = unavailable("Live resource collectors are not wired yet");
    const { label } = evidenceLabel(claim.kind);
    const html = renderToStaticMarkup(<Metric label="CPU" value={label} />);

    expect(html).toContain(label);
    expect(html).toContain("Not collected");
    expect(html).not.toContain(">0<");
    expect(html).not.toContain(">-<");
    expect(html).not.toContain('<strong class="metric-value"></strong>');
  });
});
