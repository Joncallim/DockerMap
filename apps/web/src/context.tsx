import { createContext, useContext } from "react";
import type { FindingsResponse, HealthResponse, ObservedChangeHistoryResponse, ObservedResourceTelemetryResponse } from "@dockermap/contracts";
import type { SystemModel } from "./lib/model";
import type { EvidenceMode, ModelProvenance } from "./lib/evidence";

export interface AppContextValue {
  model: SystemModel | null;
  /** Where the current model's bytes came from — travels WITH the model (§9). */
  modelProvenance: ModelProvenance | null;
  loading: boolean;
  error: string | null;
  health: HealthResponse | null;
  /** Findings are published only when they attest the current live model revision. */
  findings?: FindingsResponse | null;
  /** Raw bounded inventory observations; screens must still prove source/revision coherence. */
  observedHistory?: ObservedChangeHistoryResponse | null;
  /** Current-only Docker telemetry; renderers must prove source/revision/freshness per value. */
  resourceTelemetry?: ObservedResourceTelemetryResponse | null;
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
