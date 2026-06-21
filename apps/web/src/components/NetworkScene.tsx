import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GraphResponse } from "@dockermap/contracts";
import { buildScene, project, type Projected, type SceneNode } from "../lib/topology";

/**
 * Animated 3D network architecture.
 *
 * A hand-rolled canvas renderer (no three.js): force-relaxed layout, perspective
 * projection, depth sorting, glow nodes and edges with flowing pulses.
 *
 * Motion follows the emil / animation-review skill:
 *   • the orbit is *justified* — it reveals depth you can't get from a flat graph
 *   • drag interrupts and retargets from the current angle, never restarts
 *   • prefers-reduced-motion → no auto-orbit, no pulses; still draggable
 *   • only the canvas repaints; nothing layout-thrashes
 */

type Palette = Record<string, string>;

const COLORS: Record<SceneNode["type"], string> = {
  container: "#5fe3d1", // aqua
  network: "#f3c06a", // gold
  volume: "#f0937a", // coral
};

const TYPE_LABEL: Record<SceneNode["type"], string> = {
  container: "Container",
  network: "Network",
  volume: "Volume",
};

interface NetworkSceneProps {
  graph: GraphResponse;
  height?: number;
  onSelect?: (node: SceneNode) => void;
}

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export default function NetworkScene({ graph, height = 460, onSelect }: NetworkSceneProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scene = useMemo(() => buildScene(graph), [graph]);

  const [hovered, setHovered] = useState<{ node: SceneNode; x: number; y: number } | null>(null);
  const reduced = prefersReducedMotion();

  // Mutable view state kept in refs so the rAF loop never re-subscribes.
  const view = useRef({ yaw: 0.6, pitch: -0.42, yawVel: reduced ? 0 : 0.0016, lastInteract: 0 });
  const drag = useRef<{ active: boolean; x: number; y: number; moved: number } | null>(null);
  const hoverId = useRef<string | null>(null);
  const projectedRef = useRef<Projected[]>([]);

  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const e of graph.edges) {
      if (!map.has(e.source)) map.set(e.source, new Set());
      if (!map.has(e.target)) map.set(e.target, new Set());
      map.get(e.source)!.add(e.target);
      map.get(e.target)!.add(e.source);
    }
    return map;
  }, [graph.edges]);

  const draw = useCallback(
    (ctx: CanvasRenderingContext2D, w: number, h: number, time: number, palette: Palette) => {
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2;
      const cy = h / 2 + h * 0.04;
      const radius = Math.min(w, h) * 0.42;
      const opts = { yaw: view.current.yaw, pitch: view.current.pitch, cx, cy, radius, focal: 2.6 };

      const projected = scene.nodes.map((n) => project(n, opts));
      const byId = new Map(projected.map((p) => [p.node.id, p]));
      projectedRef.current = projected;

      const active = hoverId.current;
      const activeSet = active ? adjacency.get(active) ?? new Set<string>() : null;

      // Backbone equator ring — grounds the 3D space.
      ctx.save();
      ctx.strokeStyle = palette.ring;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= 64; i++) {
        const a = (i / 64) * Math.PI * 2;
        const p = project(
          { id: "_r", label: "", type: "network", base: { x: Math.cos(a) * 0.62, y: 0, z: Math.sin(a) * 0.62 } },
          opts,
        );
        if (i === 0) ctx.moveTo(p.sx, p.sy);
        else ctx.lineTo(p.sx, p.sy);
      }
      ctx.stroke();
      ctx.restore();

      // Edges (behind nodes), depth-sorted back-to-front.
      const edges = graph.edges
        .map((e) => ({ e, a: byId.get(e.source), b: byId.get(e.target) }))
        .filter((x) => x.a && x.b)
        .sort((l, r) => (l.a!.depth + l.b!.depth) / 2 - (r.a!.depth + r.b!.depth) / 2);

      for (const { e, a, b } of edges) {
        if (!a || !b) continue;
        const incident = active ? e.source === active || e.target === active : false;
        const dim = active && !incident;
        const fog = Math.max(0.12, Math.min(1, (a.depth + b.depth) / -2 + 0.85));
        const isMount = e.relationship === "mounts";
        const base = isMount ? palette.edgeMount : palette.edge;
        ctx.strokeStyle = incident ? (isMount ? COLORS.volume : COLORS.container) : base;
        ctx.globalAlpha = dim ? 0.06 : incident ? 0.9 : 0.32 * fog;
        ctx.lineWidth = incident ? 1.8 : 1;
        ctx.beginPath();
        ctx.moveTo(a.sx, a.sy);
        ctx.lineTo(b.sx, b.sy);
        ctx.stroke();

        // Flowing pulse along the edge (ambient "live" signal).
        if (!reduced && !dim) {
          const speed = 0.00022;
          const t = ((time * speed + hashStr(e.source + e.target)) % 1 + 1) % 1;
          const px = a.sx + (b.sx - a.sx) * t;
          const py = a.sy + (b.sy - a.sy) * t;
          ctx.globalAlpha = incident ? 0.95 : 0.5 * fog;
          ctx.fillStyle = incident ? (isMount ? COLORS.volume : COLORS.container) : palette.pulse;
          ctx.beginPath();
          ctx.arc(px, py, incident ? 2.4 : 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;

      // Nodes, painter-sorted back-to-front.
      const order = [...projected].sort((l, r) => r.depth - l.depth);
      for (const p of order) {
        const color = COLORS[p.node.type];
        const isHover = active === p.node.id;
        const isNeighbor = activeSet?.has(p.node.id) ?? false;
        const dim = active && !isHover && !isNeighbor;
        const fog = Math.max(0.25, Math.min(1, p.depth / -2 + 0.9));
        const r = (p.node.type === "network" ? 9 : 7) * p.scale * (isHover ? 1.5 : 1);

        // Glow.
        ctx.globalAlpha = dim ? 0.12 : (isHover ? 0.55 : 0.32) * fog;
        const grad = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, r * 4.5);
        grad.addColorStop(0, color);
        grad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, r * 4.5, 0, Math.PI * 2);
        ctx.fill();

        // Core.
        ctx.globalAlpha = dim ? 0.3 : 1;
        ctx.fillStyle = palette.coreFill;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = isHover ? 2.4 : 1.6;
        ctx.strokeStyle = color;
        ctx.globalAlpha = dim ? 0.35 : 1;
        ctx.stroke();

        // Inner dot.
        ctx.globalAlpha = dim ? 0.4 : fog;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, r * 0.42, 0, Math.PI * 2);
        ctx.fill();

        // Label — near / hovered nodes only, to avoid clutter.
        if (!dim && (isHover || isNeighbor || p.scale > 1.02)) {
          ctx.globalAlpha = isHover ? 1 : 0.7 * fog;
          ctx.fillStyle = palette.label;
          ctx.font = `${isHover ? 600 : 500} ${Math.round(12 * Math.min(1.3, p.scale))}px "Albert Sans", sans-serif`;
          ctx.textAlign = "center";
          ctx.fillText(p.node.label, p.sx, p.sy - r - 8);
        }
      }
      ctx.globalAlpha = 1;
    },
    [adjacency, graph.edges, reduced, scene.nodes],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Hardcoded hex/rgba — canvas oklch() parsing is inconsistent across engines.
    const palette: Palette = {
      ring: "rgba(120, 150, 175, 0.16)",
      edge: "rgba(150, 180, 200, 0.7)",
      edgeMount: "rgba(240, 147, 122, 0.6)",
      pulse: "rgba(190, 215, 230, 0.9)",
      coreFill: "#0b1017",
      label: "#eef3f8",
    };

    let raf = 0;
    let w = 0;
    let h = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      w = wrap.clientWidth;
      h = height;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const loop = (time: number) => {
      const v = view.current;
      const idle = time - v.lastInteract > 2200;
      if (!reduced && idle && !drag.current?.active) {
        // Ease yaw velocity back to ambient drift.
        v.yawVel += (0.0016 - v.yawVel) * 0.04;
        v.yaw += v.yawVel;
      }
      draw(ctx, w, h, time, palette);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [draw, height, reduced]);

  const hitTest = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best: Projected | null = null;
    let bestDist = Infinity;
    for (const p of projectedRef.current) {
      const r = (p.node.type === "network" ? 9 : 7) * p.scale + 8;
      const d = (p.sx - x) ** 2 + (p.sy - y) ** 2;
      if (d < r * r && d < bestDist) {
        best = p;
        bestDist = d;
      }
    }
    return best ? { p: best, x, y } : null;
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { active: true, x: e.clientX, y: e.clientY, moved: 0 };
    view.current.lastInteract = performance.now();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d?.active) {
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      d.moved += Math.abs(dx) + Math.abs(dy);
      view.current.yaw += dx * 0.008;
      view.current.pitch = Math.max(-1.2, Math.min(1.2, view.current.pitch + dy * 0.006));
      view.current.yawVel = dx * 0.008; // carry momentum
      view.current.lastInteract = performance.now();
      d.x = e.clientX;
      d.y = e.clientY;
      return;
    }
    const hit = hitTest(e.clientX, e.clientY);
    hoverId.current = hit?.p.node.id ?? null;
    setHovered(hit ? { node: hit.p.node, x: hit.x, y: hit.y } : null);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d && d.moved < 6) {
      const hit = hitTest(e.clientX, e.clientY);
      if (hit && onSelect) onSelect(hit.p.node);
    }
  };

  const counts = useMemo(() => {
    const c = { container: 0, network: 0, volume: 0 } as Record<SceneNode["type"], number>;
    for (const n of scene.nodes) c[n.type]++;
    return c;
  }, [scene.nodes]);

  return (
    <div className="scene" ref={wrapRef} style={{ height }}>
      <canvas
        ref={canvasRef}
        className="scene-canvas"
        style={{ cursor: hovered ? "pointer" : drag.current?.active ? "grabbing" : "grab" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          hoverId.current = null;
          setHovered(null);
          drag.current = null;
        }}
      />

      <div className="scene-legend" aria-hidden="true">
        {(Object.keys(COLORS) as SceneNode["type"][]).map((t) => (
          <span key={t} className="scene-legend-item">
            <i style={{ background: COLORS[t] }} />
            {TYPE_LABEL[t]}
            <em>{counts[t]}</em>
          </span>
        ))}
      </div>

      <div className="scene-hint" aria-hidden="true">
        {reduced ? "Drag to orbit" : "Auto-orbit · drag to steer · click a node"}
      </div>

      {hovered && (
        <div className="scene-tip" style={{ left: hovered.x, top: hovered.y }} role="status">
          <span className="scene-tip-kind" style={{ color: COLORS[hovered.node.type] }}>
            {TYPE_LABEL[hovered.node.type]}
          </span>
          <strong>{hovered.node.label}</strong>
        </div>
      )}
    </div>
  );
}

function hashStr(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (Math.abs(h) % 1000) / 1000;
}
