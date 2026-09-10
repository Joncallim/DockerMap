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
  inspection: {
    ruleLabel: string;
    ruleId: Finding["ruleId"];
    freshEvidenceRequirement: string;
    factDescription: string;
    limits: string;
  };
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
    title: "Declared dependency needs review", category: "Systemd Requires", hint: "Observed declaration", tone: "warn", severityLabel: "Warning",
    inspection: { ruleLabel: "Systemd declared dependency", ruleId: "systemd.requires_target_not_active", freshEvidenceRequirement: "Requires one fresh declared systemd fact.", factDescription: "One declared dependency fact.", limits: "Does not establish service readiness, causality, traffic, or remediation." }
  },
  {
    ruleId: "docker.internal_network_member_publishes_port", severity: "advisory",
    summary: "A container on an internal Docker network also has a published host port.",
    recommendation: "Review whether the host-port publication is intended for this internal-network service.",
    idPrefix: "finding_docker_internal_network_member_publishes_port_", subjectPrefix: "docker_container_", targetPrefix: "docker_network_",
    evidenceCount: 2, evidence: { version: 1, provider: "docker", kind: "docker_network_membership", assertionKind: "observed", providerSlot: null },
    title: "Internal-network port publication needs review", category: "Internal network + host port", hint: "Observed Docker facts", tone: "muted", severityLabel: "Advisory",
    inspection: { ruleLabel: "Internal network and host port", ruleId: "docker.internal_network_member_publishes_port", freshEvidenceRequirement: "Requires two fresh observed Docker facts.", factDescription: "One network-membership fact and one host-port-publication fact.", limits: "Does not establish Internet reachability, traffic, causality, or remediation." }
  },
  {
    ruleId: "docker.port_published_on_unspecified_address", severity: "advisory",
    summary: "Docker reported a container port published on an unspecified host address.",
    recommendation: "Review whether publishing this container port beyond loopback is intended.",
    idPrefix: "finding_docker_port_published_on_unspecified_address_", subjectPrefix: "docker_container_", targetRef: "host_risk_docker_unspecified_address_port",
    evidenceCount: 1, evidence: { version: 1, provider: "docker", kind: "docker_unspecified_address_port_publication", assertionKind: "observed", providerSlot: null },
    title: "Unspecified-address port publication needs review", category: "Host port publication", hint: "Observed Docker fact", tone: "muted", severityLabel: "Advisory",
    inspection: { ruleLabel: "Unspecified-address host port", ruleId: "docker.port_published_on_unspecified_address", freshEvidenceRequirement: "Requires one fresh observed Docker fact.", factDescription: "One Docker fact that records a valid nonzero port published on an unspecified host address.", limits: "Does not establish Internet reachability, reachability from any network, traffic, causality, or remediation." }
  },
  {
    ruleId: "docker.daemon_state_bind_mount", severity: "warning",
    summary: "A container has Docker daemon state access that may provide Docker daemon API authority.",
    recommendation: "Review whether this container requires Docker daemon API authority.",
    idPrefix: "finding_docker_daemon_state_bind_mount_", subjectPrefix: "docker_container_", targetRef: "host_risk_docker_daemon_state",
    evidenceCount: 1, evidence: { version: 1, provider: "docker", kind: "docker_daemon_state_bind_mount", assertionKind: "observed", providerSlot: null },
    title: "Docker daemon-state access needs review", category: "Docker daemon state", hint: "Observed Docker fact", tone: "warn", severityLabel: "Warning",
    inspection: { ruleLabel: "Docker daemon-state access", ruleId: "docker.daemon_state_bind_mount", freshEvidenceRequirement: "Requires one fresh observed Docker fact.", factDescription: "One Docker daemon-state fact.", limits: "Does not establish effective authority, exploitation, causality, or remediation." }
  },
  {
    ruleId: "docker.daemon_state_bind_mount_publishes_port", severity: "warning",
    summary: "A container with Docker daemon state access also has a published host port.",
    recommendation: "Review whether the daemon-state access and host-port publication are both intended.",
    idPrefix: "finding_docker_daemon_state_bind_mount_publishes_port_", subjectPrefix: "docker_container_", targetRef: "host_risk_docker_daemon_state",
    evidenceCount: 2, evidence: { version: 1, provider: "docker", kind: "docker_daemon_state_bind_mount", assertionKind: "observed", providerSlot: null },
    title: "Docker daemon-state and host-port publication need review", category: "Docker daemon state + host port", hint: "Observed Docker facts", tone: "warn", severityLabel: "Warning", inspectChanges: true,
    inspection: { ruleLabel: "Docker daemon-state access and host port", ruleId: "docker.daemon_state_bind_mount_publishes_port", freshEvidenceRequirement: "Requires two fresh observed Docker facts from one collection.", factDescription: "One Docker daemon-state fact and one host-port-publication fact.", limits: "Does not establish effective authority, exploitation, Internet reachability, causality, or remediation." }
  },
  {
    ruleId: "docker.compose_declared_target_not_active", severity: "advisory",
    summary: "A running Docker Compose service declares a dependency whose container is not active.",
    recommendation: "Review the declared dependency and the target container state.",
    idPrefix: "finding_docker_compose_declared_target_not_active_", subjectPrefix: "docker_container_", targetPrefix: "docker_container_",
    evidenceCount: 1, evidence: { version: 1, provider: "docker", kind: "docker_compose_depends_on", assertionKind: "observed", providerSlot: null },
    title: "Declared Compose dependency needs review", category: "Docker Compose", hint: "Observed Compose declaration", tone: "muted", severityLabel: "Advisory", inspectChanges: true,
    inspection: { ruleLabel: "Compose declared dependency", ruleId: "docker.compose_declared_target_not_active", freshEvidenceRequirement: "Requires one fresh observed Compose declaration.", factDescription: "One declared dependency fact.", limits: "Does not establish startup order, causality, readiness, or remediation." }
  },
  {
    ruleId: "docker.compose_mutual_dependency", severity: "advisory",
    summary: "Docker recorded mutually declared Compose dependencies between two containers.",
    recommendation: "Review the declared dependencies and remove any unintended mutual dependency.",
    idPrefix: "finding_docker_compose_mutual_dependency_", subjectPrefix: "docker_container_", targetPrefix: "docker_container_",
    evidenceCount: 2, evidence: { version: 1, provider: "docker", kind: "docker_compose_depends_on", assertionKind: "observed", providerSlot: null },
    title: "Mutual Compose declarations need review", category: "Docker Compose", hint: "Observed Compose declarations", tone: "muted", severityLabel: "Advisory", inspectChanges: true,
    inspection: { ruleLabel: "Mutual Compose declarations", ruleId: "docker.compose_mutual_dependency", freshEvidenceRequirement: "Requires two fresh observed Compose declarations from one collection.", factDescription: "Two declared dependency facts in opposite directions.", limits: "Does not establish startup order, causality, readiness, or remediation." }
  },
  {
    ruleId: "compose.declared_mount_missing_at_bound_container", severity: "warning",
    summary: "A Compose-declared mount is absent from its exactly bound runtime container",
    recommendation: "Inspect the Compose mount declaration and the bound container's current mount configuration.",
    idPrefix: "finding_compose_declared_mount_missing_at_bound_container_", subjectPrefix: "compose_runtime_binding_", targetPrefix: "compose_runtime_binding_",
    evidenceCount: 2, evidence: { version: 6, provider: "compose", kind: "compose_declared_mount", assertionKind: "declared", providerSlot: null },
    title: "Declared Compose mount needs review", category: "Compose runtime drift", hint: "Bounded structural facts", tone: "warn", severityLabel: "Warning", inspectChanges: true,
    inspection: { ruleLabel: "Compose declaration and runtime binding", ruleId: "compose.declared_mount_missing_at_bound_container", freshEvidenceRequirement: "Requires two fresh, paired structural facts from one collection.", factDescription: "One Compose mount declaration and one exact Docker Compose/runtime binding fact.", limits: "Does not expose mount paths, names, labels, or container identity, and does not establish causality or remediation." }
  },
  {
    ruleId: "runtime.identity_collision_detected", severity: "advisory",
    summary: "DockerMap detected duplicate runtime identities after publication normalization.",
    recommendation: "Review the duplicate identity condition before relying on topology relationships.",
    idPrefix: "finding_runtime_identity_collision_detected", subjectPrefix: "runtime_integrity_scope", targetRef: "runtime_integrity_risk_identity_collision",
    evidenceCount: 1, evidence: { version: 7, provider: "dockermap", kind: "runtime_identity_collision", assertionKind: "observed", providerSlot: null },
    title: "Runtime identity integrity needs review", category: "Evidence integrity", hint: "Aggregate structural fact", tone: "muted", severityLabel: "Advisory",
    inspection: { ruleLabel: "Published runtime identity integrity", ruleId: "runtime.identity_collision_detected", freshEvidenceRequirement: "Requires one fresh aggregate DockerMap integrity fact.", factDescription: "One aggregate fact that duplicate identities were detected after publication normalization.", limits: "Does not expose or identify any collided runtime identity, count, provider data, health, causality, or remediation." }
  }
];

const COMPOSE_DECLARATION_EVIDENCE_SUMMARY = "Docker recorded Compose dependency declaration";
const UNSPECIFIED_ADDRESS_PUBLICATION_EVIDENCE_SUMMARY = "Docker reported a container port published on an unspecified host address";
const RUNTIME_IDENTITY_COLLISION_EVIDENCE_SUMMARY = "DockerMap detected duplicate runtime identities after publication normalization";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isOpaqueComposeRuntimeBindingId(value: unknown): value is string {
  return typeof value === "string" && /^compose_runtime_binding_[a-f0-9]{64}$/.test(value);
}

function composeMountFindingDigest(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^finding_compose_declared_mount_missing_at_bound_container_([a-f0-9]{64})$/.exec(value);
  return match?.[1] ?? null;
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
    || (spec.ruleId !== "compose.declared_mount_missing_at_bound_container" && finding.subjectRef === finding.targetRef)
    || (spec.ruleId === "runtime.identity_collision_detected" && (finding.id !== "finding_runtime_identity_collision_detected" || finding.subjectRef !== "runtime_integrity_scope"))
    // Mutual findings are emitted in one canonical direction. This preserves
    // the API's ordered forward/reverse evidence meaning without displaying
    // either opaque reference.
    || (spec.ruleId === "docker.compose_mutual_dependency" && finding.subjectRef >= finding.targetRef)
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
    || ((spec.ruleId === "docker.compose_declared_target_not_active" || spec.ruleId === "docker.daemon_state_bind_mount_publishes_port" || spec.ruleId === "docker.compose_mutual_dependency" || spec.ruleId === "compose.declared_mount_missing_at_bound_container" || spec.ruleId === "docker.port_published_on_unspecified_address" || spec.ruleId === "runtime.identity_collision_detected")
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

  // This advisory deliberately has no address or port fields at all. Its one
  // V1 observation must remain the fixed redacted fact before generic copy is
  // shown; the legacy absent/null Docker-wide slot is accepted above.
  if (spec.ruleId === "docker.port_published_on_unspecified_address"
    && (evidence.summary !== UNSPECIFIED_ADDRESS_PUBLICATION_EVIDENCE_SUMMARY
      || typeof evidence.collectedAt !== "number" || !Number.isSafeInteger(evidence.collectedAt) || evidence.collectedAt < 0
      || typeof evidence.providerRevision !== "string" || evidence.providerRevision.length === 0
      || evidence.providerRevision === String(evidence.collectedAt))) return null;

  if (spec.ruleId === "runtime.identity_collision_detected"
    && (evidence.id !== "dockermap_evidence_runtime_identity_collision"
      || evidence.summary !== RUNTIME_IDENTITY_COLLISION_EVIDENCE_SUMMARY
      || typeof evidence.collectedAt !== "number" || !Number.isSafeInteger(evidence.collectedAt) || evidence.collectedAt < 0
      || typeof evidence.providerRevision !== "string" || !/^[a-f0-9]{32}-[1-9][0-9]*$/.test(evidence.providerRevision)
      || evidence.providerRevision === String(evidence.collectedAt))) return null;

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

  // A mutual Compose declaration is a fixed, contemporaneous pair: first
  // subject -> target, then target -> subject. Keep the collection token
  // opaque, but require both observations to share it and their collection
  // instant so a malformed or stitched response cannot produce advice.
  if (spec.ruleId === "docker.compose_mutual_dependency") {
    const reverse = record(finding.evidenceRefs[1]);
    const isFreshComposeEvidence = (candidate: Record<string, unknown>, subjectRef: unknown) => (
      candidate.version === 1
      && candidate.provider === "docker"
      && candidate.kind === "docker_compose_depends_on"
      && candidate.assertionKind === "observed"
      && (candidate.providerSlot === undefined || candidate.providerSlot === null)
      && candidate.freshness === "fresh"
      && candidate.subjectRef === subjectRef
      && typeof candidate.id === "string" && candidate.id.length > 0
      && candidate.summary === COMPOSE_DECLARATION_EVIDENCE_SUMMARY
      && typeof candidate.collectedAt === "number" && Number.isSafeInteger(candidate.collectedAt) && candidate.collectedAt >= 0
      && typeof candidate.providerRevision === "string" && candidate.providerRevision.length > 0
      && candidate.providerRevision !== String(candidate.collectedAt)
    );
    if (!reverse
      || !isFreshComposeEvidence(evidence, finding.subjectRef)
      || !isFreshComposeEvidence(reverse, finding.targetRef)
      || evidence.collectedAt !== reverse.collectedAt
      || evidence.providerRevision !== reverse.providerRevision) return null;
  }

  // The identity comes from private Compose/Docker binding data. Verify its
  // fixed opaque shape and coherent V6 pair, but keep every opaque field out
  // of the presentation.
  if (spec.ruleId === "compose.declared_mount_missing_at_bound_container") {
    const digest = composeMountFindingDigest(finding.id);
    const binding = record(finding.evidenceRefs[1]);
    const isV6BindingEvidence = (
      candidate: Record<string, unknown>, provider: string, kind: string,
      assertionKind: string, summary: string, idPrefix: string,
    ) => candidate.version === 6
      && candidate.provider === provider
      && candidate.kind === kind
      && candidate.assertionKind === assertionKind
      && candidate.summary === summary
      && candidate.id === `${idPrefix}_${digest}`
      && candidate.subjectRef === finding.subjectRef
      && (candidate.providerSlot === undefined || candidate.providerSlot === null)
      && candidate.freshness === "fresh"
      && typeof candidate.collectedAt === "number"
      && Number.isSafeInteger(candidate.collectedAt)
      && candidate.collectedAt >= 0
      && typeof candidate.providerRevision === "string"
      && candidate.providerRevision.length > 0
      && candidate.providerRevision !== String(candidate.collectedAt);
    if (!digest
      || !isOpaqueComposeRuntimeBindingId(finding.subjectRef)
      || finding.targetRef !== finding.subjectRef
      || !binding
      || !isV6BindingEvidence(evidence, "compose", "compose_declared_mount", "declared", "Compose declared a mount for the bound service", "compose_declared_mount")
      || !isV6BindingEvidence(binding, "docker", "docker_compose_runtime_binding", "observed", "Docker confirmed an exact Compose project, service, and config binding", "docker_compose_runtime_binding")
      || evidence.collectedAt !== binding.collectedAt
      || evidence.providerRevision !== binding.providerRevision) return null;
  }

  return spec;
}
