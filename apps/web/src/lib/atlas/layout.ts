import type { AtlasCamera, AtlasKey, AtlasLayout, AtlasModel, AtlasPoint, AtlasRole, AtlasSubject } from "./types";

/**
 * Fixed logical geometry. These are deliberately independent of viewport,
 * font metrics, theme, DOM measurement and graph-wide min/max normalization.
 */
export const ATLAS_LAYOUT = {
  policyVersion: "atlas-v1/local-lanes" as const,
  cardWidth: 46,
  cardHeight: 30,
  columnGap: 18,
  rowGap: 18,
  laneGap: 96,
  columnsPerLane: 8,
  diagnosticX: -128,
  diagnosticY: 0,
  maxFocusTranslation: 100_000
} as const;

/**
 * Viewport state is deliberately outside the deterministic semantic/layout
 * payload. The current overview has no pan, zoom, or fit controls, but its
 * entry framing is still named here so future interaction work cannot turn a
 * routine coherent revision into an implicit whole-host refit.
 */
export const ATLAS_CAMERA_POLICY = {
  version: "atlas-v1/refresh-camera-1",
  initial: { x: 0, y: 0, zoom: 1 },
  preserveOn: ["state", "relation", "attachment", "unrelated_structure", "lens"] as const
} as const;

const PROVIDERS = [
  "docker", "compose", "host", "systemd", "scheduled_job", "npm", "pm2", "tmux", "tailscale", "headscale",
  "cloudflare", "caddy", "reverse_proxy", "local_dns", "dns_provider", "external_api", "process", "python",
  "network", "kubernetes", "other"
] as const;
const ROLES: readonly AtlasRole[] = ["primary", "context", "attachment", "inspector_only", "unsupported"];

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function laneOrdinal(subject: Extract<AtlasSubject, { routability: "routable" }>): number {
  const provider = PROVIDERS.indexOf(subject.source.provider as (typeof PROVIDERS)[number]);
  const role = ROLES.indexOf(subject.role);
  // `RuntimeProviderKind` is closed, but keep an unknown future provider in a
  // deterministic isolated lane rather than changing established lanes.
  return (provider < 0 ? PROVIDERS.length : provider) * ROLES.length + (role < 0 ? ROLES.length - 1 : role);
}

function pointForRoutable(subject: Extract<AtlasSubject, { routability: "routable" }>, index: number): AtlasPoint {
  const lane = laneOrdinal(subject);
  const column = index % ATLAS_LAYOUT.columnsPerLane;
  const row = Math.floor(index / ATLAS_LAYOUT.columnsPerLane);
  return {
    subject: subject.key,
    x: lane * (ATLAS_LAYOUT.columnsPerLane * (ATLAS_LAYOUT.cardWidth + ATLAS_LAYOUT.columnGap) + ATLAS_LAYOUT.laneGap) +
      column * (ATLAS_LAYOUT.cardWidth + ATLAS_LAYOUT.columnGap),
    y: row * (ATLAS_LAYOUT.cardHeight + ATLAS_LAYOUT.rowGap),
    width: ATLAS_LAYOUT.cardWidth,
    height: ATLAS_LAYOUT.cardHeight
  };
}

/**
 * Stable lane/slot layout. A change in one lane can reflow only that lane;
 * lane positions themselves come from the closed provider×role taxonomy, not
 * from which lanes happen to be present in a particular revision.
 */
export function layoutAtlas(model: AtlasModel): AtlasLayout {
  const points: AtlasPoint[] = [];
  const routableByLane = new Map<number, Extract<AtlasSubject, { routability: "routable" }>[]>() ;
  const nonRoutable: Extract<AtlasSubject, { routability: "non_routable" }>[] = [];
  for (const subject of model.subjects) {
    if (subject.routability === "routable") {
      const lane = laneOrdinal(subject);
      const entries = routableByLane.get(lane) ?? [];
      entries.push(subject);
      routableByLane.set(lane, entries);
    } else nonRoutable.push(subject);
  }
  for (const [, subjects] of [...routableByLane].sort(([a], [b]) => a - b)) {
    subjects.sort((left, right) => compareText(left.key, right.key));
    subjects.forEach((subject, index) => points.push(pointForRoutable(subject, index)));
  }
  nonRoutable.sort((left, right) => compareText(left.key, right.key));
  nonRoutable.forEach((subject, index) => points.push({
    subject: subject.key, x: ATLAS_LAYOUT.diagnosticX,
    y: ATLAS_LAYOUT.diagnosticY + index * (ATLAS_LAYOUT.cardHeight + ATLAS_LAYOUT.rowGap),
    width: ATLAS_LAYOUT.cardWidth, height: ATLAS_LAYOUT.cardHeight
  }));
  return { policyVersion: ATLAS_LAYOUT.policyVersion, points: points.sort((left, right) => compareText(left.subject, right.subject)) };
}

export function pointFor(layout: AtlasLayout, subject: AtlasKey | string): AtlasPoint | undefined {
  return layout.points.find((point) => point.subject === subject);
}

/** Camera is caller-owned interaction state and is never recalculated by layout. */
export function preserveCamera(camera: AtlasCamera): AtlasCamera {
  return { ...camera };
}

/** One deterministic initial framing for a new Atlas entry, never a refresh fit. */
export function initialAtlasCamera(): AtlasCamera {
  return { ...ATLAS_CAMERA_POLICY.initial };
}

/** Explicit focus operation: bounded, deterministic and independent of topology revision. */
export function focusCamera(camera: AtlasCamera, point: AtlasPoint, viewport: { width: number; height: number }): AtlasCamera {
  const zoom = Number.isFinite(camera.zoom) && camera.zoom > 0 ? camera.zoom : 1;
  const targetX = viewport.width / 2 - (point.x + point.width / 2) * zoom;
  const targetY = viewport.height / 2 - (point.y + point.height / 2) * zoom;
  const bound = ATLAS_LAYOUT.maxFocusTranslation;
  return {
    zoom,
    x: Math.max(-bound, Math.min(bound, targetX)),
    y: Math.max(-bound, Math.min(bound, targetY))
  };
}

export function rectanglesOverlap(left: AtlasPoint, right: AtlasPoint): boolean {
  return left.x < right.x + right.width && left.x + left.width > right.x &&
    left.y < right.y + right.height && left.y + left.height > right.y;
}

export function layoutJson(layout: AtlasLayout): string {
  return JSON.stringify(layout);
}
