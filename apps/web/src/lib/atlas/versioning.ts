import { ATLAS_LAYOUT } from "./layout";
import { ATLAS_LOCAL_CONTEXT_POLICY } from "./localContext";
import { ATLAS_RENDERER_POLICY } from "./renderers/policy";
import { ATLAS_CAPS, ATLAS_PROJECTION_VERSION, type AtlasLens } from "./types";

/**
 * Atlas policy versions are internal regression/change-control authorities.
 * They are deliberately not daemon/API versions and must not be put in an API
 * response without a separately approved compatibility decision.
 */
export const ATLAS_POLICY_VERSIONS = {
  projection: `atlas-v${ATLAS_PROJECTION_VERSION}/projection-1`,
  layout: ATLAS_LAYOUT.policyVersion,
  visual: "atlas-v1/visual-grammar-1",
  renderer: ATLAS_RENDERER_POLICY.version
} as const;

/** No third-party graph/layout engine is selected for Atlas V1. */
export const ATLAS_LAYOUT_DEPENDENCY_POLICY = {
  kind: "none",
  packageName: null,
  packageVersion: null
} as const;

/**
 * A manifest golden binds every exact Atlas artifact to the policy values that
 * produced it. It is intentionally separate from the product/API version.
 */
export const ATLAS_GOLDEN_MANIFEST = {
  schemaVersion: 1,
  policyVersions: ATLAS_POLICY_VERSIONS,
  artifacts: {
    semantic: {
      fixture: "two-container",
      file: "two-container-semantic.json",
      projection: ATLAS_POLICY_VERSIONS.projection
    },
    layout: {
      fixture: "two-container",
      file: "two-container-layout.json",
      layout: ATLAS_POLICY_VERSIONS.layout
    },
    localAttachment: {
      fixture: "two-container",
      file: "local-attachment-policy.json",
      policy: ATLAS_LOCAL_CONTEXT_POLICY.version,
      projection: ATLAS_POLICY_VERSIONS.projection,
      visual: ATLAS_POLICY_VERSIONS.visual
    }
  }
} as const;

export const ATLAS_SEMANTIC_STATE_SCHEMA_VERSION = 1 as const;

export interface AtlasSemanticState {
  readonly lens: AtlasLens;
  readonly selectedKey: string | null;
}

interface StoredAtlasSemanticState extends AtlasSemanticState {
  readonly schemaVersion: typeof ATLAS_SEMANTIC_STATE_SCHEMA_VERSION;
  readonly policyVersions: Pick<typeof ATLAS_POLICY_VERSIONS, "projection" | "layout" | "visual">;
}

export interface RestoredAtlasSemanticState extends AtlasSemanticState {
  /** True when untrusted/obsolete state was discarded rather than revived. */
  readonly degraded: boolean;
}

const LENSES: readonly AtlasLens[] = ["overview", "connectivity", "dependencies", "storage", "runtime", "attention"];

const DEFAULT_STATE: RestoredAtlasSemanticState = { lens: "overview", selectedKey: null, degraded: false };

function isLens(value: unknown): value is AtlasLens {
  return typeof value === "string" && LENSES.includes(value as AtlasLens);
}

function isSelectedKey(value: unknown): value is string | null {
  if (value === null) return true;
  // This is an opaque subject-key syntax boundary, not a lookup or identity
  // claim. Exact routability/collision validity remains a coherent-model check
  // at route time. Keeping the prefix family closed prevents paths, labels,
  // evidence IDs, and arbitrary prose from becoming durable browser state.
  return typeof value === "string" && value.length > 0 && value.length <= ATLAS_CAPS.rawRoutingIdLength &&
    /^(?:docker_container_|docker_network_|docker_volume_|network_listener_|host_|host_risk_|systemd_service_|scheduled_job_|npm_project_|npm_package_|pm2_app_|tmux_session_|tailscale_node_|headscale_node_|cloudflare_|caddy_|reverse_proxy_|local_dns_|dns_provider_|external_api_|python_process_|native_process_|process_|kubernetes_|other_)[A-Za-z0-9_.-]{1,160}$/.test(value);
}

function hasCurrentPolicyVersions(value: unknown): value is StoredAtlasSemanticState["policyVersions"] {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.projection === ATLAS_POLICY_VERSIONS.projection &&
    candidate.layout === ATLAS_POLICY_VERSIONS.layout &&
    candidate.visual === ATLAS_POLICY_VERSIONS.visual;
}

/**
 * Serializes only semantic navigation state. Camera coordinates, zoom,
 * viewport, DOM geometry, and renderer internals have no persistence or share
 * contract because they are policy-dependent presentation details.
 */
export function serializeAtlasSemanticState(state: AtlasSemanticState): StoredAtlasSemanticState {
  return {
    schemaVersion: ATLAS_SEMANTIC_STATE_SCHEMA_VERSION,
    policyVersions: {
      projection: ATLAS_POLICY_VERSIONS.projection,
      layout: ATLAS_POLICY_VERSIONS.layout,
      visual: ATLAS_POLICY_VERSIONS.visual
    },
    lens: isLens(state.lens) ? state.lens : DEFAULT_STATE.lens,
    selectedKey: isSelectedKey(state.selectedKey) ? state.selectedKey : null
  };
}

/**
 * Restores a same-policy semantic state only. A schema or policy mismatch,
 * malformed input, or oversized selected identity falls back to orientation
 * with no selection; callers must not attempt a best-effort coordinate map.
 */
export function restoreAtlasSemanticState(value: unknown): RestoredAtlasSemanticState {
  if (!value || typeof value !== "object") return { ...DEFAULT_STATE, degraded: true };
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== ATLAS_SEMANTIC_STATE_SCHEMA_VERSION || !hasCurrentPolicyVersions(candidate.policyVersions) || !isLens(candidate.lens) || !isSelectedKey(candidate.selectedKey)) {
    return { ...DEFAULT_STATE, degraded: true };
  }
  return { lens: candidate.lens, selectedKey: candidate.selectedKey, degraded: false };
}
