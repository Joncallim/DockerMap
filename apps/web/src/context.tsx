import { createContext, useContext } from "react";
import type { HealthResponse } from "@dockermap/contracts";
import type { SystemModel } from "./lib/model";

export interface AppContextValue {
  model: SystemModel | null;
  loading: boolean;
  error: string | null;
  health: HealthResponse | null;
  tick: number;
  openCommand: () => void;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used within AppShell");
  return value;
}
