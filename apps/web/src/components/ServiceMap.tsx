import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
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
  /** Visible explanation when this instance has no graph nodes. */
  emptyMessage?: string;
}
export default function ServiceMap({ model, selectedId, selectedService, onSelect, interactive = true, filter, height, focusNodeId, focusToken, emptyMessage = "No services match the current filter. Clear the filter to widen the view." }: ServiceMapProps) {
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [transform, setTransform] = useState<Transform>({ k: 1, x: 0, y: 0 });
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
  // service is resolved through the SAME predicate that makes a node
  // selectable (rendered by the active filter, unique id AND name, present
  // in byId, interactive) — NOT by a raw hoverId. A snapshot/model refresh
  // that turns the hovered occurrence collided replaces its <g> (or drops
  // its pointer handlers) without ever firing pointerleave, so a raw hoverId
  // would stay stale: the FIRST collided occurrence would carry node-self
  // while the banner read "anonymous". Deriving the hover from the CURRENT
  // model keeps it alive only while that service remains valid and falls
  // back IMMEDIATELY (in the same render as the refresh) to the selection's
  // occurrence key — or to no active state at all. The pre-R3 hover radius
  // is preserved: hovering with no selection highlights the hovered node,
  // and hovering a different node while one is selected re-centres the
  // radius on it (hoverable nodes are exactly the unique-id, non-collided
  // ones, so the occurrence resolves unambiguously).
  const hoveredService = useMemo(() => {
    if (!interactive || !hoverId) return null;
    const service = servicesById.get(hoverId);
    if (!service) return null;
    if (model.serviceIdCollisions.has(service.id) || model.serviceNameCollisions.has(service.name)) return null;
    return service;
  }, [interactive, hoverId, servicesById, model.serviceIdCollisions, model.serviceNameCollisions]);
  // The hover's OWN layout key, derived from the resolved occurrence.
  const hoverKey = hoveredService ? (layoutKeyByService.get(hoveredService) ?? null) : null;
  const activeKey = hoverKey ?? selectedKey;
  const activeId = hoveredService?.id ?? (selectedKey ? (selectedService?.id ?? selectedId) : null);
  const impact = useMemo(() => (activeId ? computeImpact(model, activeId) : null), [model, activeId]);
  const upstream = useMemo(() => new Set(impact?.upstream ?? []), [impact]);
  const downstream = useMemo(() => new Set(impact?.downstream ?? []), [impact]);

  // A hover whose service is no longer selectable (collided by a refresh,
  // filtered out, or the map turned read-only) is STALE STATE: the node's
  // replaced <g> can never fire pointerleave, so clear the id explicitly.
  // The derived hover above already ignores it; clearing prevents a later
  // refresh from resurrecting the hover without any pointer event.
  useEffect(() => {
    if (hoverId && !hoveredService) setHoverId(null);
  }, [hoverId, hoveredService]);

  // The impact banner's IDENTITY is occurrence-qualified too: hovering names
  // the CURRENT hovered occurrence (resolved by the selectable predicate
  // above — never a collided "anonymous" lookup), an exact selection
  // occurrence names itself, and an id-only selection falls back to the
  // collision-safe byId lookup. byId EXCLUDES collided ids, so the exact
  // occurrence must come from the caller (selectedService) — never from a
  // lookup that would label the highlighted node "anonymous". Semantic
  // impact traversal (computeImpact) stays fail-closed and untouched.
  const activeService = useMemo(() => {
    if (hoveredService) return hoveredService;
    if (selectedService) return selectedService;
    if (!selectedId) return null;
    return model.byId.get(selectedId) ?? null;
  }, [hoveredService, selectedService, selectedId, model.byId]);

  const roleOf = (key: string, id: string): "self" | "up" | "down" | "dim" | "none" => {
    if (!activeKey) return "none";
    if (key === activeKey) return "self";
    if (downstream.has(id)) return "down";
    if (upstream.has(id)) return "up";
    return "dim";
  };

  const visible = new Set(services.filter((service) => model.byId.has(service.id)).map((service) => service.id));
  const visibleRelationships = useMemo(
    () => model.relationships.filter((relationship) => visible.has(relationship.from) && visible.has(relationship.to)),
    [model.relationships, visible]
  );
  const relationshipSummary = useMemo(() => {
    const parts: string[] = [];
    if (visibleRelationships.length === 0) parts.push("No Compose start-order declarations are visible in this graph.");
    else parts.push(visibleRelationships.map((relationship) => {
      const from = model.byId.get(relationship.from);
      const to = model.byId.get(relationship.to);
      return `${identityText(from?.name, UNAVAILABLE_SERVICE)} declares start order after ${identityText(to?.name, UNAVAILABLE_SERVICE)}.`;
    }).join(" "));
    // Collided occurrences (duplicate ids/names after redaction) are visible
    // on the graph but noninteractive; the text alternative names them so
    // screen-reader users get the same "collision" context sighted users see.
    const collidedNames = [...new Set(
      services
        .filter((service) => model.serviceIdCollisions.has(service.id) || model.serviceNameCollisions.has(service.name))
        .map((service) => identityText(service.name, UNAVAILABLE_SERVICE))
    )];
    if (collidedNames.length > 0) {
      parts.push(`Identity collision: ${collidedNames.join(", ")} — multiple records share this identity, so selection and detail routing are unavailable.`);
    }
    return parts.join(" ");
  }, [model, services, visibleRelationships]);

  useEffect(() => {
    if (focusNodeId) nodeRefs.current.get(focusNodeId)?.focus();
  }, [focusNodeId, focusToken]);

  // A directory selection can replace a dense default topology with a wholly
  // different focused context. Preserve pan/zoom while exploring one graph,
  // but reset it when that context changes so the selected node cannot remain
  // off-canvas behind a stale transform.
  useEffect(() => {
    setTransform({ k: 1, x: 0, y: 0 });
  }, [selectedKey]);

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
        aria-label="Compose start-order map"
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
            return (
              <g key={`${rel.id}-${relationshipIndex}`} className="edge-group">
                <title>{`${identityText(fromService.name, UNAVAILABLE_SERVICE)} declares start order after ${identityText(toService.name, UNAVAILABLE_SERVICE)}`}</title>
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
                    // Same toggle path as mouse click: Enter/Space on an
                    // already-selected node deselects it (aria-pressed must
                    // be toggleable by keyboard, #86 C1).
                    onSelect(service.id === selectedId ? null : service.id);
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

      {services.length === 0 && (
        <div className="map-empty-state" role="status" aria-live="polite">
          {emptyMessage}
        </div>
      )}

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
            <StateDot state={s} decorative /> {s}
          </span>
        ))}
      </div>

      {activeId && impact && (
        <div className="map-impact" aria-live="polite" aria-atomic="true">
          <span className="map-impact-kind">
            <Icon name={KIND_ICON[activeService?.kind ?? "service"]} size={13} />
            {identityText(activeService?.name, UNAVAILABLE_SERVICE)}
          </span>
          <span>
            <strong>{impact.downstream.length}</strong> downstream declarations
          </span>
          <span>
            <strong>{impact.upstream.length}</strong> upstream declarations
          </span>
        </div>
      )}
      </div>
      <p id={descriptionId} className="sr-only">{relationshipSummary}</p>
    </>
  );
}
