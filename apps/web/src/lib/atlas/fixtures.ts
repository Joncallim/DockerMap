import type { ProviderState, RuntimeEvidenceRef, RuntimeMap, RuntimeMapEdge, RuntimeMapNode, RuntimeProviderKind } from "@dockermap/contracts";
import type { AtlasRuntimeMapInput } from "./types";

export type FixtureTopology = "none" | "sparse" | "chain" | "star" | "outbound_star" | "dag" | "cycle";
export type FixtureEvidenceKind = "dependency" | "network" | "storage" | "port";

export interface AtlasFixtureScenario {
  name: string;
  subjectCount: number;
  topology: FixtureTopology;
  evidence: FixtureEvidenceKind | "none";
  requestedSemanticGroups: 0 | 1 | 16;
  notes: string;
}

/**
 * Three deliberately synthetic host classes used only for Atlas certification.
 * Labels, ids, evidence summaries and metadata are fabricated and safe to put
 * in browser test artifacts. They are not recordings of a real host.
 */
export type AtlasSyntheticCertificationClass = "compose-heavy" | "mixed-docker-host-native" | "sparse-unusual";

export interface AtlasSyntheticCertificationScenario {
  name: AtlasSyntheticCertificationClass;
  notes: string;
}

const PROVIDER_STATES: RuntimeMap["providerStates"] = [
  providerState("network_infrastructure"), providerState("host_scoped"), providerState("cron"), providerState("systemd"),
  providerState("python_processes"), providerState("native_processes"), providerState("project_npm"), providerState("tmux")
];
const MIXED_CERTIFICATION_PROVIDER_STATES: RuntimeMap["providerStates"] = [
  providerState("network_infrastructure"), providerState("host_scoped"), providerState("cron"),
  { ...providerState("systemd"), state: "stale", statusReason: "collection_failed" },
  providerState("python_processes"), providerState("native_processes"), providerState("project_npm"), providerState("tmux")
];

function providerState(slot: ProviderState["slot"]): ProviderState {
  return {
    slot, state: "fresh", lastAttemptMs: 1, lastSuccessMs: 1, lastDurationMs: 1,
    consecutiveFailureCount: 0, dataRevision: `fixture-${slot}`, statusReason: null
  };
}

const PROVIDERS: readonly RuntimeProviderKind[] = ["docker", "systemd", "pm2", "python", "process", "network", "other"];
const NODES: readonly Pick<RuntimeMapNode, "provider" | "type" | "layer">[] = [
  { provider: "docker", type: "container", layer: "container" },
  { provider: "systemd", type: "systemd_service", layer: "service" },
  { provider: "pm2", type: "pm2_app", layer: "service" },
  { provider: "python", type: "python_application", layer: "process" },
  { provider: "process", type: "process", layer: "process" },
  { provider: "network", type: "network_listener", layer: "network" },
  { provider: "other", type: "external_api", layer: "edge" }
];
const STATUSES = ["running", "paused", "unhealthy", "exited", "starting", "unknown"] as const;

function node(index: number): RuntimeMapNode {
  const template = NODES[index % NODES.length];
  const unicode = index === 1 ? "東京 service" : `subject-${String(index).padStart(3, "0")}`;
  return {
    id: `runtime_subject_${String(index).padStart(3, "0")}`,
    provider: template.provider,
    type: template.type,
    layer: template.layer,
    label: index === 2 ? `${unicode} ${"very-long-label ".repeat(16)}` : unicode,
    status: STATUSES[index % STATUSES.length], metadata: { deliberatelyIgnored: "not-evidence" }
  };
}

function evidencedNode(index: number, topology: FixtureTopology, evidence: Exclude<FixtureEvidenceKind, "none">): RuntimeMapNode {
  const container = (ordinal: number): RuntimeMapNode => ({
    id: `docker_container_container_${String(ordinal).padStart(3, "0")}`,
    provider: "docker", type: "container", layer: "container", label: `container-${ordinal}`,
    status: STATUSES[ordinal % STATUSES.length], metadata: {}
  });
  if (evidence === "dependency") return container(index);
  const isSharedContext = topology === "outbound_star" ? index > 0 : index === 0;
  if (!isSharedContext) return container(index);
  if (evidence === "network") return {
    id: `docker_network_network_${String(index).padStart(3, "0")}`,
    provider: "docker", type: "docker_network", layer: "network", label: `network-${index}`, status: null, metadata: {}
  };
  if (evidence === "storage") return {
    id: `docker_volume_volume_${String(index).padStart(3, "0")}`,
    provider: "docker", type: "docker_volume", layer: "storage", label: `volume-${index}`, status: null, metadata: {}
  };
  return {
    id: `network_listener_${String(index).padStart(3, "0")}_443_tcp`,
    provider: "network", type: "network_listener", layer: "network", label: `listener-${index}`, status: "listening", metadata: {}
  };
}

function structuralEdge(source: string, target: string, evidence: FixtureEvidenceKind): RuntimeMapEdge {
  const relationship = evidence === "dependency" ? "depends_on" : evidence === "storage" ? "mounts" : evidence === "port" ? "exposes" : "connected_to";
  const kind = evidence === "dependency" ? "docker_compose_depends_on" : evidence === "network" ? "docker_network_membership" :
    evidence === "storage" ? "docker_volume_mount" : "docker_port_publication";
  return {
    source, target, relationship, metadata: { hostile: "metadata-is-not-evidence" },
    evidenceRefs: [{
      id: `fixture_${kind}_${source}_${target}`, provider: "docker", kind, assertionKind: "observed",
      freshness: "fresh", providerRevision: "fixture-revision", subjectRef: source,
      summary: "fixture structural evidence", collectedAt: 1, version: 1
    }]
  } as RuntimeMapEdge;
}

function edgesFor(nodes: readonly RuntimeMapNode[], topology: FixtureTopology, evidence: FixtureEvidenceKind | "none"): RuntimeMapEdge[] {
  if (nodes.length < 2 || topology === "none" || evidence === "none") return [];
  const id = (index: number) => nodes[index]!.id;
  const pairs: Array<[number, number]> = [];
  if (topology === "sparse") pairs.push([0, 1]);
  if (topology === "chain") for (let index = 1; index < nodes.length; index += 1) pairs.push([index, index - 1]);
  if (topology === "star") for (let index = 1; index < nodes.length; index += 1) pairs.push([index, 0]);
  if (topology === "outbound_star") for (let index = 1; index < nodes.length; index += 1) pairs.push([0, index]);
  if (topology === "dag") for (let index = 1; index < nodes.length; index += 1) {
    pairs.push([index, Math.floor((index - 1) / 2)]);
    if (index > 2) pairs.push([index, index - 2]);
  }
  if (topology === "cycle") for (let index = 0; index < nodes.length; index += 1) pairs.push([index, (index + 1) % nodes.length]);
  return pairs.map(([source, target]) => structuralEdge(id(source), id(target), evidence));
}

/** A coherent RuntimeMap-shaped fixture; no fixture joins data from a second endpoint. */
export function runtimeFixture(
  subjectCount: number,
  topology: FixtureTopology = "none",
  evidence: FixtureEvidenceKind | "none" = "none"
): AtlasRuntimeMapInput {
  const nodes = evidence === "none"
    ? Array.from({ length: subjectCount }, (_, index) => node(index))
    : Array.from({ length: subjectCount }, (_, index) => evidencedNode(index, topology, evidence));
  return {
    nodes, edges: edgesFor(nodes, topology, evidence), diagnostics: [],
    modelRevision: "atlas-fixture-r1", lastUpdated: 1, providerStates: PROVIDER_STATES
  };
}

/** Deliberately raw opaque-port text: the projector must ignore it as topology proof. */
export function opaquePortFixture(): AtlasRuntimeMapInput {
  const fixture = runtimeFixture(2);
  fixture.nodes[0] = { ...fixture.nodes[0], metadata: { ports: "0.0.0.0:443->443/tcp, [::1]:x, opaque" } };
  fixture.edges = [{
    source: fixture.nodes[0].id, target: fixture.nodes[1].id, relationship: "exposes", metadata: { ports: "opaque" }, evidenceRefs: []
  } as RuntimeMapEdge];
  return fixture;
}

export function collisionFixture(): AtlasRuntimeMapInput {
  const fixture = runtimeFixture(3, "chain", "dependency");
  fixture.nodes[1] = { ...fixture.nodes[1], id: fixture.nodes[0].id, label: "lookalike-collision" };
  return fixture;
}

export function malformedIdentityFixture(): AtlasRuntimeMapInput {
  const fixture = runtimeFixture(1);
  fixture.nodes[0] = { ...fixture.nodes[0], id: "label with / unsafe path" };
  return fixture;
}

export function unsupportedKindFixture(): AtlasRuntimeMapInput {
  const fixture = runtimeFixture(1);
  fixture.nodes[0] = { ...fixture.nodes[0], type: "future_unpublished_kind" as RuntimeMapNode["type"] };
  return fixture;
}

/** Canonical V1 daemon-state edge: attachment/context, never a causal relation. */
export function daemonStateAttachmentFixture(): AtlasRuntimeMapInput {
  const fixture = runtimeFixture(2);
  const source = "docker_container_container_daemon_client";
  const target = "host_risk_docker_daemon_state";
  fixture.nodes = [
    { id: source, provider: "docker", type: "container", layer: "container", label: "daemon client", status: "running", metadata: {} },
    { id: target, provider: "docker", type: "host_risk", layer: "host", label: "Docker daemon state exposure", status: null, metadata: {} }
  ];
  fixture.edges = [{
    source, target, relationship: "exposes_daemon_state", metadata: {}, evidenceRefs: [{
      version: 1, id: "fixture-daemon-state", provider: "docker", kind: "docker_daemon_state_bind_mount", assertionKind: "observed",
      freshness: "fresh", providerRevision: "fixture-docker-revision", subjectRef: source,
      summary: "Docker reported a bind mount exposing Docker daemon state", collectedAt: 1
    }]
  } as RuntimeMapEdge];
  return fixture;
}

/** Lookalikes from distinct sources stay separate until an explicit correlation contract exists. */
export function crossSourceLookalikeFixture(): AtlasRuntimeMapInput {
  const fixture = runtimeFixture(2);
  fixture.nodes = [
    { id: "docker_container_container_same_entity", provider: "docker", type: "container", layer: "container", label: "same entity", status: "running", metadata: {} },
    { id: "systemd_service_same_entity", provider: "systemd", type: "systemd_service", layer: "service", label: "same entity", status: "running", metadata: {} }
  ];
  fixture.edges = [];
  return fixture;
}

function certificationEvidence(
  id: string,
  provider: RuntimeEvidenceRef["provider"],
  kind: RuntimeEvidenceRef["kind"],
  source: string,
  assertionKind: RuntimeEvidenceRef["assertionKind"] = "observed",
  freshness: RuntimeEvidenceRef["freshness"] = "fresh",
  providerSlot?: RuntimeEvidenceRef["providerSlot"]
): RuntimeEvidenceRef {
  return {
    version: provider === "systemd" ? 2 : 1,
    id: `synthetic-${id}`,
    provider,
    kind,
    assertionKind,
    freshness,
    providerRevision: "synthetic-certification-r1",
    ...(providerSlot ? { providerSlot } : {}),
    subjectRef: source,
    summary: "Synthetic certification declaration",
    collectedAt: 1
  } as RuntimeEvidenceRef;
}

function certificationNode(id: string, provider: RuntimeMapNode["provider"], type: RuntimeMapNode["type"], layer: RuntimeMapNode["layer"], label: string, status: string | null = "running"): RuntimeMapNode {
  return { id, provider, type, layer, label, status, metadata: {} };
}

/** Docker declarations and recorded context only; no host or reachability claim. */
function composeHeavyCertificationFixture(): AtlasRuntimeMapInput {
  const web = "docker_container_synthetic_compose_web";
  const worker = "docker_container_synthetic_compose_worker";
  const database = "docker_container_synthetic_compose_database";
  const network = "docker_network_synthetic_compose";
  const volume = "docker_volume_synthetic_compose_data";
  return {
    nodes: [
      certificationNode(web, "docker", "container", "container", "compose web"),
      certificationNode(worker, "docker", "container", "container", "compose worker"),
      certificationNode(database, "docker", "container", "container", "compose database"),
      certificationNode(network, "docker", "docker_network", "network", "recorded compose network", null),
      certificationNode(volume, "docker", "docker_volume", "storage", "recorded compose storage", null)
    ],
    edges: [
      { source: web, target: worker, relationship: "depends_on", metadata: {}, evidenceRefs: [certificationEvidence("compose-depends", "docker", "docker_compose_depends_on", web)] },
      { source: web, target: network, relationship: "connected_to", metadata: {}, evidenceRefs: [certificationEvidence("compose-network-web", "docker", "docker_network_membership", web)] },
      { source: database, target: network, relationship: "connected_to", metadata: {}, evidenceRefs: [certificationEvidence("compose-network-db", "docker", "docker_network_membership", database)] },
      { source: database, target: volume, relationship: "mounts", metadata: {}, evidenceRefs: [certificationEvidence("compose-storage", "docker", "docker_volume_mount", database)] }
    ] as RuntimeMapEdge[],
    diagnostics: [], modelRevision: "atlas-synthetic-compose-heavy-r1", lastUpdated: 1, providerStates: PROVIDER_STATES
  };
}

/** Same-looking Docker and systemd records remain source-scoped; systemd is intentionally stale. */
function mixedDockerHostNativeCertificationFixture(): AtlasRuntimeMapInput {
  const dockerGateway = "docker_container_synthetic_gateway";
  const systemdGateway = "systemd_service_synthetic_gateway";
  const systemdTarget = "systemd_service_synthetic_target";
  return {
    nodes: [
      certificationNode(dockerGateway, "docker", "container", "container", "gateway"),
      certificationNode(systemdGateway, "systemd", "systemd_service", "service", "gateway"),
      certificationNode(systemdTarget, "systemd", "systemd_service", "service", "host target", "paused")
    ],
    edges: [
      { source: systemdGateway, target: systemdTarget, relationship: "requires", metadata: {}, evidenceRefs: [certificationEvidence("systemd-requires", "systemd", "systemd_requires", systemdGateway, "declared", "stale", "systemd")] }
    ] as RuntimeMapEdge[],
    diagnostics: [], modelRevision: "atlas-synthetic-mixed-host-r1", lastUpdated: 1,
    providerStates: MIXED_CERTIFICATION_PROVIDER_STATES
  };
}

/** Collision, unsupported kind and daemon-risk context remain visible but never become a confident merge. */
function sparseUnusualCertificationFixture(): AtlasRuntimeMapInput {
  const daemonClient = "docker_container_synthetic_daemon_client";
  const daemonRisk = "host_risk_docker_daemon_state";
  return {
    nodes: [
      certificationNode("docker_container_synthetic_collision", "docker", "container", "container", "duplicate record"),
      certificationNode("docker_container_synthetic_collision", "docker", "container", "container", "duplicate record"),
      certificationNode("runtime_synthetic_unsupported", "other", "future_unpublished_kind" as RuntimeMapNode["type"], "edge", "unsupported synthetic record", null),
      certificationNode(daemonClient, "docker", "container", "container", "daemon context client"),
      certificationNode(daemonRisk, "docker", "host_risk", "host", "recorded daemon state context", null)
    ],
    edges: [{
      source: daemonClient, target: daemonRisk, relationship: "exposes_daemon_state", metadata: {},
      evidenceRefs: [certificationEvidence("daemon-risk", "docker", "docker_daemon_state_bind_mount", daemonClient)]
    }] as RuntimeMapEdge[],
    diagnostics: [], modelRevision: "atlas-synthetic-sparse-unusual-r1", lastUpdated: 1, providerStates: PROVIDER_STATES
  };
}

export const atlasSyntheticCertificationMatrix: readonly AtlasSyntheticCertificationScenario[] = [
  { name: "compose-heavy", notes: "Docker declarations and recorded context only" },
  { name: "mixed-docker-host-native", notes: "stale systemd declaration and no fuzzy cross-provider merge" },
  { name: "sparse-unusual", notes: "collision, unsupported record and daemon-risk uncertainty" }
];

export function syntheticCertificationFixture(scenario: AtlasSyntheticCertificationScenario | AtlasSyntheticCertificationClass): AtlasRuntimeMapInput {
  const name = typeof scenario === "string" ? scenario : scenario.name;
  if (name === "compose-heavy") return composeHeavyCertificationFixture();
  if (name === "mixed-docker-host-native") return mixedDockerHostNativeCertificationFixture();
  return sparseUnusualCertificationFixture();
}

export function permutation<T>(values: readonly T[]): T[] {
  return [...values].reverse();
}

export function mutateStateOnly(fixture: AtlasRuntimeMapInput): AtlasRuntimeMapInput {
  return { ...fixture, nodes: fixture.nodes.map((entry, index) => index === 0 ? { ...entry, status: "unhealthy" } : entry) };
}

export function mutateUnrelatedSubject(fixture: AtlasRuntimeMapInput): AtlasRuntimeMapInput {
  return {
    ...fixture,
    nodes: [...fixture.nodes, {
      id: "runtime_subject_unrelated", provider: PROVIDERS[0], type: "container", layer: "container",
      label: "unrelated", status: "running", metadata: {}
    }]
  };
}

/**
 * Representative matrix: properties cover combinations/permutations; these
 * named cases are the finite regression/golden candidates, not screenshots.
 */
export const atlasFixtureMatrix: readonly AtlasFixtureScenario[] = [
  { name: "empty", subjectCount: 0, topology: "none", evidence: "none", requestedSemanticGroups: 0, notes: "zero subjects" },
  { name: "one", subjectCount: 1, topology: "none", evidence: "none", requestedSemanticGroups: 0, notes: "one subject" },
  { name: "five-sparse", subjectCount: 5, topology: "sparse", evidence: "dependency", requestedSemanticGroups: 0, notes: "sparse declaration" },
  { name: "twenty-five-chain", subjectCount: 25, topology: "chain", evidence: "dependency", requestedSemanticGroups: 1, notes: "requested groups stay unsupported in V1" },
  { name: "fifty-star-network", subjectCount: 50, topology: "star", evidence: "network", requestedSemanticGroups: 16, notes: "high-degree non-causal attachments" },
  { name: "one-hundred-dag", subjectCount: 100, topology: "dag", evidence: "dependency", requestedSemanticGroups: 0, notes: "directional declaration DAG" },
  { name: "fifty-storage-outbound", subjectCount: 50, topology: "outbound_star", evidence: "storage", requestedSemanticGroups: 0, notes: "storage-heavy attachment fanout" },
  { name: "two-fifty-cycle", subjectCount: 250, topology: "cycle", evidence: "dependency", requestedSemanticGroups: 0, notes: "cap stress cycle" },
  { name: "mixed-port-context", subjectCount: 25, topology: "star", evidence: "port", requestedSemanticGroups: 0, notes: "recorded context only" }
];

export function matrixFixture(scenario: AtlasFixtureScenario): AtlasRuntimeMapInput {
  return runtimeFixture(scenario.subjectCount, scenario.topology, scenario.evidence);
}
