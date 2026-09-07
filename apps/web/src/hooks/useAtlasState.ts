import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { atlasHref, atlasRouteState, parseAtlasSearch, serializeAtlasState, type AtlasFocusTarget, type AtlasRouteIntent, type AtlasRouteLens } from "../lib/atlas/interaction";
import { selectedSubject } from "../lib/atlas/project";
import type { AtlasDerivedKey, AtlasKey, AtlasModel } from "../lib/atlas/types";

export type AtlasSelectionStatus = "selection_unavailable" | null;

export interface AtlasState {
  lens: AtlasRouteLens;
  selectedKey: AtlasKey | null;
  selected: ReturnType<typeof selectedSubject>;
  expandedKey: AtlasDerivedKey | null;
  focusTarget: AtlasFocusTarget;
  selectionStatus: AtlasSelectionStatus;
  focusRecoveryToken: number;
  select: (key: AtlasKey | null) => void;
  expand: (key: AtlasDerivedKey | null) => void;
  setLens: (lens: AtlasRouteLens) => void;
  href: (intent: AtlasRouteIntent) => string;
}

/**
 * Sole authority for Atlas URL state. It deliberately owns browser history,
 * revision reconciliation, and focus recovery, but never camera state.
 */
export function useAtlasState(model: AtlasModel | null, sourceRevision: string | null = null): AtlasState {
  const location = useLocation();
  const navigate = useNavigate();
  const [selectionStatus, setSelectionStatus] = useState<AtlasSelectionStatus>(null);
  const [focusRecoveryToken, setFocusRecoveryToken] = useState(0);
  const reconciliationRef = useRef<string | null>(null);
  const preserveRecoveredStatusRef = useRef(false);

  const parsed = useMemo(() => model ? parseAtlasSearch(location.search, model) : null, [location.search, model]);
  const state = parsed?.state ?? atlasRouteStateForAbsentModel();
  const selected = model ? selectedSubject(model, state.selectedKey) : null;

  useEffect(() => {
    if (!model || !parsed) return;
    const canonical = serializeAtlasState(model, parsed.state);
    if (canonical === location.search) {
      reconciliationRef.current = null;
      if (preserveRecoveredStatusRef.current) preserveRecoveredStatusRef.current = false;
      else setSelectionStatus(null);
      return;
    }
    const marker = `${sourceRevision ?? "unknown"}:${location.key}:${location.search}`;
    if (reconciliationRef.current === marker) return;
    reconciliationRef.current = marker;
    if (parsed.rejectedSubject) {
      setSelectionStatus("selection_unavailable");
      setFocusRecoveryToken((token) => token + 1);
      preserveRecoveredStatusRef.current = true;
    }
    // Reconciliation is not a user navigation: preserve back/forward history.
    navigate({ pathname: location.pathname, search: canonical }, { replace: true });
  }, [location.key, location.pathname, location.search, model, navigate, parsed, sourceRevision]);

  const update = useCallback((intent: AtlasRouteIntent) => {
    if (!model) return;
    setSelectionStatus(null);
    const next = serializeAtlasState(model, { ...state, ...intent });
    if (next !== location.search) navigate({ pathname: location.pathname, search: next });
  }, [location.pathname, location.search, model, navigate, state]);

  return {
    lens: state.lens,
    selectedKey: state.selectedKey,
    selected,
    expandedKey: state.expandedKey,
    focusTarget: state.focusTarget,
    selectionStatus,
    focusRecoveryToken,
    select: (key) => update({ selectedKey: key }),
    expand: (key) => update({ expandedKey: key }),
    setLens: (lens) => update({ lens }),
    href: (intent) => model ? atlasHref(model, { ...state, ...intent }) : "/atlas"
  };
}

function atlasRouteStateForAbsentModel() {
  return { lens: "overview" as const, selectedKey: null, expandedKey: null, focusTarget: "directory" as const };
}
