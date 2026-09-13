import { createContext, useContext } from "react";
import type { FindingsResponse, HealthResponse, ObservedChangeHistoryResponse } from "@dockermap/contracts";
import type { SystemModel } from "./lib/model";
import type { AtlasEnvelope } from "./lib/atlas/types";
import type { EvidenceMode, ModelProvenance } from "./lib/evidence";

export interface AppContextValue {
  model: SystemModel | null;
  /** A coherent, route-ready Atlas publication; raw topology is never exposed here. */
  atlas?: AtlasEnvelope | null;
  /** Where the current model's bytes came from — travels WITH the model (§9). */
  modelProvenance: ModelProvenance | null;
  loading: boolean;
  error: string | null;
  health: HealthResponse | null;
  /** Findings are published only when they attest the current live model revision. */
  findings?: FindingsResponse | null;
  /** Bounded snapshot deltas; consumers must independently prove model/source coherence. */
  observedHistory?: ObservedChangeHistoryResponse | null;
  tick: number;
  evidenceMode: EvidenceMode | null;
  openCommand: () => void;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used within AppShell");
  return value;
}
