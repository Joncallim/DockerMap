import type { GraphResponse } from "@dockermap/contracts";

/**
 * Dependency-free 3D topology engine.
 *
 * Turns a DockerMap graph (containers / networks / volumes + edges) into a
 * stable 3D layout, then exposes the rotation + perspective projection used by
 * the canvas renderer. No three.js — just vectors, so it ships in the bundle at
 * ~0 cost and runs everywhere.
 */

export type SceneNodeType = "container" | "network" | "volume";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface SceneNode {
  id: string;
  label: string;
  type: SceneNodeType;
  base: Vec3; // resting position (post force-relaxation)
}

export interface SceneEdge {
  source: string;
  target: string;
  relationship: string;
}

export interface Scene {
  nodes: SceneNode[];
  edges: SceneEdge[];
}

export interface Projected {
  node: SceneNode;
  sx: number; // screen x
  sy: number; // screen y
  depth: number; // rotated z, for painter sorting + fog
  scale: number; // perspective scale 0..1+
}

/** Small seeded PRNG so the layout is identical across reloads. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function typeOf(id: string): SceneNodeType {
  if (id.startsWith("network_")) return "network";
  if (id.startsWith("volume_")) return "volume";
  return "container";
}

/**
 * Build a legible architectural layout, then relax it:
 *   • networks form a backbone ring on the equator (y = 0)
 *   • containers lift into a dome above, near the networks they join
 *   • volumes settle below, near the container that mounts them
 */
export function buildScene(graph: GraphResponse): Scene {
  const rand = mulberry32(1337);
  const nodeIndex = new Map<string, SceneNode>();
  const nodes: SceneNode[] = graph.nodes.map((n) => {
    const type = (n.type as SceneNodeType) ?? typeOf(n.id);
    const node: SceneNode = { id: n.id, label: n.label, type, base: { x: 0, y: 0, z: 0 } };
    nodeIndex.set(n.id, node);
    return node;
  });

  const networks = nodes.filter((n) => n.type === "network");
  const containers = nodes.filter((n) => n.type === "container");
  const volumes = nodes.filter((n) => n.type === "volume");

  // Networks → backbone ring on the equator.
  const netRadius = 0.62;
  networks.forEach((net, i) => {
    const a = (i / Math.max(1, networks.length)) * Math.PI * 2;
    net.base = { x: Math.cos(a) * netRadius, y: 0, z: Math.sin(a) * netRadius };
  });

  const neighborsOf = (id: string) =>
    graph.edges
      .filter((e) => e.source === id || e.target === id)
      .map((e) => (e.source === id ? e.target : e.source));

  // Containers → averaged over the networks they connect to, lifted up.
  containers.forEach((c, i) => {
    const netNeighbors = neighborsOf(c.id)
      .map((id) => nodeIndex.get(id))
      .filter((n): n is SceneNode => !!n && n.type === "network");
    const seed = { x: 0, y: 0, z: 0 };
    if (netNeighbors.length) {
      for (const n of netNeighbors) {
        seed.x += n.base.x;
        seed.z += n.base.z;
      }
      seed.x /= netNeighbors.length;
      seed.z /= netNeighbors.length;
    }
    const a = (i / Math.max(1, containers.length)) * Math.PI * 2;
    c.base = {
      x: seed.x * 1.35 + Math.cos(a) * 0.22 + (rand() - 0.5) * 0.12,
      y: 0.55 + (rand() - 0.5) * 0.22,
      z: seed.z * 1.35 + Math.sin(a) * 0.22 + (rand() - 0.5) * 0.12,
    };
  });

  // Volumes → below the container that mounts them.
  volumes.forEach((v, i) => {
    const host = neighborsOf(v.id)
      .map((id) => nodeIndex.get(id))
      .find((n): n is SceneNode => !!n && n.type === "container");
    const seed = host ? host.base : { x: 0, y: 0, z: 0 };
    const a = (i / Math.max(1, volumes.length)) * Math.PI * 2;
    v.base = {
      x: seed.x + Math.cos(a) * 0.18 + (rand() - 0.5) * 0.1,
      y: -0.62 + (rand() - 0.5) * 0.16,
      z: seed.z + Math.sin(a) * 0.18 + (rand() - 0.5) * 0.1,
    };
  });

  relax(nodes, graph.edges);

  return { nodes, edges: graph.edges.map((e) => ({ ...e })) };
}

/** Light force-directed relaxation: repulsion + edge springs + soft centering. */
function relax(nodes: SceneNode[], edges: GraphResponse["edges"]) {
  const index = new Map(nodes.map((n) => [n.id, n]));
  const kRepel = 0.011;
  const kSpring = 0.06;
  const restLen = 0.5;
  const kCenter = 0.015;
  const damping = 0.82;
  const vel = new Map(nodes.map((n) => [n.id, { x: 0, y: 0, z: 0 }]));

  for (let step = 0; step < 160; step++) {
    const force = new Map(nodes.map((n) => [n.id, { x: 0, y: 0, z: 0 }]));

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = a.base.x - b.base.x;
        let dy = a.base.y - b.base.y;
        let dz = a.base.z - b.base.z;
        let d2 = dx * dx + dy * dy + dz * dz + 0.0001;
        const inv = kRepel / d2;
        const d = Math.sqrt(d2);
        dx = (dx / d) * inv;
        dy = (dy / d) * inv;
        dz = (dz / d) * inv;
        const fa = force.get(a.id)!;
        const fb = force.get(b.id)!;
        fa.x += dx;
        fa.y += dy;
        fa.z += dz;
        fb.x -= dx;
        fb.y -= dy;
        fb.z -= dz;
      }
    }

    for (const e of edges) {
      const a = index.get(e.source);
      const b = index.get(e.target);
      if (!a || !b) continue;
      const dx = b.base.x - a.base.x;
      const dy = b.base.y - a.base.y;
      const dz = b.base.z - a.base.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.0001;
      const f = (kSpring * (d - restLen)) / d;
      const fa = force.get(a.id)!;
      const fb = force.get(b.id)!;
      fa.x += dx * f;
      fa.y += dy * f;
      fa.z += dz * f;
      fb.x -= dx * f;
      fb.y -= dy * f;
      fb.z -= dz * f;
    }

    for (const n of nodes) {
      const f = force.get(n.id)!;
      f.x -= n.base.x * kCenter;
      f.y -= n.base.y * kCenter;
      f.z -= n.base.z * kCenter;
      const v = vel.get(n.id)!;
      v.x = (v.x + f.x) * damping;
      v.y = (v.y + f.y) * damping;
      v.z = (v.z + f.z) * damping;
      n.base.x += v.x;
      n.base.y += v.y;
      n.base.z += v.z;
    }
  }
}

/** Rotate a point by yaw (around Y) then pitch (around X). */
export function rotate(p: Vec3, yaw: number, pitch: number): Vec3 {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const x1 = p.x * cy - p.z * sy;
  const z1 = p.x * sy + p.z * cy;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const y1 = p.y * cp - z1 * sp;
  const z2 = p.y * sp + z1 * cp;
  return { x: x1, y: y1, z: z2 };
}

export interface ProjectOptions {
  yaw: number;
  pitch: number;
  cx: number;
  cy: number;
  radius: number; // pixel radius of the layout sphere
  focal: number; // camera focal length in normalized units
}

export function project(node: SceneNode, o: ProjectOptions): Projected {
  const r = rotate(node.base, o.yaw, o.pitch);
  const scale = o.focal / (o.focal + r.z);
  return {
    node,
    sx: o.cx + r.x * o.radius * scale,
    sy: o.cy - r.y * o.radius * scale,
    depth: r.z,
    scale,
  };
}
