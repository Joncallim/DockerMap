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

  // The G-19 locks are the type-level `value: null` on the unavailable arm (test 9),
  // the @ts-expect-error compile gate, and the label-presence assertions below. A full
  // unavailable-path surface render fixture is deferred to the #72-#76 fixtures (doc D7).
  it("12. unavailable renders 'Not collected' in Metric", () => {
    const claim = unavailable("Live resource collectors are not wired yet");
    const { label } = evidenceLabel(claim.kind);
    const html = renderToStaticMarkup(<Metric label="CPU" value={label} />);

    expect(html).toContain(label);
    expect(html).toContain("Not collected");
  });
});
