/** Evidence-kind vocabulary for live user-facing claims; richer provenance lands in epic #68. */
import type { RuntimeMode } from "@dockermap/contracts";

/** What one user-facing claim is worth. Five values, fixed by #71. */
export type EvidenceKind = "observed" | "derived" | "inferred" | "demo" | "unavailable";

export const EVIDENCE_KINDS: readonly EvidenceKind[] =
  ["observed", "derived", "inferred", "demo", "unavailable"] as const;

export interface EvidenceLabel {
  kind: EvidenceKind;
  label: string;
  description: string;
}

const EVIDENCE_LABELS: Record<EvidenceKind, EvidenceLabel> = {
  observed: { kind: "observed", label: "Observed", description: "Read directly from this host" },
  derived: { kind: "derived", label: "Derived", description: "Calculated from data read from this host" },
  inferred: { kind: "inferred", label: "Inferred", description: "A heuristic guess, not measured" },
  demo: { kind: "demo", label: "Sample data", description: "Sample data — not from a host" },
  unavailable: { kind: "unavailable", label: "Not collected", description: "DockerMap does not collect this yet" }
};

/** Return the display label and description for a kind. Throws for unknown kinds. */
export function evidenceLabel(kind: EvidenceKind): EvidenceLabel {
  const label = EVIDENCE_LABELS[kind];
  if (!label) throw new Error(`Unknown evidence kind: ${kind}`);
  return label;
}

/** Where the bytes came from. Three values, exhaustive. */
export type EvidenceMode = "live" | "mock" | "demo";

export interface EvidenceModeInput {
  /** settings.demoMode — the client short-circuit at utils/api.ts:30. */
  demoMode: boolean;
  /** health?.mode ?? null — null while the heartbeat has not reported yet. */
  healthMode: RuntimeMode | null;
}

/**
 * Resolve the current evidence mode from explicit inputs.
 *
 * demoMode is checked FIRST because demoData.ts:176 sets health.mode to "mock"
 * in demo mode; health.dockerReachable is NOT trustworthy (demoData.ts:177).
 * Returns null when the authority has not been established yet.
 */
export function resolveEvidenceMode(input: EvidenceModeInput): EvidenceMode | null {
  if (input.demoMode) return "demo";
  if (input.healthMode === "docker") return "live";
  if (input.healthMode === "mock") return "mock";
  return null;
}

/** Authority level implied by the current mode. */
export type ClaimAuthority = "host" | "sample" | "none";

/** Authority permitted by the current mode. */
export function claimAuthority(mode: EvidenceMode | null): ClaimAuthority {
  if (mode === "live") return "host";
  if (mode === "demo" || mode === "mock") return "sample";
  return "none";
}

/** A user-facing claim tagged with its evidence kind. */
export type Claim<T> =
  | { kind: "observed" | "derived" | "inferred" | "demo"; value: T }
  | { kind: "unavailable"; value: null; detail: string };

function nonEmptyDetail(detail: string): string {
  if (typeof detail !== "string" || detail.trim().length === 0) {
    throw new Error("unavailable(detail) requires a non-empty string reason");
  }
  return detail;
}

export function observed<T>(value: T): Claim<T> {
  return { kind: "observed", value };
}

export function derived<T>(value: T): Claim<T> {
  return { kind: "derived", value };
}

export function inferred<T>(value: T): Claim<T> {
  return { kind: "inferred", value };
}

/** demo kind; named to avoid conflation with demo MODE. */
export function demoSample<T>(value: T): Claim<T> {
  return { kind: "demo", value };
}

export function unavailable(detail: string): Claim<never> {
  return { kind: "unavailable", value: null, detail: nonEmptyDetail(detail) };
}
