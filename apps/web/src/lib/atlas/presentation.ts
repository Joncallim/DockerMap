import type { AtlasAmbiguity, AtlasAttention, AtlasFreshness, AtlasOperationalState, AtlasSubject } from "./types";

/**
 * Presentation is a four-channel tuple. No channel derives, overwrites, or
 * recolours another: an attention Finding is not health, stale collection is
 * not an unhealthy subject, and ambiguity is not a runtime failure.
 */
export const ATLAS_PRESENTATION_POLICY = {
  version: "atlas-v1/orthogonal-presentation-1",
  compactSummaryPrecedence: ["attention", "ambiguity", "operational_state", "freshness"] as const,
  unavailableFreshnessLabel: "unavailable observation",
  unknownFreshnessLabel: "unknown freshness"
} as const;

export interface AtlasPresentationChannels {
  attention: AtlasAttention;
  ambiguity: AtlasAmbiguity;
  operationalState: AtlasOperationalState;
  freshness: AtlasFreshness;
}

export interface AtlasPresentationMarker {
  channel: "attention" | "ambiguity" | "operational_state" | "freshness";
  glyph: string;
  label: string;
  className: string;
}

const ATTENTION: Record<AtlasAttention, Omit<AtlasPresentationMarker, "channel"> | null> = {
  none: null,
  advisory: { glyph: "△", label: "advisory attention", className: "attention-advisory" },
  warning: { glyph: "▲", label: "warning attention", className: "attention-warning" }
};
const AMBIGUITY: Record<AtlasAmbiguity, Omit<AtlasPresentationMarker, "channel"> | null> = {
  none: null,
  collision: { glyph: "◇", label: "ambiguous collision", className: "ambiguity-collision" },
  unresolved: { glyph: "◇", label: "unresolved identity", className: "ambiguity-unresolved" },
  unsupported: { glyph: "◇", label: "unsupported identity", className: "ambiguity-unsupported" }
};
const OPERATIONAL: Record<AtlasOperationalState, Omit<AtlasPresentationMarker, "channel">> = {
  healthy: { glyph: "✓", label: "healthy", className: "state-healthy" },
  warning: { glyph: "◯", label: "warning state", className: "state-warning" },
  degraded: { glyph: "◆", label: "degraded", className: "state-degraded" },
  offline: { glyph: "■", label: "offline", className: "state-offline" },
  updating: { glyph: "◌", label: "updating", className: "state-updating" },
  unknown: { glyph: "?", label: "unknown state", className: "state-unknown" }
};
const FRESHNESS: Record<AtlasFreshness, Omit<AtlasPresentationMarker, "channel">> = {
  fresh: { glyph: "◷", label: "fresh observation", className: "fresh-fresh" },
  stale: { glyph: "◴", label: "stale observation", className: "fresh-stale" },
  timed_out: { glyph: "⌛", label: "timed out observation", className: "fresh-timed_out" },
  unavailable: { glyph: "⊘", label: ATLAS_PRESENTATION_POLICY.unavailableFreshnessLabel, className: "fresh-unavailable" },
  disabled: { glyph: "−", label: "disabled observation", className: "fresh-disabled" },
  unknown: { glyph: "?", label: ATLAS_PRESENTATION_POLICY.unknownFreshnessLabel, className: "fresh-unknown" }
};

function marker(channel: AtlasPresentationMarker["channel"], value: Omit<AtlasPresentationMarker, "channel">): AtlasPresentationMarker {
  return { channel, ...value };
}

export function presentationMarkers(channels: AtlasPresentationChannels): readonly AtlasPresentationMarker[] {
  const attention = ATTENTION[channels.attention];
  const ambiguity = AMBIGUITY[channels.ambiguity];
  return [
    ...(attention ? [marker("attention", attention)] : []),
    ...(ambiguity ? [marker("ambiguity", ambiguity)] : []),
    marker("operational_state", OPERATIONAL[channels.operationalState]),
    marker("freshness", FRESHNESS[channels.freshness])
  ];
}

export function presentationText(display: string, channels: AtlasPresentationChannels): string {
  const attention = ATTENTION[channels.attention]?.label ?? "no attention";
  const ambiguity = AMBIGUITY[channels.ambiguity]?.label ?? "unambiguous identity";
  return `${display}, ${attention}, ${ambiguity}, ${OPERATIONAL[channels.operationalState].label}, ${FRESHNESS[channels.freshness].label}`;
}

/** Compact summaries order cues for scanability but retain every present channel. */
export function compactPresentationText(channels: AtlasPresentationChannels): string {
  return presentationMarkers(channels).map((entry) => entry.label).join(" · ");
}

export function subjectPresentationText(subject: AtlasSubject): string {
  return presentationText(subject.display, subject);
}
