import type { Relationship, Service } from "./model";
import { hashString } from "./model";

/**
 * A small, dependency-free 2D force layout for the service map. Deterministic
 * (seeded from service ids) so the graph never reshuffles between renders.
 */

export interface LayoutPoint {
  id: string;
  x: number;
  y: number;
}

export type LayoutMap = Map<string, LayoutPoint>;

export function layoutServices(services: Service[], relationships: Relationship[]): LayoutMap {
  const points: LayoutPoint[] = services.map((s, i) => {
    const angle = (i / Math.max(1, services.length)) * Math.PI * 2;
    const r = 0.35 + hashString(s.id) * 0.4;
    return { id: s.id, x: Math.cos(angle) * r, y: Math.sin(angle) * r };
  });
  const index = new Map(points.map((p) => [p.id, p]));
  const vel = new Map(points.map((p) => [p.id, { x: 0, y: 0 }]));

  const springs = relationships.filter((r) => index.has(r.from) && index.has(r.to));

  const kRepel = 0.02;
  const kSpring = 0.08;
  const restLen = 0.5;
  const kCenter = 0.02;
  const damping = 0.82;

  for (let step = 0; step < 220; step += 1) {
    const force = new Map(points.map((p) => [p.id, { x: 0, y: 0 }]));

    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const a = points[i];
        const b = points[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        const d2 = dx * dx + dy * dy + 0.0005;
        const d = Math.sqrt(d2);
        const f = kRepel / d2;
        dx = (dx / d) * f;
        dy = (dy / d) * f;
        const fa = force.get(a.id)!;
        const fb = force.get(b.id)!;
        fa.x += dx;
        fa.y += dy;
        fb.x -= dx;
        fb.y -= dy;
      }
    }

    for (const spring of springs) {
      const a = index.get(spring.from)!;
      const b = index.get(spring.to)!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) + 0.0005;
      const f = (kSpring * (d - restLen)) / d;
      const fa = force.get(a.id)!;
      const fb = force.get(b.id)!;
      fa.x += dx * f;
      fa.y += dy * f;
      fb.x -= dx * f;
      fb.y -= dy * f;
    }

    for (const p of points) {
      const f = force.get(p.id)!;
      f.x -= p.x * kCenter;
      f.y -= p.y * kCenter;
      const v = vel.get(p.id)!;
      v.x = (v.x + f.x) * damping;
      v.y = (v.y + f.y) * damping;
      p.x += v.x;
      p.y += v.y;
    }
  }

  return normalize(points);
}

function normalize(points: LayoutPoint[]): LayoutMap {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const out: LayoutMap = new Map();
  for (const p of points) {
    out.set(p.id, {
      id: p.id,
      x: ((p.x - minX) / spanX) * 2 - 1,
      y: ((p.y - minY) / spanY) * 2 - 1
    });
  }
  return out;
}
