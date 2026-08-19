import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { RuntimeProviderKind } from "@dockermap/contracts";
import { useApp } from "../context";
import { needsAttention, type RuntimeLayerId, type RuntimeNodeRecord } from "../lib/model";
import { formatRelative } from "../lib/format";
import Icon, { type IconName } from "../components/Icon";
import { EmptyState, ErrorState, KeyValue, Loading, Metric, Panel, StateDot, StatePill, Tag } from "../components/primitives";

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

export default function RuntimeScreen() {
  const { model, loading, error } = useApp();
  const [providerFilter, setProviderFilter] = useState<RuntimeProviderKind | "all">("all");
  const [layerFilter, setLayerFilter] = useState<RuntimeLayerId | "all">("all");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (loading && !model) return <Loading label="Reading runtime topology…" />;
  if (error && !model) return <ErrorState title="Runtime unavailable" body={error} />;
  if (!model) return <EmptyState icon="layers" title="No runtime map yet" body="Connect a host or enable Demo Mode to inspect runtime signals." />;

  const runtime = model.runtime;

  const filteredNodes = useMemo(() => {
    return runtime.nodes.filter((node) => {
      if (providerFilter !== "all" && node.provider !== providerFilter) return false;
      if (layerFilter !== "all" && node.layer !== layerFilter) return false;
      if (attentionOnly && !needsAttention(node.state)) return false;
      return true;
    });
  }, [attentionOnly, layerFilter, providerFilter, runtime.nodes]);

  const selected = (selectedId ? runtime.byId.get(selectedId) : null) ?? filteredNodes[0] ?? null;
  const selectedDetailUrl = selected && model.byName.has(selected.label) ? `/services/${encodeURIComponent(selected.label)}` : null;

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
            className={`filter-chip${attentionOnly ? " is-on" : ""}`}
            onClick={() => setAttentionOnly((value) => !value)}
          >
            <Icon name="alert" size={12} /> Attention only
          </button>
          <button
            type="button"
            className={`filter-chip${providerFilter === "all" ? " is-on" : ""}`}
            onClick={() => setProviderFilter("all")}
          >
            All providers
          </button>
          {runtime.providerSummary.map((bucket) => (
            <button
              key={bucket.id}
              type="button"
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
              className={`filter-chip${layerFilter === "all" ? " is-on" : ""}`}
              onClick={() => setLayerFilter("all")}
            >
              All layers
            </button>
            {runtime.layerSummary.map((bucket) => (
              <button
                key={bucket.id}
                type="button"
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
            <EmptyState icon="check" title="No diagnostics" body="Every enabled provider returned cleanly in the current snapshot." />
          ) : (
            <ul className="diag-list">
              {runtime.diagnostics.map((diagnostic, index) => (
                <li key={`${diagnostic.provider}-${index}`} className={`diag-row sev-${diagnostic.severity}`}>
                  <span className="diag-provider">
                    <Icon name={PROVIDER_ICON[diagnostic.provider]} size={13} /> {diagnostic.provider}
                  </span>
                  <span className="diag-message">{diagnostic.message}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div className="map-layout runtime-layout">
        <div className="stack">
          <Panel title="Runtime nodes" icon="map" hint={`${filteredNodes.length} visible`}>
            {filteredNodes.length === 0 ? (
              <EmptyState icon="search" title="No matching nodes" body="Clear one of the runtime filters to widen the view." />
            ) : (
              <ul className="runtime-node-list">
                {filteredNodes.map((node) => (
                  <li key={node.id}>
                    <button
                      type="button"
                      className={`runtime-node-btn${selected?.id === node.id ? " is-active" : ""}`}
                      onClick={() => setSelectedId(node.id)}
                    >
                      <span className="runtime-node-main">
                        <Icon name={PROVIDER_ICON[node.provider]} size={15} />
                        <span className="runtime-node-copy">
                          <span className="runtime-node-label">{node.label}</span>
                          <span className="runtime-node-meta">
                            {node.provider} · {node.type.replaceAll("_", " ")} · {LAYER_LABEL[node.layer]}
                          </span>
                        </span>
                      </span>
                      <StatePill state={node.state} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <aside className="inspector">
          {!selected ? (
            <div className="inspector-hint">
              <h3>Provider signals, unified</h3>
              <p>Pick any runtime node to inspect its provider, layer, dependencies, diagnostics, and recorded evidence.</p>
            </div>
          ) : (
            <div className="inspector-body">
              <div className="inspector-head">
                <span className="inspector-kind">
                  <Icon name={PROVIDER_ICON[selected.provider]} size={15} /> {selected.provider}
                </span>
                <button type="button" className="icon-btn" onClick={() => setSelectedId(null)} aria-label="Clear selection">
                  <Icon name="close" size={15} />
                </button>
              </div>
              <h2 className="inspector-title">{selected.label}</h2>
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
                  <KeyValue label="Service name" value={selected.service.name} />
                  <KeyValue label="Reported status" value={selected.service.status} />
                  <KeyValue label="Health" value={selected.service.health?.message ?? selected.service.health?.state ?? "—"} />
                  <KeyValue label="Owner" value={selected.service.owner?.name ?? "—"} />
                  <KeyValue label="Location" value={selected.service.location ? `${selected.service.location.kind}: ${selected.service.location.value}` : "—"} />
                </div>
              )}

              {selected.service?.name && (
                <Link className="primary-link" to={`/services/${encodeURIComponent(selected.service.name)}`}>
                  Open service detail <Icon name="arrow" size={14} />
                </Link>
              )}

              {selected.package && (
                <div className="inspector-section">
                  <h4>Package metadata</h4>
                  <KeyValue label="Package" value={selected.package.name} />
                  <KeyValue label="Manager" value={selected.package.manager} />
                  <KeyValue label="Version" value={selected.package.version} mono />
                  <KeyValue
                    label="Advisories"
                    value={selected.package.update?.advisories.length ? selected.package.update.advisories.length : "none"}
                  />
                </div>
              )}

              <RelationList title="Outgoing relationships" selected={selected} model={model} edges={selected.outgoing} direction="outgoing" onSelect={setSelectedId} />
              <RelationList title="Incoming relationships" selected={selected} model={model} edges={selected.incoming} direction="incoming" onSelect={setSelectedId} />

              {selected.service?.logs.length ? (
                <div className="inspector-section">
                  <h4>Recent logs</h4>
                  <ul className="runtime-evidence-list">
                    {selected.service.logs.map((entry) => (
                      <li key={entry.id}>
                        <Tag tone="muted">{entry.source}</Tag>
                        <span>{entry.level ?? "log reference"}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {selected.service?.events.length ? (
                <div className="inspector-section">
                  <h4>Recent events</h4>
                  <ul className="runtime-evidence-list">
                    {selected.service.events.map((event) => (
                      <li key={event.id}>
                        <Tag tone="muted">{event.kind}</Tag>
                        <span>{event.message ?? "event recorded"}</span>
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

              {selectedDetailUrl && (
                <Link className="primary-link" to={selectedDetailUrl}>
                  Open matching Docker service <Icon name="arrow" size={14} />
                </Link>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function RelationList({
  title,
  selected,
  model,
  edges,
  direction,
  onSelect
}: {
  title: string;
  selected: RuntimeNodeRecord;
  model: NonNullable<ReturnType<typeof useApp>["model"]>;
  edges: RuntimeNodeRecord["incoming"];
  direction: "incoming" | "outgoing";
  onSelect: (id: string) => void;
}) {
  return (
    <div className="inspector-section">
      <h4>{title}</h4>
      {edges.length === 0 ? (
        <p className="muted-line">No {direction} relationships in the current snapshot.</p>
      ) : (
        <ul className="runtime-edge-list">
          {edges.map((edge, index) => {
            const targetId = direction === "outgoing" ? edge.target : edge.source;
            const node = model.runtime.byId.get(targetId);
            if (!node) {
              return (
                <li key={`${edge.relationship}-${index}`} className="runtime-edge-row">
                  <Tag tone="muted">{edge.relationship.replaceAll("_", " ")}</Tag>
                  <span>{targetId}</span>
                </li>
              );
            }

            return (
              <li key={`${selected.id}-${direction}-${index}`} className="runtime-edge-row">
                <button type="button" className="runtime-edge-target" onClick={() => onSelect(node.id)}>
                  <Icon name={PROVIDER_ICON[node.provider]} size={13} />
                  <span>{node.label}</span>
                </button>
                <Tag tone="muted">{edge.relationship.replaceAll("_", " ")}</Tag>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function formatMetadataValue(value: string | number | boolean | null) {
  if (value === null) return "null";
  return String(value);
}
