import { selectedSubject } from "./project";
import { ATLAS_DEFAULT_LENS, isAtlasLens, type AtlasSupportedLens } from "./lens";
import { ATLAS_OVERVIEW_ENABLED } from "./feature";
import type { AtlasDerivedKey, AtlasEnvelope, AtlasKey, AtlasModel } from "./types";

/** Atlas has one deliberately closed, orientation-only lens in V1. */
export const ATLAS_ROUTE_LENS = ATLAS_DEFAULT_LENS;
export type AtlasRouteLens = AtlasSupportedLens;
export type AtlasFocusTarget = "directory" | "subject" | "aggregate" | "group";

export interface AtlasRouteState {
  lens: AtlasRouteLens;
  selectedKey: AtlasKey | null;
  expandedKey: AtlasDerivedKey | null;
  /** Semantic target only; it is derived from model-valid route state, never URL text. */
  focusTarget: AtlasFocusTarget;
}

export interface AtlasRouteParseResult {
  state: AtlasRouteState;
  /** A rejected subject is the only route datum which triggers focus recovery. */
  rejectedSubject: boolean;
  rejectedExpansion: boolean;
  rejectedLens: boolean;
}

export interface AtlasRouteIntent {
  lens?: AtlasRouteLens;
  selectedKey?: string | null;
  expandedKey?: string | null;
}

const MAX_SEARCH_LENGTH = 768;
const MAX_PARAMETERS = 3;
const MAX_OVERSIZE_SCAN_CHARACTERS = 4096;
const MAX_OVERSIZE_SCAN_PARAMETERS = 32;
const SAFE_KEY = /^[A-Za-z0-9_.:-]+$/;
const SAFE_KEY_LENGTH = 360;
const DEFAULT_STATE: AtlasRouteState = { lens: ATLAS_ROUTE_LENS, selectedKey: null, expandedKey: null, focusTarget: "directory" };

function safeKey(value: string | null): string | null {
  if (!value || value.length > SAFE_KEY_LENGTH || !SAFE_KEY.test(value)) return null;
  return value;
}

function actualExpansion(model: AtlasModel, value: string | null): { key: AtlasDerivedKey; focusTarget: "aggregate" | "group" } | null {
  const key = safeKey(value);
  if (!key) return null;
  const aggregate = model.aggregates.find((entry) => entry.key === key);
  if (aggregate) return { key: aggregate.key, focusTarget: "aggregate" };
  const group = model.groups.find((entry) => entry.key === key);
  return group ? { key: group.key, focusTarget: "group" } : null;
}

function focusTarget(selectedKey: AtlasKey | null, expansion: { key: AtlasDerivedKey; focusTarget: "aggregate" | "group" } | null): AtlasFocusTarget {
  if (expansion) return expansion.focusTarget;
  return selectedKey ? "subject" : "directory";
}

function hasExactParameter(search: string, name: string): boolean {
  // Oversized URLs are never parsed into route state. We still inspect a
  // small, fixed prefix of parameter tokens so a real subject field after
  // more than the normal three fields receives the same safe recovery.
  const bounded = search.slice(0, MAX_OVERSIZE_SCAN_CHARACTERS).replace(/^\?/, "");
  return bounded.split("&", MAX_OVERSIZE_SCAN_PARAMETERS).some((part) => {
    const equals = part.indexOf("=");
    const rawKey = equals === -1 ? part : part.slice(0, equals);
    try { return decodeURIComponent(rawKey.replaceAll("+", " ")) === name; } catch { return false; }
  });
}

function actualSelection(model: AtlasModel, value: string | null): AtlasKey | null {
  const key = safeKey(value);
  return key ? selectedSubject(model, key)?.key ?? null : null;
}

function encodedSearch(state: AtlasRouteState): string {
  const params = new URLSearchParams();
  if (state.lens !== ATLAS_ROUTE_LENS) params.set("lens", state.lens);
  if (state.selectedKey) params.set("subject", state.selectedKey);
  if (state.expandedKey) params.set("expand", state.expandedKey);
  const value = params.toString();
  return value ? `?${value}` : "";
}

/**
 * Parses only a small closed query vocabulary. Values are accepted only when
 * they name actual, safe Atlas semantic entries in this exact model.
 */
export function parseAtlasSearch(search: string, model: AtlasModel): AtlasRouteParseResult {
  if (search.length > MAX_SEARCH_LENGTH) {
    return { state: DEFAULT_STATE, rejectedSubject: hasExactParameter(search, "subject"), rejectedExpansion: hasExactParameter(search, "expand"), rejectedLens: hasExactParameter(search, "lens") };
  }
  const params = new URLSearchParams(search);
  if ([...params.keys()].length > MAX_PARAMETERS) {
    return { state: DEFAULT_STATE, rejectedSubject: params.has("subject"), rejectedExpansion: params.has("expand"), rejectedLens: params.has("lens") };
  }

  const names = new Set(["lens", "subject", "expand"]);
  const unknown = [...params.keys()].some((key) => !names.has(key));
  // Atlas state is an atomic, closed vocabulary. An unknown field (including
  // camera-like x/y/zoom) invalidates every route datum rather than allowing a
  // known subject to survive beside unreviewed state.
  if (unknown) {
    return {
      state: DEFAULT_STATE,
      rejectedLens: true,
      rejectedSubject: params.has("subject"),
      rejectedExpansion: params.has("expand")
    };
  }
  const values = (name: string) => params.getAll(name);
  const lensValues = values("lens");
  const subjectValues = values("subject");
  const expansionValues = values("expand");
  const requestedLens = lensValues.length === 0 ? ATLAS_ROUTE_LENS : lensValues[0];
  const lensValid = lensValues.length <= 1 && !!requestedLens && isAtlasLens(requestedLens);
  if (!lensValid) return {
    state: DEFAULT_STATE,
    rejectedLens: true,
    rejectedSubject: subjectValues.length > 0,
    rejectedExpansion: expansionValues.length > 0
  };
  const selectedKey = subjectValues.length === 1 ? actualSelection(model, subjectValues[0]!) : null;
  const expansion = expansionValues.length === 1 ? actualExpansion(model, expansionValues[0]!) : null;
  const expandedKey = expansion?.key ?? null;

  return {
    state: { lens: requestedLens, selectedKey, expandedKey, focusTarget: focusTarget(selectedKey, expansion) },
    rejectedLens: false,
    rejectedSubject: subjectValues.length > 1 || (subjectValues.length === 1 && !selectedKey),
    rejectedExpansion: expansionValues.length > 1 || (expansionValues.length === 1 && !expandedKey)
  };
}

/** Canonical, model-validated query serialization with default omission. */
export function serializeAtlasState(model: AtlasModel, intent: AtlasRouteIntent = {}): string {
  const selectedKey = actualSelection(model, intent.selectedKey ?? null);
  const expansion = actualExpansion(model, intent.expandedKey ?? null);
  return encodedSearch({
    lens: intent.lens && isAtlasLens(intent.lens) ? intent.lens : ATLAS_ROUTE_LENS,
    selectedKey,
    expandedKey: expansion?.key ?? null,
    focusTarget: focusTarget(selectedKey, expansion)
  });
}

/** Builds a same-screen route without admitting labels, evidence, occurrence, or camera coordinates. */
export function atlasHref(model: AtlasModel, intent: AtlasRouteIntent = {}): string {
  return `/atlas${serializeAtlasState(model, intent)}`;
}

export function atlasRouteState(model: AtlasModel, intent: AtlasRouteIntent = {}): AtlasRouteState {
  const search = serializeAtlasState(model, intent);
  return parseAtlasSearch(search, model).state;
}

/**
 * A cross-screen handoff is permitted only when an exact published runtime
 * node id names a current, routable Atlas subject. Labels and metadata never
 * participate in this lookup.
 */
export function atlasSubjectHref(atlas: AtlasEnvelope | null | undefined, runtimeNodeId: string): string | null {
  // App registers /atlas under this exact build-time gate. A handoff must not
  // create a route to an intentionally absent screen in the default artifact.
  if (!ATLAS_OVERVIEW_ENABLED) return null;
  if (!atlas) return null;
  const subject = atlas.model.subjects.find((entry) => entry.routability === "routable" && entry.source.kind === "runtime_node" && entry.source.nodeId === runtimeNodeId);
  return subject ? atlasHref(atlas.model, { selectedKey: subject.key }) : null;
}
