import {
  useEffect,
  useId,
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
import { identityText, COLLISION_HINT, COLLISION_TAG, UNAVAILABLE_NETWORK, UNAVAILABLE_SERVICE } from "../lib/identity";

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
  /**
   * Exact service OCCURRENCE for the selection, when the caller can identify
   * one (e.g. ServiceDetail resolves a unique NAME). Selection is then
   * compared by layout key, so a redaction-collided canonical id still
   * highlights exactly the intended occurrence instead of every record that
   * shares the id. When omitted, an id-only selection is honoured ONLY for
   * unique ids — a collided id cannot identify one occurrence, so the
   * selected state is suppressed entirely.
   */
  selectedService?: Service | null;
  onSelect: (id: string | null) => void;
  interactive?: boolean;
  filter?: (service: Service) => boolean;
  height?: number;
  focusNodeId?: string | null;
  /**
   * Monotonic focus-request token: paired with `focusNodeId`, it lets the
   * parent re-request focus on the SAME node (e.g. clearing the selection a
   * second time) — the effect dependency changes even when the node id does
   * not, so the focus call runs again.
   */
  focusToken?: number;
}

export default function ServiceMap({ model, selectedId, selectedService, onSelect, interactive = true, filter, height, focusNodeId, focusToken }: ServiceMapProps) {
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [transform, setTransform] = useState<Transform>({ k: 1, x: 0, y: 0 });
  const [hiddenNetworks, setHiddenNetworks] = useState<Set<string>>(() => new Set());
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const nodeRefs = useRef(new Map<string, SVGGElement>());
  const descriptionId = useId();

  const services = useMemo(() => (filter ? model.services.filter(filter) : model.services), [model.services, filter]);
  // The layout is keyed by SERVICE OCCURRENCE (duplicate canonical ids would
  // otherwise share ONE coordinate and paint over each other). Nodes look up
  // their own occurrence key; semantic edges (which only reference uniquely
  // resolved canonical ids) attach to the FIRST occurrence of that id.
  const layout = useMemo(
    () => layoutServices(model.services, model.relationships, (service, index) => `${service.id}\u0000${index}`),
    [model.services, model.relationships]
  );
  const layoutKeyByService = useMemo(() => {
    const map = new Map<Service, string>();
    model.services.forEach((service, index) => map.set(service, `${service.id}\u0000${index}`));
    return map;
  }, [model.services]);
  const firstLayoutKeyForId = useMemo(() => {
    const map = new Map<string, string>();
    model.services.forEach((service, index) => {
      if (!map.has(service.id)) map.set(service.id, `${service.id}\u0000${index}`);
    });
    return map;
  }, [model.services]);
  const servicesById = useMemo(() => new Map(services.filter((service) => model.byId.has(service.id)).map((service) => [service.id, service])), [model.byId, services]);
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

  const place = (key: string | undefined) => {
    const p = key ? layout.get(key) : undefined;
    const half = VIEW / 2;
    const usable = half - PAD;
    return {
      x: half + (p?.x ?? 0) * usable,
      y: half + (p?.y ?? 0) * usable
    };
  };

  // The ACTIVE selection is occurrence-qualified: an exact service object
  // resolves to its own layout key; an id-only selection resolves through the
  // first-occurrence map ONLY for unique ids. A collided id cannot identify
  // one occurrence, so the selected state is suppressed (no node-self, no
  // impact) rather than highlighting every record that shares the id.
  const selectedKey = useMemo(() => {
    if (selectedService) return layoutKeyByService.get(selectedService) ?? null;
    if (!selectedId) return null;
    if (model.serviceIdCollisions.has(selectedId)) return null;
    return firstLayoutKeyForId.get(selectedId) ?? null;
  }, [selectedService, selectedId, layoutKeyByService, firstLayoutKeyForId, model.serviceIdCollisions]);

  // The ACTIVE highlight is occurrence-qualified. While hovering, the ACTIVE
  // key is the hovered node's OWN layout key — hoverable nodes are exactly
  // the unique-id (non-collided) ones, so the first-occurrence map resolves
  // the hovered node's key unambiguously (this restores the pre-R3 hover
  // impact radius: hovering with no selection highlights the hovered node,
  // and hovering a different node while one is selected re-centres the
  // radius on it). Without a hover, the selection's occurrence key applies.
  const activeKey = hoverId ? (firstLayoutKeyForId.get(hoverId) ?? null) : selectedKey;
  const activeId = hoverId ?? (selectedKey ? (selectedService?.id ?? selectedId) : null);
  const impact = useMemo(() => (activeId ? computeImpact(model, activeId) : null), [model, activeId]);
  const upstream = useMemo(() => new Set(impact?.upstream ?? []), [impact]);
  const downstream = useMemo(() => new Set(impact?.downstream ?? []), [impact]);

  // The impact banner's IDENTITY is occurrence-qualified too: hovering names
  // the HOVERED occurrence (only unique-id, non-collided nodes are hoverable,
  // so the services list resolves it exactly), an exact selection occurrence
  // names itself, and an id-only selection falls back to the collision-safe
  // byId lookup. byId EXCLUDES collided ids, so the exact occurrence must
  // come from the caller (selectedService) — never from a lookup that would
  // label the highlighted node "anonymous". Semantic impact traversal
  // (computeImpact) stays fail-closed and untouched.
  const activeService = useMemo(() => {
    if (hoverId) return servicesById.get(hoverId) ?? null;
    if (selectedService) return selectedService;
    if (!selectedId) return null;
    return model.byId.get(selectedId) ?? null;
  }, [hoverId, servicesById, selectedService, selectedId, model.byId]);

  const roleOf = (key: string, id: string): "self" | "up" | "down" | "dim" | "none" => {
    if (!activeKey) return "none";
    if (key === activeKey) return "self";
    if (downstream.has(id)) return "down";
    if (upstream.has(id)) return "up";
    return "dim";
  };

  const visible = new Set(services.filter((service) => model.byId.has(service.id)).map((service) => service.id));
  const relationshipSummary = useMemo(() => {
    const parts: string[] = [];
    if (model.relationships.length === 0) parts.push("No service relationships are recorded.");
    else parts.push(model.relationships.map((relationship) => {
      const from = model.byId.get(relationship.from);
      const to = model.byId.get(relationship.to);
      return `${identityText(from?.name, UNAVAILABLE_SERVICE)} depends on ${identityText(to?.name, UNAVAILABLE_SERVICE)}.`;
    }).join(" "));
    // Collided occurrences (duplicate ids/names after redaction) are visible
    // on the graph but noninteractive; the text alternative names them so
    // screen-reader users get the same "collision" context sighted users see.
    const collidedNames = [...new Set(
      model.services
        .filter((service) => model.serviceIdCollisions.has(service.id) || model.serviceNameCollisions.has(service.name))
        .map((service) => identityText(service.name, UNAVAILABLE_SERVICE))
    )];
    if (collidedNames.length > 0) {
      parts.push(`Identity collision: ${collidedNames.join(", ")} — multiple records share this identity, so selection and detail routing are unavailable.`);
    }
    return parts.join(" ");
  }, [model]);

  useEffect(() => {
    if (focusNodeId) nodeRefs.current.get(focusNodeId)?.focus();
  }, [focusNodeId, focusToken]);

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
    <>
      <div className="map" style={height ? { height } : undefined}>
      <svg
        className={`map-svg${interactive ? " is-interactive" : ""}`}
        viewBox={`0 0 ${VIEW} ${VIEW}`}
        role={interactive ? "group" : "img"}
        aria-label="Service dependency map"
        aria-describedby={descriptionId}
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
          {model.relationships.map((rel, relationshipIndex) => {
            if (!visible.has(rel.from) || !visible.has(rel.to)) return null;
            const fromService = servicesById.get(rel.from);
            const toService = servicesById.get(rel.to);
            if (!fromService || !toService) return null;
            const a = place(firstLayoutKeyForId.get(rel.from));
            const b = place(firstLayoutKeyForId.get(rel.to));
            const points = edgePoints(a, b);
            const lit = activeId ? rel.from === activeId || rel.to === activeId : false;
            const inImpact = activeId
              ? (rel.from === activeId || downstream.has(rel.from) || upstream.has(rel.from)) &&
                (rel.to === activeId || downstream.has(rel.to) || upstream.has(rel.to))
              : false;
            const toNetworks = new Set(toService.networks);
            const edgeNetworks = fromService.networks.filter((network) => toNetworks.has(network) && enabledNetworkNames.has(network));
            return (
              <g key={`${rel.id}-${relationshipIndex}`} className="edge-group">
                <title>
                  {identityText(fromService.name, UNAVAILABLE_SERVICE)} depends on {identityText(toService.name, UNAVAILABLE_SERVICE)}
                  {edgeNetworks.length > 0 ? ` via ${edgeNetworks.map((n) => (n === "" ? UNAVAILABLE_NETWORK : n)).join(", ")}` : ""}
                </title>
                {edgeNetworks.map((network, index) => {
                  const networkDef = networkByName.get(network);
                  const track = offsetPoints(points, index, edgeNetworks.length);
                  return (
                    <line
                      key={`${rel.id}-${relationshipIndex}:${network}-${index}`}
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
          {services.map((service, serviceIndex) => {
            const p = place(layoutKeyByService.get(service));
            const role = roleOf(layoutKeyByService.get(service)!, service.id);
            // Collided occurrences (duplicate service id OR duplicate name
            // after redaction) stay visible but are never interactive: no
            // selection can be made without pointing at the wrong record.
            const collided = model.serviceIdCollisions.has(service.id) || model.serviceNameCollisions.has(service.name);
            const selectable = interactive && !collided && model.byId.has(service.id);
            return (
              <g
                key={`${service.id}-${serviceIndex}`}
                className={`node${selectable ? " node-interactive" : ""} node-${role} s-${service.state}${collided ? " node-collided" : ""}`}
                transform={`translate(${p.x} ${p.y})`}
                ref={(element) => {
                  if (element && selectable) nodeRefs.current.set(service.id, element);
                }}
                onClick={selectable ? () => onSelect(service.id === selectedId ? null : service.id) : undefined}
                onPointerEnter={selectable ? () => setHoverId(service.id) : undefined}
                onPointerLeave={selectable ? () => setHoverId(null) : undefined}
                role={selectable ? "button" : undefined}
                aria-pressed={selectable ? selectedId === service.id : undefined}
                tabIndex={selectable ? 0 : undefined}
                aria-label={selectable ? `${identityText(service.name, UNAVAILABLE_SERVICE)}, ${service.state}` : undefined}
                onKeyDown={(e) => {
                  if (selectable && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    onSelect(service.id);
                  }
                }}
              >
                <circle className="node-halo" r={11} />
                <circle className="node-core" r={7} />
                <text className="node-label" y={20} textAnchor="middle">
                  {identityText(service.name, UNAVAILABLE_SERVICE)}
                </text>
                {collided && (
                  <>
                    <title>{COLLISION_HINT}</title>
                    <text className="node-collision-tag" y={30} textAnchor="middle">{COLLISION_TAG}</text>
                  </>
                )}
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
            {networks.map((network, index) => (
              <label key={`${network.name}-${index}`} className="map-network-option" style={{ "--network-color": network.color } as CSSProperties}>
                <input type="checkbox" checked={!hiddenNetworks.has(network.name)} onChange={() => toggleNetwork(network.name)} />
                <span className="network-swatch" aria-hidden="true" />
                <span>{identityText(network.name, UNAVAILABLE_NETWORK)}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="map-legend">
        {(["healthy", "warning", "degraded", "offline"] as const).map((s) => (
          <span key={s}>
            <StateDot state={s} decorative /> {s}
          </span>
        ))}
      </div>

      {activeId && impact && (
        <div className="map-impact">
          <span className="map-impact-kind">
            <Icon name={KIND_ICON[activeService?.kind ?? "service"]} size={13} />
            {identityText(activeService?.name, UNAVAILABLE_SERVICE)}
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
      <p id={descriptionId} className="sr-only">{relationshipSummary}</p>
    </>
  );
}
