import { useEffect, useMemo, useRef } from "react";
import type { AtlasCamera, AtlasKey, AtlasLayout, AtlasModel, AtlasSubject } from "../../lib/atlas/types";
import { pointFor } from "../../lib/atlas/layout";
import { presentationMarkers, subjectPresentationText } from "../../lib/atlas/presentation";

const DISPLAY_LIMIT = 96;
const SUBJECT_LIMIT = 250;

function safeDisplay(value: string): string {
  const bounded = value.slice(0, DISPLAY_LIMIT * 4).normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  const characters = Array.from(bounded);
  return characters.length <= DISPLAY_LIMIT ? (bounded || "Runtime subject") : `${characters.slice(0, DISPLAY_LIMIT - 1).join("")}…`;
}

function markerText(subject: AtlasSubject): string {
  return subjectPresentationText({ ...subject, display: safeDisplay(subject.display) });
}

function MarkerRow({ subject }: { subject: AtlasSubject }) {
  return <span className="atlas-marker-row" aria-hidden="true">{presentationMarkers(subject).map((entry) => <i key={entry.channel} className={`atlas-marker ${entry.className}`}>{entry.glyph}</i>)}</span>;
}

export interface AtlasOverviewTopologyProps {
  model: AtlasModel;
  layout: AtlasLayout;
  camera: AtlasCamera;
  selectedKey: AtlasKey | null;
  onSelect: (key: AtlasKey) => void;
  /** Invalidation of an exact selected key returns keyboard focus to the directory. */
  focusRecoveryToken?: number;
}

/**
 * The production adaptation of the selected SVG/HTML hybrid: SVG provides
 * orientation only; the adjacent HTML directory remains the complete keyboard
 * and text alternative. Overview intentionally suppresses all edge classes.
 */
export default function AtlasOverviewTopology({ model, layout, camera, selectedKey, onSelect, focusRecoveryToken = 0 }: AtlasOverviewTopologyProps) {
  const subjects = useMemo(() => model.subjects.slice(0, SUBJECT_LIMIT), [model.subjects]);
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  const directoryRef = useRef<HTMLElement | null>(null);
  useEffect(() => { selectedRef.current?.focus(); }, [selectedKey]);
  useEffect(() => { if (focusRecoveryToken > 0) directoryRef.current?.focus(); }, [focusRecoveryToken]);
  const transform = `translate(${Number.isFinite(camera.x) ? Math.max(-100000, Math.min(100000, camera.x)) : 0} ${Number.isFinite(camera.y) ? Math.max(-100000, Math.min(100000, camera.y)) : 0}) scale(${Number.isFinite(camera.zoom) && camera.zoom > 0 ? Math.min(8, camera.zoom) : 1})`;

  return <div className="atlas-topology" data-atlas-renderer="svg-html-hybrid" data-atlas-lens="overview">
    <div className="atlas-canvas-wrap">
      <svg className="atlas-canvas" viewBox="-160 -80 1600 800" role="img" aria-label="Atlas orientation surface. Relations and attachments are suppressed until a subject is selected.">
        <g transform={transform}>
          {subjects.map((subject) => {
            const point = pointFor(layout, subject.key);
            if (!point) return null;
            const selected = subject.key === selectedKey;
            return <g key={subject.key} className={`atlas-subject ${selected ? "is-selected" : ""} ${subject.routability === "non_routable" ? "is-nonroutable" : ""}`} transform={`translate(${point.x} ${point.y})`} data-atlas-subject>
              <rect width={point.width} height={point.height} rx="6" />
              <text x="6" y={point.height / 2 + 3} aria-hidden="true">{safeDisplay(subject.display)}</text>
            </g>;
          })}
        </g>
      </svg>
      <p className="atlas-canvas-note">Orientation only. Recorded relations and attachments remain suppressed until local inspection is available.</p>
    </div>
    <section ref={directoryRef} className="atlas-directory" aria-label="Atlas subject directory" tabIndex={-1}>
      <h2>Subjects</h2>
      <ol>
        {subjects.map((subject) => {
          const enabled = subject.routability === "routable";
          const selected = subject.key === selectedKey;
          return <li key={subject.key}>
            <button
              ref={selected ? selectedRef : undefined}
              type="button"
              disabled={!enabled}
              aria-current={selected ? "true" : undefined}
              aria-label={markerText(subject)}
              onClick={() => enabled && onSelect(subject.key)}
            >
              <span className="atlas-directory-name">{safeDisplay(subject.display)}</span>
              <MarkerRow subject={subject} />
              {!enabled && <span className="atlas-disabled-note">Not selectable</span>}
            </button>
          </li>;
        })}
      </ol>
    </section>
  </div>;
}

export { markerText, safeDisplay };
