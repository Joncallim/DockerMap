import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useApp } from "../context";
import { needsAttention, summarize, type Service } from "../lib/model";
import { changeFeed, causalChain } from "../lib/stubs";
import { formatRelative } from "../lib/format";
import { evidenceLabel } from "../lib/evidence";
import { CAUSAL_CHAIN_CLAIM, CHANGE_HISTORY_CLAIM, SAMPLE_EMPTY_TITLE } from "../lib/history";
import { identityText, UNAVAILABLE_SERVICE } from "../lib/identity";
import Icon, { KIND_ICON } from "../components/Icon";
import ServiceMap from "../components/ServiceMap";
import { Bar, EmptyState, ErrorState, Loading, Metric, Panel, StatePill, Tag } from "../components/primitives";
import { resourceFor } from "../lib/stubs";
import { UPDATE_STATUS_CLAIM, UPDATE_STATUS_LABEL } from "../lib/updates";

export default function Home() {
  const { model, modelProvenance, loading, error, evidenceMode } = useApp();
  const history = useMemo(
    () => (model ? changeFeed(model, evidenceMode, modelProvenance) : CHANGE_HISTORY_CLAIM),
    [model, evidenceMode, modelProvenance]
  );
  const chain = useMemo(
    () => (model ? causalChain(model, evidenceMode, modelProvenance) : CAUSAL_CHAIN_CLAIM),
    [model, evidenceMode, modelProvenance]
  );

  if (loading && !model) return <Loading label="Building your system story…" />;
  if (error && !model) return <ErrorState title="System unavailable" body={error} />;
  if (!model) return <EmptyState icon="home" title="No services yet" body="Connect a Docker host to start mapping your infrastructure." />;

  const summary = summarize(model);
  const attention = model.services.filter((service) => needsAttention(service.state)).sort(byState);
  const changes = history.kind === "unavailable" ? [] : history.value.slice(0, 6);

  return <div className="screen">
    <header className="screen-head"><div><div className="eyebrow">System story</div><h1 className="screen-title">Command Center</h1></div><Link className="ghost-link" to="/map">Open Service Map <Icon name="arrow" size={14} /></Link></header>
    <section className="story">
      <Metric label="Services" value={summary.total} />
      <Metric label="Healthy" value={<span className="s-healthy-text">{summary.healthy}</span>} />
      <Metric label="Need attention" value={<span className={summary.attention ? "s-warning-text" : ""}>{summary.attention}</span>} />
      <Metric label="Offline" value={<span className={summary.offline ? "s-offline-text" : ""}>{summary.offline}</span>} />
      <Metric className="metric-updates" label="Updates" value={UPDATE_STATUS_LABEL} sub={UPDATE_STATUS_CLAIM.detail} />
    </section>
    <div className="grid-2"><div className="stack">
      <Panel title="Needs attention" icon="alert" hint={`${attention.length} of ${summary.total}`}>
        {attention.length === 0 ? <EmptyState icon="check" title="Everything is healthy" body="No services require attention right now." /> : <ul className="svc-list">{attention.map((service, index) => <ServiceRow key={`${service.id}-${index}`} model={model} service={service} />)}</ul>}
      </Panel>
      {chain.kind === "unavailable" ? <Panel className="panel-causal-chain" title="What happened" icon="pulse" hint={evidenceLabel(chain.kind).label}><EmptyState icon="pulse" title={evidenceLabel(chain.kind).label} body={chain.detail} /></Panel> : chain.value.length > 0 ? <Panel className="panel-causal-chain" title="What happened" icon="pulse" hint={evidenceLabel(chain.kind).label}><ol className="chain">{chain.value.map((step, index) => <li key={index} className={`chain-step tone-${step.tone}`}><span className="chain-dot" aria-hidden="true" />{step.text}</li>)}</ol></Panel> : null}
    </div><div className="stack">
      <Panel title="Service Map" icon="map" actions={<Link className="ghost-link" to="/map">Expand</Link>}><ServiceMap model={model} selectedId={null} onSelect={() => {}} interactive={false} height={260} /></Panel>
      <Panel title="Runtime Signals" icon="layers" hint={`${model.runtime.summary.providers} providers · ${model.runtime.summary.diagnostics} diagnostics`} actions={<Link className="ghost-link" to="/runtime">Open Runtime Map</Link>}><div className="impact-band"><div className="impact-cell"><strong>{model.runtime.summary.totalNodes}</strong><span>runtime nodes</span></div><div className="impact-cell"><strong>{model.runtime.summary.attention}</strong><span>need attention</span></div></div><div className="tag-wrap">{model.runtime.providerSummary.slice(0, 6).map((bucket) => <Tag key={bucket.id} tone={bucket.attention ? "warn" : "muted"}>{bucket.id} {bucket.count}</Tag>)}</div></Panel>
      <Panel className="panel-recent-change" title="Recent change" icon="history" hint={evidenceLabel(history.kind).label}>
        {history.kind === "unavailable" ? <EmptyState icon="history" title={evidenceLabel(history.kind).label} body={history.detail} /> : changes.length === 0 ? <EmptyState icon="history" title={SAMPLE_EMPTY_TITLE} body="The sample topology has no recent change events right now." /> : <ul className="feed">{changes.map((change, index) => <li key={`${change.id}-${index}`} className="feed-row"><span className={`feed-kind k-${change.kind}`}>{change.kind}</span>{change.routeName !== null ? <Link className="feed-text" to={`/services/${encodeURIComponent(change.routeName)}`}>{change.summary}</Link> : <span className="feed-text">{change.summary}</span>}<span className="feed-time">{formatRelative(change.at)}</span></li>)}</ul>}
      </Panel>
    </div></div>
  </div>;
}

function ServiceRow({ model, service }: { model: ReturnType<typeof useApp>["model"]; service: Service }) {
  if (!model) return null;
  const res = resourceFor(service);
  const dependents = service.dependents.length;
  return <li className="svc-row"><Icon name={KIND_ICON[service.kind]} size={16} />{model.byId.has(service.id) && model.byName.has(service.name) ? <Link className="svc-name" to={`/services/${encodeURIComponent(service.name)}`}>{identityText(service.name, UNAVAILABLE_SERVICE)}</Link> : <span className="svc-name">{identityText(service.name, UNAVAILABLE_SERVICE)}</span>}<StatePill state={service.state} /><span className="svc-meta">{dependents > 0 ? `${dependents} dependent${dependents === 1 ? "" : "s"}` : "no dependents"}</span><span className="svc-res"><Bar value={res.cpuPercent} state={service.state} /></span></li>;
}
function byState(a: Service, b: Service) { const order = { offline: 0, degraded: 1, warning: 2, updating: 3, unknown: 4, healthy: 5 }; return order[a.state] - order[b.state]; }
