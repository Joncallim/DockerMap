import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useApp } from "../context";
import { computeImpact, needsAttention, SERVICE_STATES, type ServiceState } from "../lib/model";
import Icon, { KIND_ICON } from "../components/Icon";
import ServiceMap from "../components/ServiceMap";
import { EmptyState, ErrorState, KeyValue, Loading, StatePill, StateDot, Tag } from "../components/primitives";

export default function MapScreen() {
  const { model, loading, error } = useApp();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<ServiceState | "attention" | null>(null);

  const filter = useMemo(() => {
    if (!stateFilter) return undefined;
    if (stateFilter === "attention") return (s: { state: ServiceState }) => needsAttention(s.state);
    return (s: { state: ServiceState }) => s.state === stateFilter;
  }, [stateFilter]);

  if (loading && !model) return <Loading label="Resolving the service map…" />;
  if (error && !model) return <ErrorState title="Map unavailable" body={error} />;
  if (!model) return <EmptyState icon="map" title="Nothing to map" body="Connect a Docker host to build the service map." />;

  const selected = selectedId ? model.byId.get(selectedId) ?? null : null;
  const impact = selected ? computeImpact(model, selected.id) : null;
  const presentStates = new Set(model.services.map((s) => s.state));

  return (
    <div className="screen map-screen">
      <header className="screen-head">
        <div>
          <div className="eyebrow">Relationships</div>
          <h1 className="screen-title">Service Map</h1>
        </div>
        <div className="filter-row">
          <button type="button" className={`filter-chip${stateFilter === null ? " is-on" : ""}`} onClick={() => setStateFilter(null)}>
            All
          </button>
          <button
            type="button"
            className={`filter-chip${stateFilter === "attention" ? " is-on" : ""}`}
            onClick={() => setStateFilter((f) => (f === "attention" ? null : "attention"))}
          >
            <Icon name="alert" size={12} /> Attention
          </button>
          {SERVICE_STATES.filter((s) => presentStates.has(s)).map((s) => (
            <button
              key={s}
              type="button"
              className={`filter-chip${stateFilter === s ? " is-on" : ""}`}
              onClick={() => setStateFilter((f) => (f === s ? null : s))}
            >
              <StateDot state={s} /> {s}
            </button>
          ))}
        </div>
      </header>

      <div className="map-layout">
        <div className="map-stage">
          <ServiceMap model={model} selectedId={selectedId} onSelect={setSelectedId} filter={filter} />
        </div>

        <aside className="inspector">
          {!selected ? (
            <div className="inspector-hint">
              <h3>The graph is the product</h3>
              <p>Select any service to trace what it depends on and what would break if it failed.</p>
              <ul className="hint-list">
                <li>
                  <StateDot state="offline" /> Offline services break their dependents
                </li>
                <li>
                  <Icon name="target" size={14} /> Impact radius highlights instantly
                </li>
                <li>
                  <Icon name="search" size={14} /> Press ⌘K to jump to a service
                </li>
              </ul>
            </div>
          ) : (
            <div className="inspector-body">
              <div className="inspector-head">
                <span className="inspector-kind">
                  <Icon name={KIND_ICON[selected.kind]} size={15} /> {selected.kind}
                </span>
                <button type="button" className="icon-btn" onClick={() => setSelectedId(null)} aria-label="Clear selection">
                  <Icon name="close" size={15} />
                </button>
              </div>
              <h2 className="inspector-title">{selected.name}</h2>
              <StatePill state={selected.state} />

              <div className="impact-band">
                <div className="impact-cell">
                  <strong>{impact?.downstream.length ?? 0}</strong>
                  <span>affected if it fails</span>
                </div>
                <div className="impact-cell">
                  <strong>{impact?.upstream.length ?? 0}</strong>
                  <span>dependencies</span>
                </div>
              </div>

              <Relist title="Depends on" model={model} ids={selected.dependsOn} empty="Depends on nothing" />
              <Relist title="Used by" model={model} ids={selected.dependents} empty="Nothing depends on this" />

              {selected.ports.length > 0 && (
                <div className="inspector-section">
                  <h4>Ports</h4>
                  <div className="tag-wrap">
                    {selected.ports.map((p) => (
                      <Tag key={p} icon="link">
                        {p}
                      </Tag>
                    ))}
                  </div>
                </div>
              )}

              <KeyValue label="Image" value={`${selected.imageRepo}:${selected.imageTag}`} mono />
              <Link className="primary-link" to={`/services/${encodeURIComponent(selected.name)}`}>
                Open service detail <Icon name="arrow" size={14} />
              </Link>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function Relist({
  title,
  model,
  ids,
  empty
}: {
  title: string;
  model: ReturnType<typeof useApp>["model"];
  ids: string[];
  empty: string;
}) {
  if (!model) return null;
  return (
    <div className="inspector-section">
      <h4>{title}</h4>
      {ids.length === 0 ? (
        <p className="muted-line">{empty}</p>
      ) : (
        <ul className="rel-list">
          {ids.map((id) => {
            const svc = model.byId.get(id);
            if (!svc) return null;
            return (
              <li key={id}>
                <StateDot state={svc.state} />
                <Link to={`/services/${encodeURIComponent(svc.name)}`}>{svc.name}</Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
