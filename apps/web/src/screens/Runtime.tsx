import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { ProviderSlot, ProviderState, ProviderStatusReason, RuntimeEvidenceAssertionKind, RuntimeEvidenceRef, RuntimeLocation, RuntimeMapEdge, RuntimeProviderKind } from "@dockermap/contracts";
import { useApp } from "../context";
import { needsAttention, type RuntimeLayerId, type RuntimeNodeRecord } from "../lib/model";
import { formatRelative } from "../lib/format";
import Icon, { type IconName } from "../components/Icon";
import { EmptyState, ErrorState, KeyValue, Loading, Metric, Panel, StateDot, StatePill, Tag } from "../components/primitives";
import { COLLISION_HINT, COLLISION_TAG, identityText, UNAVAILABLE_DIAGNOSTIC_MESSAGE, UNAVAILABLE_EVENT_KIND, UNAVAILABLE_LOCATION_KIND, UNAVAILABLE_LOCATION_VALUE, UNAVAILABLE_LOG_SOURCE, UNAVAILABLE_METADATA_VALUE, UNAVAILABLE_OWNER, UNAVAILABLE_PACKAGE, UNAVAILABLE_PACKAGE_VERSION, UNAVAILABLE_RUNTIME_ID, UNAVAILABLE_RUNTIME_NODE, UNAVAILABLE_SERVICE, UNAVAILABLE_SERVICE_STATUS } from "../lib/identity";

const PROVIDER_ICON: Record<RuntimeProviderKind, IconName> = {
  docker: "service",
  compose: "compose",
  host: "cpu",
  systemd: "layers",
  scheduled_job: "history",
  npm: "image",
  pm2: "spark",
  tmux: "command",
  tailscale: "network",
  headscale: "network",
  cloudflare: "shield",
  caddy: "proxy",
  reverse_proxy: "proxy",
  local_dns: "network",
  dns_provider: "network",
  external_api: "external",
  process: "worker",
  python: "worker",
  network: "link",
  kubernetes: "storage",
  other: "service"
};

const LAYER_LABEL: Record<RuntimeLayerId, string> = {
  advisory: "Advisory",
  container: "Container",
  edge: "Edge",
  host: "Host",
  network: "Network",
  package: "Package",
  process: "Process",
  service: "Service",
  session: "Session",
  storage: "Storage",
  unassigned: "Unassigned"
};

const PROVIDER_SLOT_LABEL: Record<ProviderSlot, string> = {
  network_infrastructure: "Network infrastructure",
  host_scoped: "Host-scoped services",
  python_processes: "Python processes",
  native_processes: "Native processes",
  project_npm: "Project npm"
};

const PROVIDER_STATE_LABEL: Record<ProviderState["state"], string> = {
  fresh: "Current",
  stale: "Retained observation",
  collecting: "Collecting",
  unavailable: "Not collected",
  timed_out: "Timed out",
  disabled: "Disabled"
};

const PROVIDER_STATE_TONE: Record<ProviderState["state"], "accent" | "warn" | "error" | "muted"> = {
  fresh: "accent",
  stale: "warn",
  collecting: "muted",
  unavailable: "muted",
  timed_out: "error",
  disabled: "muted"
};

// These are daemon-owned closed reasons, deliberately rendered as collection
// evidence instead of raw provider output or a service-health diagnosis.
const PROVIDER_REASON_LABEL: Record<ProviderStatusReason, string> = {
  initial: "Awaiting first collection",
  refreshing: "Refresh in progress",
  collection_failed: "Last collection failed",
  collection_timed_out: "Last collection timed out",
  source_reset: "Collection source reset",
  disabled: "Collection disabled"
};

const ASSERTION_KIND_LABEL: Record<RuntimeEvidenceAssertionKind, string> = {
  observed: "Observed fact",
  derived: "Derived relationship",
  inferred: "Inferred relationship"
};

const FRESHNESS_LABEL: Record<RuntimeEvidenceRef["freshness"], string> = {
  fresh: "Current at collection"
};

type SelectedRuntimeEdge = {
  edge: RuntimeMapEdge;
  key: string;
};

function runtimeEdgeKey(edge: RuntimeMapEdge) {
  return [edge.source, edge.target, edge.relationship, ...edge.evidenceRefs.map((evidence) => evidence.id)].join("\u0000");
}

function providerFreshnessText(providerState: ProviderState): string {
  if (providerState.lastSuccessMs !== null) return `Last collected ${formatRelative(providerState.lastSuccessMs)}`;
  if (providerState.lastAttemptMs !== null) return `Last attempted ${formatRelative(providerState.lastAttemptMs)}`;
  return "No collection recorded";
}

export default function RuntimeScreen() {
  const { model, loading, error, evidenceMode } = useApp();
  const [providerFilter, setProviderFilter] = useState<RuntimeProviderKind | "all">("all");
  const [layerFilter, setLayerFilter] = useState<RuntimeLayerId | "all">("all");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<SelectedRuntimeEdge | null>(null);
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());
  /**
   * KEYED focus request: set by selectNode, consumed by the layout effect
   * once the destination row actually commits. Relation navigation may widen
   * the filters in the SAME batch as the selection, so the row is not
   * rendered yet when the request is made — a single requestAnimationFrame
   * would fire too early (or not at all when the row never mounts) and focus
   * would fall to BODY.
   */
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);

  const runtime = model?.runtime;
  const filteredNodes = useMemo(() => {
    if (!runtime) return [];
    return runtime.nodes.filter((node) => {
      if (providerFilter !== "all" && node.provider !== providerFilter) return false;
      if (layerFilter !== "all" && node.layer !== layerFilter) return false;
      if (attentionOnly && !needsAttention(node.state)) return false;
      return true;
    });
  }, [attentionOnly, layerFilter, providerFilter, runtime]);

  useEffect(() => {
    if (!runtime || !selectedId) return;
    if (!filteredNodes.some((node) => node.id === selectedId && runtime.byId.has(node.id))) setSelectedId(null);
  }, [filteredNodes, runtime, selectedId]);

  // Consume a pending focus request in a LAYOUT effect, once its row is
  // actually LIVE in the DOM. Layout effects run synchronously after the
  // commit and BEFORE paint, so the destination button is focused in the
  // same frame as the filter-widening commit — no body-focus frame can ever
  // paint (a passive effect may run after paint). The request is cleared
  // ONLY after a live element was found AND focused; if the row is filtered
  // out or not yet mounted, the request stays pending for the next commit
  // instead of being dropped.
  useLayoutEffect(() => {
    if (!pendingFocusId) return;
    if (!filteredNodes.some((node) => node.id === pendingFocusId)) return;
    const element = nodeRefs.current.get(pendingFocusId);
    if (!element) return;
    element.focus();
    setPendingFocusId(null);
  }, [filteredNodes, pendingFocusId]);

  useEffect(() => () => nodeRefs.current.clear(), []);

  if (loading && !model) return <Loading label="Reading runtime topology…" />;
  if (error && !model) return <ErrorState title="Runtime unavailable" body={error} />;
  if (!model || !runtime) return <EmptyState icon="layers" title="No runtime map yet" body="Connect a host or enable Demo Mode to inspect runtime signals." />;

  const selected = selectedId ? runtime.byId.get(selectedId) ?? null : null;
  const selectedDetail = resolveDockerDetail(model, selected);
  const selectedImage = selected?.provider === "docker" && selected.type === "container" && typeof selected.metadata.image === "string" && selected.metadata.image !== "" ? model.imageByRef.get(selected.metadata.image) ?? null : null;

  /**
   * Shared selection handler for node-list buttons AND inspector relation
   * buttons: after the inspector updates, focus moves to the corresponding
   * persistent runtime-node button so keyboard users never lose their place
   * (clicking a relation removes the focused relation button; without this,
   * focus would fall to BODY).
   *
   * Relation targets may be EXCLUDED by the active provider/layer/attention
   * filters (e.g. Container layer filter + an API→application network
   * relation). The destination must be made visible FIRST — otherwise the
   * visibility effect clears the selection and there is no row to focus —
   * then the keyed focus request is consumed once the row commits.
   */
  const selectNode = (id: string) => {
    setSelectedId(id);
    setSelectedEdge(null);
    const node = runtime?.byId.get(id);
    if (!node) return;
    if (!filteredNodes.some((n) => n.id === id)) {
      // Widen each predicate INDEPENDENTLY: only a filter that actually hides
      // the destination is reset, so a COMPATIBLE filter keeps its
      // user-chosen state (e.g. provider=docker must survive navigating to a
      // docker network). Resetting every filter would destructively discard
      // state the user never asked to clear.
      if (providerFilter !== "all" && node.provider !== providerFilter) setProviderFilter("all");
      if (layerFilter !== "all" && node.layer !== layerFilter) setLayerFilter("all");
      if (attentionOnly && !needsAttention(node.state)) setAttentionOnly(false);
    }
    setPendingFocusId(id);
  };

  return (
    <div className="screen map-screen">
      <header className="screen-head">
        <div>
          <div className="eyebrow">Provider-neutral topology</div>
          <h1 className="screen-title">Runtime Map</h1>
        </div>
        <div className="filter-row">
          <button
            type="button"
            aria-pressed={attentionOnly}
            className={`filter-chip${attentionOnly ? " is-on" : ""}`}
            onClick={() => setAttentionOnly((value) => !value)}
          >
            <Icon name="alert" size={12} /> Attention only
          </button>
          <button
            type="button"
            aria-pressed={providerFilter === "all"}
            className={`filter-chip${providerFilter === "all" ? " is-on" : ""}`}
            onClick={() => setProviderFilter("all")}
          >
            All providers
          </button>
          {runtime.providerSummary.map((bucket) => (
            <button
              key={bucket.id}
              type="button"
              aria-pressed={providerFilter === bucket.id}
              className={`filter-chip${providerFilter === bucket.id ? " is-on" : ""}`}
              onClick={() => setProviderFilter((current) => (current === bucket.id ? "all" : bucket.id))}
            >
              <Icon name={PROVIDER_ICON[bucket.id]} size={12} /> {bucket.id} ({bucket.count})
            </button>
          ))}
        </div>
      </header>

      <section className="story">
        <Metric label="Runtime nodes" value={runtime.summary.totalNodes} />
        <Metric label="Providers" value={runtime.summary.providers} />
        <Metric label="Layers" value={runtime.summary.layers} />
        <Metric
          label="Need attention"
          value={<span className={runtime.summary.attention ? "s-warning-text" : ""}>{runtime.summary.attention}</span>}
        />
        <Metric label="Diagnostics" value={runtime.summary.diagnostics} />
      </section>

      <div className="grid-2 runtime-summary-grid">
        <Panel title="Layer coverage" icon="layers" hint="Current runtime slices">
          <div className="tag-wrap">
            <button
              type="button"
              aria-pressed={layerFilter === "all"}
              className={`filter-chip${layerFilter === "all" ? " is-on" : ""}`}
              onClick={() => setLayerFilter("all")}
            >
              All layers
            </button>
            {runtime.layerSummary.map((bucket) => (
              <button
                key={bucket.id}
                type="button"
                aria-pressed={layerFilter === bucket.id}
                className={`filter-chip${layerFilter === bucket.id ? " is-on" : ""}`}
                onClick={() => setLayerFilter((current) => (current === bucket.id ? "all" : bucket.id))}
              >
                {LAYER_LABEL[bucket.id]} ({bucket.count})
              </button>
            ))}
          </div>
        </Panel>

        <Panel title="Provider diagnostics" icon="alert" hint={runtime.diagnostics.length ? "Soft failures stay visible" : "No provider warnings"}>
          {runtime.diagnostics.length === 0 ? (
            <EmptyState icon="check" title="No diagnostics" body="No diagnostics were recorded in the current snapshot." />
          ) : (
            <ul className="diag-list">
              {runtime.diagnostics.map((diagnostic, index) => (
                <li key={`${diagnostic.provider}-${index}`} className={`diag-row sev-${diagnostic.severity}`}>
                  <span className="diag-provider">
                    <Icon name={PROVIDER_ICON[diagnostic.provider]} size={13} /> {diagnostic.provider}
                  </span>
                  <span className="diag-message">{identityText(diagnostic.message, UNAVAILABLE_DIAGNOSTIC_MESSAGE)}</span>
                  <Tag tone={diagnostic.severity === "info" ? "muted" : diagnostic.severity === "warning" ? "warn" : "error"}>{diagnostic.severity}</Tag>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel
        title="Collection evidence"
        icon="history"
        hint="Collection state only — it does not describe service health"
        className="provider-state-panel"
      >
        <ul className="provider-state-list" aria-label="Provider collection evidence">
          {runtime.providerStates.map((providerState) => (
            <li key={providerState.slot} className={`provider-state-row provider-state-${providerState.state}`}>
              <div>
                <span className="provider-state-slot">{PROVIDER_SLOT_LABEL[providerState.slot]}</span>
                <span className="provider-state-freshness">{providerFreshnessText(providerState)}</span>
                {providerState.statusReason !== null ? (
                  <span className="provider-state-reason">{PROVIDER_REASON_LABEL[providerState.statusReason]}</span>
                ) : null}
              </div>
              <Tag tone={PROVIDER_STATE_TONE[providerState.state]}>{PROVIDER_STATE_LABEL[providerState.state]}</Tag>
            </li>
          ))}
        </ul>
        {evidenceMode === "demo" || evidenceMode === "mock" ? (
          <p className="provider-state-note">Sample mode: these collection states are not host evidence.</p>
        ) : null}
      </Panel>

      <div className="map-layout runtime-layout">
        <div className="stack">
          <Panel title="Runtime nodes" icon="map" hint={`${filteredNodes.length} visible`}>
            {filteredNodes.length === 0 ? (
              <EmptyState icon="search" title="No matching nodes" body="Clear one of the runtime filters to widen the view." />
            ) : (
              <ul className="runtime-node-list">
                {filteredNodes.map((node, index) => {
                  const selectable = runtime.byId.has(node.id);
                  // Duplicate runtime ids (redaction-collided) stay visible
                  // with the collision tag/hint but are never selectable.
                  const collided = runtime.idCollisions.has(node.id);
                  const content = <>
                    <span className="runtime-node-main">
                      <Icon name={PROVIDER_ICON[node.provider]} size={15} />
                      <span className="runtime-node-copy">
                        <span className={`runtime-node-label${collided ? " collision-identity" : ""}`} title={collided ? COLLISION_HINT : undefined}>{identityText(node.label, UNAVAILABLE_RUNTIME_NODE)}</span>
                        <span className="runtime-node-meta">{node.provider} · {node.type.replaceAll("_", " ")} · {LAYER_LABEL[node.layer]}</span>
                      </span>
                    </span>
                    <StatePill state={node.state} />
                    {collided && <Tag tone="warn">{COLLISION_TAG}</Tag>}
                  </>;
                  return (
                    <li key={`${node.id}-${index}`}>
                      {selectable ? <button
                        type="button"
                        className={`runtime-node-btn${selected?.id === node.id ? " is-active" : ""}`}
                        aria-pressed={selected?.id === node.id}
                        ref={(element) => {
                          if (element) nodeRefs.current.set(node.id, element);
                          else nodeRefs.current.delete(node.id);
                        }}
                        onClick={() => selectNode(node.id)}
                      >{content}</button> : <div className="runtime-node-btn runtime-node-unresolved" aria-label={`${identityText(node.label, UNAVAILABLE_RUNTIME_NODE)} is unavailable for selection${collided ? ` (${COLLISION_HINT})` : ""}`}>{content}</div>}
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </div>

        <aside className="inspector" aria-label="Runtime inspector">
          {!selected ? (
            <div className="inspector-hint">
              <h2>Provider signals, unified</h2>
              <p>Pick any runtime node to inspect its provider, layer, dependencies, diagnostics, and recorded evidence.</p>
            </div>
          ) : (
            <div className="inspector-body">
              <div className="inspector-head">
                <span className="inspector-kind">
                  <Icon name={PROVIDER_ICON[selected.provider]} size={15} /> {selected.provider}
                </span>
                <button type="button" className="icon-btn" onClick={() => { setSelectedId(null); setPendingFocusId(selected.id); }} aria-label={`Clear ${identityText(selected.label, UNAVAILABLE_RUNTIME_NODE)} runtime selection`}>
                  <Icon name="close" size={15} />
                </button>
              </div>
              <h2 className="inspector-title">{identityText(selected.label, UNAVAILABLE_RUNTIME_NODE)}</h2>
              <div className="tag-wrap">
                <StatePill state={selected.state} />
                <Tag icon="layers">{LAYER_LABEL[selected.layer]}</Tag>
                <Tag tone="muted">{selected.type.replaceAll("_", " ")}</Tag>
              </div>

              <div className="impact-band">
                <div className="impact-cell">
                  <strong>{selected.outgoing.length}</strong>
                  <span>outgoing edges</span>
                </div>
                <div className="impact-cell">
                  <strong>{selected.incoming.length}</strong>
                  <span>incoming edges</span>
                </div>
              </div>

              {selected.service && (
                <div className="inspector-section">
                  <h4>Service evidence</h4>
                  <KeyValue label="Service name" value={identityText(selected.service.name, UNAVAILABLE_SERVICE)} />
                  <KeyValue label="Reported status" value={identityText(selected.service.status, UNAVAILABLE_SERVICE_STATUS)} />
                  <KeyValue label="Health" value={selected.service.health?.message || selected.service.health?.state || "—"} />
                  <KeyValue label="Owner" value={identityText(selected.service.owner?.name, UNAVAILABLE_OWNER, "—")} />
                  <KeyValue label="Location" value={locationLabel(selected.service.location ?? null)} />
                </div>
              )}

              {selectedDetail && (
                <Link className="primary-link" to={selectedDetail.url}>
                  {selectedDetail.label} <Icon name="arrow" size={14} />
                </Link>
              )}
              {selectedImage && (
                <Link className="primary-link" to={`/images/${encodeURIComponent(selectedImage.image)}`}>
                  Open image detail <Icon name="arrow" size={14} />
                </Link>
              )}

              {selected.package && (
                <div className="inspector-section">
                  <h4>Package metadata</h4>
                  <KeyValue label="Package" value={identityText(selected.package.name, UNAVAILABLE_PACKAGE)} />
                  <KeyValue label="Manager" value={selected.package.manager} />
                  <KeyValue label="Version" value={identityText(selected.package.version, UNAVAILABLE_PACKAGE_VERSION, "—")} mono />
                  <KeyValue
                    label="Advisories"
                    value={selected.package.update === null || selected.package.update === undefined ? "not collected" : selected.package.update.advisories.length}
                  />
                </div>
              )}

              <RelationList title="Outgoing relationships" selected={selected} model={model} edges={selected.outgoing} direction="outgoing" onSelect={selectNode} onInspectEdge={(edge) => setSelectedEdge({ edge, key: runtimeEdgeKey(edge) })} selectedEdgeKey={selectedEdge?.key ?? null} />
              <RelationList title="Incoming relationships" selected={selected} model={model} edges={selected.incoming} direction="incoming" onSelect={selectNode} onInspectEdge={(edge) => setSelectedEdge({ edge, key: runtimeEdgeKey(edge) })} selectedEdgeKey={selectedEdge?.key ?? null} />

              {selectedEdge ? <RuntimeEvidenceInspector edge={selectedEdge.edge} model={model} /> : null}

              {selected.service?.logs.length ? (
                <div className="inspector-section">
                  <h4>Recent logs</h4>
                  <ul className="runtime-evidence-list">
                    {selected.service.logs.map((entry, index) => (
                      <li key={`${entry.id}-${index}`}>
                        <Tag tone="muted">{identityText(entry.source, UNAVAILABLE_LOG_SOURCE)}</Tag>
                        <span>{entry.level || "log reference"}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {selected.service?.events.length ? (
                <div className="inspector-section">
                  <h4>Recent events</h4>
                  <ul className="runtime-evidence-list">
                    {selected.service.events.map((event, index) => (
                      <li key={`${event.id}-${index}`}>
                        <Tag tone="muted">{identityText(event.kind, UNAVAILABLE_EVENT_KIND)}</Tag>
                        <span>{event.message || "event recorded"}</span>
                        {event.timestamp ? <span className="runtime-evidence-time">{formatRelative(event.timestamp)}</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {Object.keys(selected.metadata).length > 0 && (
                <div className="inspector-section">
                  <h4>Metadata</h4>
                  <div className="stack runtime-meta-stack">
                    {Object.entries(selected.metadata).map(([key, value]) => (
                      <KeyValue key={key} label={key} value={formatMetadataValue(value)} mono={typeof value === "string"} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function resolveDockerDetail(model: NonNullable<ReturnType<typeof useApp>["model"]>, selected: RuntimeNodeRecord | null): { url: string; label: string } | null {
  if (!selected || selected.provider !== "docker" || selected.label === "") return null;
  if (selected.type === "container") {
    const service = model.byName.get(selected.label);
    return service ? { url: `/services/${encodeURIComponent(service.name)}`, label: "Open service detail" } : null;
  }
  if (selected.type === "docker_network") {
    const network = model.networkByName.get(selected.label);
    return network ? { url: `/networks/${encodeURIComponent(network.name)}`, label: "Open network detail" } : null;
  }
  if (selected.type === "docker_volume") {
    const volume = model.volumeByName.get(selected.label);
    return volume ? { url: `/volumes/${encodeURIComponent(volume.name)}`, label: "Open volume detail" } : null;
  }
  return null;
}

function RelationList({
  title,
  selected,
  model,
  edges,
  direction,
  onSelect,
  onInspectEdge,
  selectedEdgeKey
}: {
  title: string;
  selected: RuntimeNodeRecord;
  model: NonNullable<ReturnType<typeof useApp>["model"]>;
  edges: RuntimeNodeRecord["incoming"];
  direction: "incoming" | "outgoing";
  onSelect: (id: string) => void;
  onInspectEdge: (edge: RuntimeMapEdge) => void;
  selectedEdgeKey: string | null;
}) {
  return (
    <div className="inspector-section">
      <h4>{title}</h4>
      {edges.length === 0 ? (
        <p className="muted-line">No {direction} relationships in the current snapshot.</p>
      ) : (
        <ul className="runtime-edge-list">
          {edges.map((edge, index) => {
            const edgeKey = runtimeEdgeKey(edge);
            const targetId = direction === "outgoing" ? edge.target : edge.source;
            const node = model.runtime.byId.get(targetId);
            if (!node) {
              const collided = model.runtime.idCollisions.has(targetId);
              return (
                <li key={`${edge.relationship}-${index}`} className="runtime-edge-row">
                  <Tag tone="muted">{edge.relationship.replaceAll("_", " ")}</Tag>
                  <span className={collided ? "collision-identity" : undefined} title={collided ? COLLISION_HINT : undefined}>{identityText(targetId, UNAVAILABLE_RUNTIME_ID)}</span>
                  {collided && <Tag tone="warn">{COLLISION_TAG}</Tag>}
                  <button type="button" className={`runtime-edge-evidence${selectedEdgeKey === edgeKey ? " is-active" : ""}`} aria-pressed={selectedEdgeKey === edgeKey} onClick={() => onInspectEdge(edge)}>
                    Inspect evidence
                  </button>
                </li>
              );
            }

            return (
              <li key={`${selected.id}-${direction}-${index}`} className="runtime-edge-row">
                <button type="button" className="runtime-edge-target" onClick={() => onSelect(node.id)}>
                  <Icon name={PROVIDER_ICON[node.provider]} size={13} />
                  <span>{identityText(node.label, UNAVAILABLE_RUNTIME_NODE)}</span>
                </button>
                <Tag tone="muted">{edge.relationship.replaceAll("_", " ")}</Tag>
                <button type="button" className={`runtime-edge-evidence${selectedEdgeKey === edgeKey ? " is-active" : ""}`} aria-pressed={selectedEdgeKey === edgeKey} onClick={() => onInspectEdge(edge)}>
                  Inspect evidence
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function RuntimeEvidenceInspector({
  edge,
  model
}: {
  edge: RuntimeMapEdge;
  model: NonNullable<ReturnType<typeof useApp>["model"]>;
}) {
  const source = model.runtime.byId.get(edge.source);
  const target = model.runtime.byId.get(edge.target);
  const relationship = edge.relationship.replaceAll("_", " ");

  return (
    <div className="inspector-section runtime-edge-evidence-inspector" aria-live="polite">
      <h4>Relationship evidence</h4>
      <p className="runtime-edge-evidence-heading">
        {identityText(source?.label ?? edge.source, UNAVAILABLE_RUNTIME_ID)} <span aria-hidden="true">→</span> {identityText(target?.label ?? edge.target, UNAVAILABLE_RUNTIME_ID)}
      </p>
      <KeyValue label="Relationship" value={relationship} />
      {edge.evidenceRefs.length === 0 ? (
        <p className="muted-line">No evidence references yet — this relationship family is still migrating.</p>
      ) : (
        <ul className="runtime-evidence-list" aria-label="Relationship evidence references">
          {edge.evidenceRefs.map((evidence) => <RuntimeEvidenceReference key={evidence.id} evidence={evidence} />)}
        </ul>
      )}
    </div>
  );
}

function RuntimeEvidenceReference({ evidence }: { evidence: RuntimeEvidenceRef }) {
  return (
    <li className="runtime-evidence-reference">
      <div className="runtime-evidence-reference-head">
        <Tag tone="muted">{ASSERTION_KIND_LABEL[evidence.assertionKind]}</Tag>
        <Tag tone="muted">{evidence.kind.replaceAll("_", " ")}</Tag>
        <span className="runtime-evidence-time">{formatRelative(evidence.collectedAt)}</span>
      </div>
      <p>{identityText(evidence.summary, "Evidence summary unavailable")}</p>
      <div className="runtime-evidence-reference-details">
        <KeyValue label="Provider" value={evidence.provider} />
        <KeyValue label="Subject" value={identityText(evidence.subjectRef, UNAVAILABLE_RUNTIME_ID)} mono />
        <KeyValue label="Freshness" value={FRESHNESS_LABEL[evidence.freshness]} />
        <KeyValue label="Provider revision" value={identityText(evidence.providerRevision, "Unavailable")} mono />
      </div>
    </li>
  );
}

function locationLabel(location: RuntimeLocation | null): string {
  if (!location) return "—";
  return `${identityText(location.kind, UNAVAILABLE_LOCATION_KIND)}: ${identityText(location.value, UNAVAILABLE_LOCATION_VALUE)}`;
}

function formatMetadataValue(value: string | number | boolean | null) {
  if (value === null) return "null";
  if (value === "") return UNAVAILABLE_METADATA_VALUE;
  return String(value);
}
