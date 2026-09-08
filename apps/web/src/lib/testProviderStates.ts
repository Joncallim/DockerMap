import type { ProviderSlot, ProviderState } from "@dockermap/contracts";

function unavailableProviderState(slot: ProviderSlot): ProviderState {
  return {
    slot, state: "unavailable", lastAttemptMs: null, lastSuccessMs: null,
    lastDurationMs: null, consecutiveFailureCount: 0, dataRevision: null, statusReason: "initial"
  };
}

/** Complete fixed-slot state used by browser-only fixtures. */
export const testProviderStates: [ProviderState, ProviderState, ProviderState, ProviderState, ProviderState, ProviderState, ProviderState] = [
  unavailableProviderState("network_infrastructure"), unavailableProviderState("host_scoped"),
  unavailableProviderState("cron"),
  unavailableProviderState("systemd"),
  unavailableProviderState("python_processes"), unavailableProviderState("native_processes"),
  unavailableProviderState("project_npm")
];
