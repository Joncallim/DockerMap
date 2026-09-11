import type { JSX } from "react";
import { ATLAS_RENDERER_POLICY } from "./policy";
import { ariaLabel, cappedPointIndex, displayText, renderableAggregates, renderableAttachments, renderableRelations, renderableSubjects, safeCamera, selectOnKeyboard, type AtlasRendererProps } from "./shared";

/**
 * SVG/HTML hybrid candidate. SVG remains a visual topology only; the same
 * canonical model order powers the semantic HTML directory and keyboard path.
 */
export function HybridAtlas({ model, layout, camera, selectedKey = null, onSelect }: AtlasRendererProps): JSX.Element {
  const points = cappedPointIndex(layout);
  const transform = safeCamera(camera);
  const subjects = renderableSubjects(model, points);
  const relations = renderableRelations(model, points);
  const attachments = renderableAttachments(model, points);
  const aggregates = renderableAggregates(model);
  return (
    <section aria-label="Atlas SVG and HTML comparison" data-atlas-renderer="svg-html-hybrid">
      <svg viewBox="-160 -80 1600 800" aria-hidden="true" focusable="false">
        <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.zoom})`}>
          {relations.map((relation, index) => {
            const source = points.get(relation.source);
            const target = points.get(relation.target);
            return source && target ? <line key={index} data-atlas-relation x1={source.x + source.width / 2} y1={source.y + source.height / 2} x2={target.x + target.width / 2} y2={target.y + target.height / 2} stroke="#6b7280" /> : null;
          })}
          {attachments.map((attachment, index) => {
            const subject = points.get(attachment.subject);
            const context = points.get(attachment.context);
            return subject && context ? <line key={index} data-atlas-attachment x1={subject.x + subject.width / 2} y1={subject.y + subject.height / 2} x2={context.x + context.width / 2} y2={context.y + context.height / 2} stroke="#9ca3af" strokeDasharray="3 2" /> : null;
          })}
          {subjects.map((subject) => {
            const point = points.get(subject.key);
            return point ? <g key={subject.key} data-atlas-subject transform={`translate(${point.x} ${point.y})`}><rect width={point.width} height={point.height} rx="3" fill={subject.routability === "routable" ? "#f8fafc" : "#d6d9df"} stroke={selectedKey === subject.key ? "#1688c9" : "#57606a"} /><text x={ATLAS_RENDERER_POLICY.cardPadding} y={point.height / 2 + 4} fontSize="10">{displayText(subject)}</text></g> : null;
          })}
        </g>
      </svg>
      <ol aria-label="Atlas directory">
        {subjects.map((subject) => <li key={subject.key}>
          <button
            type="button"
            disabled={subject.routability !== "routable"}
            aria-current={selectedKey === subject.key ? "true" : undefined}
            aria-label={ariaLabel(subject)}
            onClick={() => subject.routability === "routable" && onSelect?.(subject.key)}
            onKeyDown={(event) => selectOnKeyboard(event, subject, onSelect)}
          >{displayText(subject)}</button>
        </li>)}
      </ol>
      {aggregates.map((aggregate) => <p key={aggregate.key}>{aggregate.population.resolved} resolved attachments; {aggregate.population.omitted} omitted by cap.</p>)}
    </section>
  );
}
