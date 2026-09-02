import type { Finding } from "@dockermap/contracts";

/**
 * Findings cross the browser boundary as untrusted JSON.  The API owns the
 * complete collision-resistant identity check; the UI deliberately treats
 * that opaque identifier, references, evidence metadata, and provider text as
 * non-displayable.  This second, small guard only admits the closed shapes the
 * screen can describe without turning a finding into a metadata viewer.
 */
export interface FindingPresentation {
  title: string;
  summary: string;
  category: string;
  hint: string;
  recommendation: string;
  tone: "warn" | "muted";
  severityLabel: "Warning" | "Advisory";
  inspectChanges?: boolean;
}

type FindingSpec = FindingPresentation & {
  ruleId: Finding["ruleId"];
  severity: Finding["severity"];
  summary: string;
  idPrefix: string;
  subjectPrefix: string;
  targetPrefix?: string;
  targetRef?: string;
  evidenceCount: number;
  evidence: {
    version: number;
    provider: string;
    kind: string;
    assertionKind: string;
    providerSlot?: string | null;
  };
};

const SPECS: readonly FindingSpec[] = [
  {
    ruleId: "systemd.requires_target_not_active", severity: "warning",
    summary: "An active systemd service requires a target that is inactive or failed",
    recommendation: "Inspect the target service state and its declared dependency configuration.",
    idPrefix: "finding_systemd_requires_target_not_active_", subjectPrefix: "systemd_service_", targetPrefix: "systemd_service_",
    evidenceCount: 1, evidence: { version: 2, provider: "systemd", kind: "systemd_requires", assertionKind: "declared", providerSlot: "systemd" },
    title: "Declared dependency needs review", category: "Systemd Requires", hint: "Observed declaration", tone: "warn", severityLabel: "Warning"
  },
  {
    ruleId: "docker.internal_network_member_publishes_port", severity: "advisory",
    summary: "A container on an internal Docker network also has a published host port.",
    recommendation: "Review whether the host-port publication is intended for this internal-network service.",
    idPrefix: "finding_docker_internal_network_member_publishes_port_", subjectPrefix: "docker_container_", targetPrefix: "docker_network_",
    evidenceCount: 2, evidence: { version: 1, provider: "docker", kind: "docker_network_membership", assertionKind: "observed", providerSlot: null },
    title: "Internal-network port publication needs review", category: "Internal network + host port", hint: "Observed Docker facts", tone: "muted", severityLabel: "Advisory"
  },
  {
    ruleId: "docker.daemon_state_bind_mount", severity: "warning",
    summary: "A container has Docker daemon state access that may provide Docker daemon API authority.",
    recommendation: "Review whether this container requires Docker daemon API authority.",
    idPrefix: "finding_docker_daemon_state_bind_mount_", subjectPrefix: "docker_container_", targetRef: "host_risk_docker_daemon_state",
    evidenceCount: 1, evidence: { version: 1, provider: "docker", kind: "docker_daemon_state_bind_mount", assertionKind: "observed", providerSlot: null },
    title: "Docker daemon-state access needs review", category: "Docker daemon state", hint: "Observed Docker fact", tone: "warn", severityLabel: "Warning"
  },
  {
    ruleId: "docker.daemon_state_bind_mount_publishes_port", severity: "warning",
    summary: "A container with Docker daemon state access also has a published host port.",
    recommendation: "Review whether the daemon-state access and host-port publication are both intended.",
    idPrefix: "finding_docker_daemon_state_bind_mount_publishes_port_", subjectPrefix: "docker_container_", targetRef: "host_risk_docker_daemon_state",
    evidenceCount: 2, evidence: { version: 1, provider: "docker", kind: "docker_daemon_state_bind_mount", assertionKind: "observed", providerSlot: null },
    title: "Docker daemon-state and host-port publication need review", category: "Docker daemon state + host port", hint: "Observed Docker facts", tone: "warn", severityLabel: "Warning", inspectChanges: true
  },
  {
    ruleId: "docker.compose_declared_target_not_active", severity: "advisory",
    summary: "A running Docker Compose service declares a dependency whose container is not active.",
    recommendation: "Review the declared dependency and the target container state.",
    idPrefix: "finding_docker_compose_declared_target_not_active_", subjectPrefix: "docker_container_", targetPrefix: "docker_container_",
    evidenceCount: 1, evidence: { version: 1, provider: "docker", kind: "docker_compose_depends_on", assertionKind: "observed", providerSlot: null },
    title: "Declared Compose dependency needs review", category: "Docker Compose", hint: "Observed Compose declaration", tone: "muted", severityLabel: "Advisory", inspectChanges: true
  }
];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Return static presentation only for a fully bounded supported finding. */
export function presentationForFinding(value: unknown): FindingPresentation | null {
  const finding = record(value);
  if (!finding) return null;
  const spec = SPECS.find((candidate) => candidate.ruleId === finding.ruleId);
  if (!spec
    || finding.severity !== spec.severity
    || finding.summary !== spec.summary
    || finding.recommendation !== spec.recommendation
    || typeof finding.id !== "string" || !finding.id.startsWith(spec.idPrefix)
    || typeof finding.subjectRef !== "string" || !finding.subjectRef.startsWith(spec.subjectPrefix)
    || typeof finding.targetRef !== "string"
    || (spec.targetPrefix !== undefined && !finding.targetRef.startsWith(spec.targetPrefix))
    || (spec.targetRef !== undefined && finding.targetRef !== spec.targetRef)
    || finding.subjectRef === finding.targetRef
    || !Array.isArray(finding.evidenceRefs) || finding.evidenceRefs.length !== spec.evidenceCount) return null;

  const evidence = record(finding.evidenceRefs[0]);
  if (!evidence
    || evidence.version !== spec.evidence.version
    || evidence.provider !== spec.evidence.provider
    || evidence.kind !== spec.evidence.kind
    || evidence.assertionKind !== spec.evidence.assertionKind
    // The API permits the Compose observation's legacy absent slot as well as
    // null. Both mean the Docker-wide collector, never a provider-supplied
    // slot name; all other supported shapes require their exact slot value.
    || ((spec.ruleId === "docker.compose_declared_target_not_active" || spec.ruleId === "docker.daemon_state_bind_mount_publishes_port")
      ? evidence.providerSlot !== undefined && evidence.providerSlot !== null
      : evidence.providerSlot !== spec.evidence.providerSlot)
    || evidence.freshness !== "fresh"
    || evidence.subjectRef !== finding.subjectRef) return null;

  // The two-fact internal-network condition has a fixed complementary port
  // fact. No evidence field is rendered, but its shape is still fail-closed.
  if (spec.ruleId === "docker.internal_network_member_publishes_port") {
    const port = record(finding.evidenceRefs[1]);
    if (!port || port.version !== 1 || port.provider !== "docker" || port.kind !== "docker_port_publication"
      || port.assertionKind !== "observed" || port.providerSlot !== null || port.freshness !== "fresh"
      || port.subjectRef !== finding.subjectRef) return null;
  }

  // The daemon-state + host-port advisory is a paired observation from one
  // Docker collection. The UI never renders either fact's values, but it must
  // not present the static warning if the opaque pair is incomplete, crossed,
  // stale, or from different observations. Version-one Docker evidence may
  // omit its legacy null slot at the browser boundary.
  if (spec.ruleId === "docker.daemon_state_bind_mount_publishes_port") {
    const port = record(finding.evidenceRefs[1]);
    if (!port || port.version !== 1 || port.provider !== "docker" || port.kind !== "docker_port_publication"
      || port.assertionKind !== "observed" || (port.providerSlot !== undefined && port.providerSlot !== null)
      || port.freshness !== "fresh" || port.subjectRef !== finding.subjectRef
      || port.collectedAt !== evidence.collectedAt || port.providerRevision !== evidence.providerRevision) return null;
  }

  return spec;
}
