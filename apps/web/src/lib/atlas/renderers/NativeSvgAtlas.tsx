import { useId, type JSX } from "react";
import type { AtlasPoint, AtlasSubject } from "../types";
import { ATLAS_RENDERER_POLICY } from "./policy";
import { ariaLabel, cappedPointIndex, displayText, renderableAggregates, renderableAttachments, renderableRelations, renderableSubjects, safeCamera, selectOnKeyboard, type AtlasRendererProps } from "./shared";

function SubjectGlyph({ subject, point, selected, onSelect }: { subject: AtlasSubject; point: AtlasPoint; selected: boolean; onSelect?: (key: string) => void }): JSX.Element {
  const disabled = subject.routability !== "routable";
  return (
    <g
      transform={`translate(${point.x} ${point.y})`}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={ariaLabel(subject)}
      aria-disabled={disabled || undefined}
      data-atlas-subject
      data-atlas-nonroutable={disabled || undefined}
      onClick={() => !disabled && onSelect?.(subject.key)}
      onKeyDown={(event) => selectOnKeyboard(event, subject, onSelect)}
    >
      <rect width={point.width} height={point.height} rx="3" fill={disabled ? "#d6d9df" : "#f8fafc"} stroke={selected ? "#1688c9" : "#57606a"} strokeWidth={selected ? ATLAS_RENDERER_POLICY.focusRingWidth : 1} />
      <text x={ATLAS_RENDERER_POLICY.cardPadding} y={point.height / 2 + 4} fontSize="10" fill="#1f2937">{displayText(subject)}</text>
    </g>
  );
}

/** Native SVG baseline: zero runtime dependencies, fixture-only and route-free. */
export function NativeSvgAtlas({ model, layout, camera, selectedKey = null, onSelect }: AtlasRendererProps): JSX.Element {
  const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const markerId = `atlas-native-arrow-${instanceId}`;
  const points = cappedPointIndex(layout);
  const transform = safeCamera(camera);
  const subjects = renderableSubjects(model, points);
  const relations = renderableRelations(model, points);
  const attachments = renderableAttachments(model, points);
  const aggregates = renderableAggregates(model);
  return (
    <svg viewBox="-160 -80 1600 800" role="group" aria-label="Atlas native SVG comparison" data-atlas-renderer="native-svg">
      <defs><marker id={markerId} markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto"><path d="M0,0 L5,2.5 L0,5 z" fill="#6b7280" /></marker></defs>
      <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.zoom})`}>
        {relations.map((relation, index) => {
          const source = points.get(relation.source);
          const target = points.get(relation.target);
          return source && target ? <line key={index} data-atlas-relation x1={source.x + source.width / 2} y1={source.y + source.height / 2} x2={target.x + target.width / 2} y2={target.y + target.height / 2} stroke="#6b7280" markerEnd={`url(#${markerId})`} /> : null;
        })}
        {attachments.map((attachment, index) => {
          const subject = points.get(attachment.subject);
          const context = points.get(attachment.context);
          return subject && context ? <line key={index} data-atlas-attachment x1={subject.x + subject.width / 2} y1={subject.y + subject.height / 2} x2={context.x + context.width / 2} y2={context.y + context.height / 2} stroke="#9ca3af" strokeDasharray="3 2" /> : null;
        })}
        {subjects.map((subject) => {
          const point = points.get(subject.key);
          return point ? <SubjectGlyph key={subject.key} subject={subject} point={point} selected={selectedKey === subject.key} onSelect={onSelect} /> : null;
        })}
        {aggregates.map((aggregate, index) => <text key={aggregate.key} x="-140" y={index * 16} fontSize="10" fill="#374151">{aggregate.population.resolved} resolved attachments</text>)}
      </g>
    </svg>
  );
}
