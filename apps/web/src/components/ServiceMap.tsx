import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent
} from "react";
import { computeImpact, type Service, type SystemModel } from "../lib/model";
import { layoutServices } from "../lib/layout";
import Icon, { KIND_ICON } from "./Icon";
import { StateDot } from "./primitives";

const VIEW = 240;
const PAD = 26;
const NODE_EDGE_GAP = 10;
const NETWORK_TRACK_GAP = 2.8;
const NETWORK_COLORS = ["#22c55e", "#38bdf8", "#f59e0b", "#f472b6", "#a78bfa", "#14b8a6", "#fb7185", "#84cc16"];

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
  const [hiddenNetworks, setHiddenNetworks] = useState<Set<string>>(() => new Set());
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const services = useMemo(() => (filter ? model.services.filter(filter) : model.services), [model.services, filter]);
  const layout = useMemo(() => layoutServices(model.services, model.relationships), [model.services, model.relationships]);
  const servicesById = useMemo(() => new Map(services.map((service) => [service.id, service])), [services]);
  const networks = useMemo(() => {
    const networkOrder = new Map(model.networks.map((network, index) => [network.name, index]));
    const names = [...new Set(services.flatMap((service) => service.networks))].sort((a, b) => {
      const aOrder = networkOrder.get(a) ?? Number.MAX_SAFE_INTEGER;
      const bOrder = networkOrder.get(b) ?? Number.MAX_SAFE_INTEGER;
      return aOrder - bOrder || a.localeCompare(b);
    });
    return names.map((name, index) => ({
      name,
      color: NETWORK_COLORS[index % NETWORK_COLORS.length]
    }));
  }, [model.networks, services]);
  const networkByName = useMemo(() => new Map(networks.map((network) => [network.name, network])), [networks]);
  const enabledNetworkNames = useMemo(
    () => new Set(networks.filter((network) => !hiddenNetworks.has(network.name)).map((network) => network.name)),
    [hiddenNetworks, networks]
  );

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

  const edgePoints = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return { x1: from.x, y1: from.y, x2: to.x, y2: to.y };
    const ux = dx / len;
    const uy = dy / len;
    return {
      x1: from.x + ux * NODE_EDGE_GAP,
      y1: from.y + uy * NODE_EDGE_GAP,
      x2: to.x - ux * (NODE_EDGE_GAP + 1.5),
      y2: to.y - uy * (NODE_EDGE_GAP + 1.5)
    };
  };

  const offsetPoints = (points: ReturnType<typeof edgePoints>, index: number, total: number) => {
    if (total <= 1) return points;
    const dx = points.x2 - points.x1;
    const dy = points.y2 - points.y1;
    const len = Math.hypot(dx, dy);
    if (len === 0) return points;
    const distance = (index - (total - 1) / 2) * NETWORK_TRACK_GAP;
    const ox = (-dy / len) * distance;
    const oy = (dx / len) * distance;
    return {
      x1: points.x1 + ox,
      y1: points.y1 + oy,
      x2: points.x2 + ox,
      y2: points.y2 + oy
    };
  };

  const toggleNetwork = (name: string) => {
    setHiddenNetworks((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

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
        <defs>
          <marker id="edge-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5.8" markerHeight="5.8" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
          </marker>
        </defs>
        <g transform={`translate(${transform.x} ${transform.y}) translate(${VIEW / 2} ${VIEW / 2}) scale(${transform.k}) translate(${-VIEW / 2} ${-VIEW / 2})`}>
          {model.relationships.map((rel) => {
            if (!visible.has(rel.from) || !visible.has(rel.to)) return null;
            const fromService = servicesById.get(rel.from);
            const toService = servicesById.get(rel.to);
            if (!fromService || !toService) return null;
            const a = place(rel.from);
            const b = place(rel.to);
            const points = edgePoints(a, b);
            const lit = activeId ? rel.from === activeId || rel.to === activeId : false;
            const inImpact = activeId
              ? (rel.from === activeId || downstream.has(rel.from) || upstream.has(rel.from)) &&
                (rel.to === activeId || downstream.has(rel.to) || upstream.has(rel.to))
              : false;
            const toNetworks = new Set(toService.networks);
            const edgeNetworks = fromService.networks.filter((network) => toNetworks.has(network) && enabledNetworkNames.has(network));
            return (
              <g key={rel.id} className="edge-group">
                <title>
                  {fromService.name} depends on {toService.name}
                  {edgeNetworks.length > 0 ? ` via ${edgeNetworks.join(", ")}` : ""}
                </title>
                {edgeNetworks.map((network, index) => {
                  const networkDef = networkByName.get(network);
                  const track = offsetPoints(points, index, edgeNetworks.length);
                  return (
                    <line
                      key={`${rel.id}:${network}`}
                      className={`network-edge${activeId && !inImpact ? " is-dim" : ""}`}
                      style={{ "--network-color": networkDef?.color ?? NETWORK_COLORS[0] } as CSSProperties}
                      x1={track.x1}
                      y1={track.y1}
                      x2={track.x2}
                      y2={track.y2}
                    />
                  );
                })}
                <line
                  className={`edge edge-${rel.kind} eh-${rel.health}${lit ? " is-lit" : ""}${activeId && !inImpact ? " is-dim" : ""}`}
                  x1={points.x1}
                  y1={points.y1}
                  x2={points.x2}
                  y2={points.y2}
                  markerEnd="url(#edge-arrow)"
                />
              </g>
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

      {networks.length > 0 && (
        <div className="map-network-panel" aria-label="Network overlays">
          <div className="map-network-title">Networks</div>
          <div className="map-network-list">
            {networks.map((network) => (
              <label key={network.name} className="map-network-option" style={{ "--network-color": network.color } as CSSProperties}>
                <input type="checkbox" checked={!hiddenNetworks.has(network.name)} onChange={() => toggleNetwork(network.name)} />
                <span className="network-swatch" aria-hidden="true" />
                <span>{network.name}</span>
              </label>
            ))}
          </div>
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
