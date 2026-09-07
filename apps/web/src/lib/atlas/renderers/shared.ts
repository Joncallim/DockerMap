import type { KeyboardEvent } from "react";
import type { AtlasAggregate, AtlasAttachment, AtlasCamera, AtlasLayout, AtlasModel, AtlasPoint, AtlasRelation, AtlasSubject } from "../types";
import { ATLAS_RENDERER_POLICY } from "./policy";

export interface AtlasRendererProps {
  model: AtlasModel;
  layout: AtlasLayout;
  camera: AtlasCamera;
  selectedKey?: string | null;
  onSelect?: (key: string) => void;
}

export function displayText(subject: AtlasSubject): string {
  // The projection owns redaction. The spike consumes only its bounded display
  // text and bounds it again before passing it to SVG/HTML text rendering.
  const raw = subject.display.slice(0, ATLAS_RENDERER_POLICY.labelCharacters * 4);
  const value = raw.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  const characters = Array.from(value);
  return characters.length <= ATLAS_RENDERER_POLICY.labelCharacters
    ? value || "Runtime subject"
    : `${characters.slice(0, ATLAS_RENDERER_POLICY.labelCharacters - 1).join("")}…`;
}

export function visibleSubjects(model: AtlasModel): readonly AtlasSubject[] {
  return model.subjects.slice(0, ATLAS_RENDERER_POLICY.maxInteractiveSubjects);
}

/** Index a hard-bounded layout prefix before any map allocation. */
export function cappedPointIndex(layout: AtlasLayout): ReadonlyMap<string, AtlasPoint> {
  return new Map(layout.points.slice(0, ATLAS_RENDERER_POLICY.maxInteractiveSubjects).map((point) => [point.subject, point]));
}

export function renderableSubjects(model: AtlasModel, points: ReadonlyMap<string, AtlasPoint>): readonly AtlasSubject[] {
  return visibleSubjects(model).filter((subject) => points.has(subject.key));
}

export function renderableRelations(model: AtlasModel, points: ReadonlyMap<string, AtlasPoint>): readonly AtlasRelation[] {
  return model.relations.slice(0, ATLAS_RENDERER_POLICY.maxVisibleRelations).filter((relation) => points.has(relation.source) && points.has(relation.target));
}

export function renderableAttachments(model: AtlasModel, points: ReadonlyMap<string, AtlasPoint>): readonly AtlasAttachment[] {
  return model.attachments.slice(0, ATLAS_RENDERER_POLICY.maxVisibleAttachments).filter((attachment) => points.has(attachment.subject) && points.has(attachment.context));
}

export function renderableAggregates(model: AtlasModel): readonly AtlasAggregate[] {
  return model.aggregates.slice(0, ATLAS_RENDERER_POLICY.maxVisibleAggregates);
}

export function safeCamera(camera: AtlasCamera): AtlasCamera {
  const bounded = (value: number) => Number.isFinite(value) ? Math.max(-100_000, Math.min(100_000, value)) : 0;
  return { x: bounded(camera.x), y: bounded(camera.y), zoom: Number.isFinite(camera.zoom) && camera.zoom > 0 ? Math.min(camera.zoom, 8) : 1 };
}

export function nextRoutableSubjectKey(model: AtlasModel, current: string | null, direction: 1 | -1): string | null {
  const subjects = visibleSubjects(model).filter((subject) => subject.routability === "routable");
  if (subjects.length === 0) return null;
  const index = current ? subjects.findIndex((subject) => subject.key === current) : -1;
  return subjects[(index + direction + subjects.length) % subjects.length]!.key;
}

export function selectOnKeyboard(event: KeyboardEvent, subject: AtlasSubject, onSelect?: (key: string) => void): void {
  if (subject.routability !== "routable" || !onSelect || (event.key !== "Enter" && event.key !== " ")) return;
  event.preventDefault();
  onSelect(subject.key);
}

export function ariaLabel(subject: AtlasSubject): string {
  const nonRoutable = subject.routability === "non_routable" ? ", unavailable for selection" : "";
  return `${displayText(subject)}, ${subject.operationalState}, ${subject.freshness}${nonRoutable}`;
}
