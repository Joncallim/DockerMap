import type { ProviderState } from "@dockermap/contracts";

/** Complete fixed-slot state used by browser-only fixtures. */
export const testProviderStates: [ProviderState, ProviderState, ProviderState, ProviderState, ProviderState] = [
  { slot: "network_infrastructure", state: "unavailable" },
  { slot: "host_scoped", state: "unavailable" },
  { slot: "python_processes", state: "unavailable" },
  { slot: "native_processes", state: "unavailable" },
  { slot: "project_npm", state: "unavailable" }
];
