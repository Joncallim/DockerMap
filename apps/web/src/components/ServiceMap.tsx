import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { computeImpact, type Service, type SystemModel } from "../lib/model";
import { layoutServices } from "../lib/layout";
import Icon, { KIND_ICON } from "./Icon";
import { StateDot } from "./primitives";

const VIEW = 240;
const PAD = 26;

interface Transform {
  k: number;
  x: number;
  y: number;
}

export interface ServiceMapProps {
  model: SystemModel;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  interactive?: boolean;
  filter?: (service: Service) => boolean;
  height?: number;
}

export default function ServiceMap({ model, selectedId, onSelect, interactive = true, filter, height }: ServiceMapProps) {
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [transform, setTransform] = useState<Transform>({ k: 1, x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const services = useMemo(() => (filter ? model.services.filter(filter) : model.services), [model.services, filter]);
  const layout = useMemo(() => layoutServices(model.services, model.relationships), [model.services, model.relationships]);

  const place = (id: string) => {
    const p = layout.get(id);
    const half = VIEW / 2;
    const usable = half - PAD;
    return {
      x: half + (p?.x ?? 0) * usable,
      y: half + (p?.y ?? 0) * usable
    };
  };

  const activeId = hoverId ?? selectedId;
  const impact = useMemo(() => (activeId ? computeImpact(model, activeId) : null), [model, activeId]);
  const upstream = useMemo(() => new Set(impact?.upstream ?? []), [impact]);
  const downstream = useMemo(() => new Set(impact?.downstream ?? []), [impact]);

  const roleOf = (id: string): "self" | "up" | "down" | "dim" | "none" => {
    if (!activeId) return "none";
    if (id === activeId) return "self";
    if (downstream.has(id)) return "down";
    if (upstream.has(id)) return "up";
    return "dim";
  };

  const visible = new Set(services.map((s) => s.id));

  const onWheel = (e: ReactWheelEvent<SVGSVGElement>) => {
    if (!interactive) return;
    const delta = -e.deltaY * 0.0015;
    setTransform((t) => ({ ...t, k: Math.max(0.5, Math.min(3, t.k + delta)) }));
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!interactive) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, ox: transform.x, oy: transform.y };
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.x;
    const dy = e.clientY - dragRef.current.y;
    setTransform((t) => ({ ...t, x: dragRef.current!.ox + dx, y: dragRef.current!.oy + dy }));
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  const zoom = (dir: 1 | -1) => setTransform((t) => ({ ...t, k: Math.max(0.5, Math.min(3, t.k + dir * 0.25)) }));
  const reset = () => setTransform({ k: 1, x: 0, y: 0 });

  return (
    <div className="map" style={height ? { height } : undefined}>
      <svg
        className={`map-svg${interactive ? " is-interactive" : ""}`}
        viewBox={`0 0 ${VIEW} ${VIEW}`}
        role="img"
        aria-label="Service dependency map"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <g transform={`translate(${transform.x} ${transform.y}) translate(${VIEW / 2} ${VIEW / 2}) scale(${transform.k}) translate(${-VIEW / 2} ${-VIEW / 2})`}>
          {model.relationships.map((rel) => {
            if (!visible.has(rel.from) || !visible.has(rel.to)) return null;
            const a = place(rel.from);
            const b = place(rel.to);
            const lit = activeId ? rel.from === activeId || rel.to === activeId : false;
            const inImpact = activeId
              ? (rel.from === activeId || downstream.has(rel.from) || upstream.has(rel.from)) &&
                (rel.to === activeId || downstream.has(rel.to) || upstream.has(rel.to))
              : false;
            return (
              <line
                key={rel.id}
                className={`edge edge-${rel.kind} eh-${rel.health}${lit ? " is-lit" : ""}${activeId && !inImpact ? " is-dim" : ""}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
              />
            );
          })}
          {services.map((service) => {
            const p = place(service.id);
            const role = roleOf(service.id);
            return (
              <g
                key={service.id}
                className={`node node-${role} s-${service.state}`}
                transform={`translate(${p.x} ${p.y})`}
                onClick={() => onSelect(service.id === selectedId ? null : service.id)}
                onPointerEnter={() => setHoverId(service.id)}
                onPointerLeave={() => setHoverId(null)}
                role="button"
                tabIndex={0}
                aria-label={`${service.name}, ${service.state}`}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") onSelect(service.id);
                }}
              >
                <circle className="node-halo" r={11} />
                <circle className="node-core" r={7} />
                <text className="node-label" y={20} textAnchor="middle">
                  {service.name}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {interactive && (
        <div className="map-controls">
          <button type="button" onClick={() => zoom(1)} aria-label="Zoom in">
            <Icon name="plus" size={15} />
          </button>
          <button type="button" onClick={() => zoom(-1)} aria-label="Zoom out">
            <Icon name="minus" size={15} />
          </button>
          <button type="button" onClick={reset} aria-label="Reset view">
            <Icon name="target" size={15} />
          </button>
        </div>
      )}

      <div className="map-legend">
        {(["healthy", "warning", "degraded", "offline"] as const).map((s) => (
          <span key={s}>
            <StateDot state={s} /> {s}
          </span>
        ))}
      </div>

      {activeId && impact && (
        <div className="map-impact">
          <span className="map-impact-kind">
            <Icon name={KIND_ICON[model.byId.get(activeId)?.kind ?? "service"]} size={13} />
            {model.byId.get(activeId)?.name}
          </span>
          <span>
            <strong>{impact.downstream.length}</strong> affected if it fails
          </span>
          <span>
            <strong>{impact.upstream.length}</strong> dependencies
          </span>
        </div>
      )}
    </div>
  );
}
