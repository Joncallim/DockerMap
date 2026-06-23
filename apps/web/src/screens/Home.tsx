import { Link } from "react-router-dom";
import { useApp } from "../context";
import { needsAttention, summarize, type Service } from "../lib/model";
import { changeFeed, causalChain, STUB_CHANGES_NOTICE } from "../lib/stubs";
import { formatRelative } from "../lib/format";
import Icon, { KIND_ICON } from "../components/Icon";
import ServiceMap from "../components/ServiceMap";
import { Bar, EmptyState, ErrorState, Loading, Metric, Panel, StatePill, StateDot, Tag } from "../components/primitives";
import { resourceFor } from "../lib/stubs";

export default function Home() {
  const { model, loading, error } = useApp();

  if (loading && !model) return <Loading label="Building your system story…" />;
  if (error && !model) return <ErrorState title="System unavailable" body={error} />;
  if (!model) return <EmptyState icon="home" title="No services yet" body="Connect a Docker host to start mapping your infrastructure." />;

  const summary = summarize(model);
  const attention = model.services.filter((s) => needsAttention(s.state)).sort(byState);
  const updates = model.services.filter((s) => s.updateAvailable);
  const changes = changeFeed(model).slice(0, 6);
  const chain = causalChain(model);

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <div className="eyebrow">System story</div>
          <h1 className="screen-title">Command Center</h1>
        </div>
        <Link className="ghost-link" to="/map">
          Open Service Map <Icon name="arrow" size={14} />
        </Link>
      </header>

      <section className="story">
        <Metric label="Services" value={summary.total} />
        <Metric label="Healthy" value={<span className="s-healthy-text">{summary.healthy}</span>} />
        <Metric
          label="Need attention"
          value={<span className={summary.attention ? "s-warning-text" : ""}>{summary.attention}</span>}
        />
        <Metric label="Offline" value={<span className={summary.offline ? "s-offline-text" : ""}>{summary.offline}</span>} />
        <Metric label="Updates" value={summary.updatesAvailable} />
      </section>

      <div className="grid-2">
        <div className="stack">
          <Panel title="Needs attention" icon="alert" hint={`${attention.length} of ${summary.total}`}>
            {attention.length === 0 ? (
              <EmptyState icon="check" title="Everything is healthy" body="No services require attention right now." />
            ) : (
              <ul className="svc-list">
                {attention.map((s) => (
                  <ServiceRow key={s.id} model={model} service={s} />
                ))}
              </ul>
            )}
          </Panel>

          {chain && (
            <Panel title="What happened" icon="pulse" hint="Causal chain">
              <ol className="chain">
                {chain.map((step, i) => (
                  <li key={i} className={`chain-step tone-${step.tone}`}>
                    <span className="chain-dot" aria-hidden="true" />
                    {step.text}
                  </li>
                ))}
              </ol>
            </Panel>
          )}
        </div>

        <div className="stack">
          <Panel
            title="Service Map"
            icon="map"
            actions={
              <Link className="ghost-link" to="/map">
                Expand
              </Link>
            }
          >
            <ServiceMap model={model} selectedId={null} onSelect={() => {}} interactive={false} height={260} />
          </Panel>

          <Panel title="Recent change" icon="history" hint={STUB_CHANGES_NOTICE}>
            {changes.length === 0 ? (
              <EmptyState icon="history" title="No recent change" body="Deployments and restarts will appear here." />
            ) : (
              <ul className="feed">
                {changes.map((c) => (
                  <li key={c.id} className="feed-row">
                    <span className={`feed-kind k-${c.kind}`}>{c.kind.replace("_", " ")}</span>
                    <Link className="feed-text" to={`/services/${encodeURIComponent(c.serviceName)}`}>
                      {c.summary}
                    </Link>
                    <span className="feed-time">{formatRelative(c.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {updates.length > 0 && (
            <Panel title="Updates available" icon="up" hint={`${updates.length}`}>
              <ul className="svc-list">
                {updates.map((s) => (
                  <li key={s.id} className="svc-row">
                    <StateDot state={s.state} />
                    <Link className="svc-name" to={`/services/${encodeURIComponent(s.name)}`}>
                      {s.name}
                    </Link>
                    <Tag tone="accent" icon="image">
                      {s.imageRepo}:{s.imageTag}
                    </Tag>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

function ServiceRow({ model, service }: { model: ReturnType<typeof useApp>["model"]; service: Service }) {
  if (!model) return null;
  const res = resourceFor(service);
  const dependents = service.dependents.length;
  return (
    <li className="svc-row">
      <Icon name={KIND_ICON[service.kind]} size={16} />
      <Link className="svc-name" to={`/services/${encodeURIComponent(service.name)}`}>
        {service.name}
      </Link>
      <StatePill state={service.state} />
      <span className="svc-meta">{dependents > 0 ? `${dependents} dependent${dependents === 1 ? "" : "s"}` : "no dependents"}</span>
      <span className="svc-res">
        <Bar value={res.cpuPercent} state={service.state} />
      </span>
    </li>
  );
}

function byState(a: Service, b: Service) {
  const order = { offline: 0, degraded: 1, warning: 2, updating: 3, unknown: 4, healthy: 5 };
  return order[a.state] - order[b.state];
}
