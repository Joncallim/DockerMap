import { Fragment, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useApp } from "../context";
import { computeImpact, needsAttention, SERVICE_STATES, type ServiceState } from "../lib/model";
import Icon, { KIND_ICON } from "../components/Icon";
import ServiceMap from "../components/ServiceMap";
import { EmptyState, ErrorState, KeyValue, Loading, StatePill, StateDot, Tag } from "../components/primitives";
import { IdentityRef } from "../components/identity";
import { COLLISION_HINT, COLLISION_TAG, identityText, UNAVAILABLE_IMAGE, UNAVAILABLE_NETWORK, UNAVAILABLE_PORT, UNAVAILABLE_SERVICE, UNAVAILABLE_VOLUME } from "../lib/identity";

export default function MapScreen({ initialSelectedId = null }: { initialSelectedId?: string | null }) {
  const { model, loading, error } = useApp();
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<ServiceState | "attention" | null>(null);

  const filter = useMemo(() => {
    if (!stateFilter) return undefined;
    if (stateFilter === "attention") return (s: { state: ServiceState }) => needsAttention(s.state);
    return (s: { state: ServiceState }) => s.state === stateFilter;
  }, [stateFilter]);

  useEffect(() => {
    if (!model || !selectedId) return;
    const visible = filter ? model.services.filter(filter) : model.services;
    if (!visible.some((service) => service.id === selectedId && model.byId.has(service.id))) setSelectedId(null);
  }, [filter, model, selectedId]);

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
          <button type="button" aria-pressed={stateFilter === null} className={`filter-chip${stateFilter === null ? " is-on" : ""}`} onClick={() => setStateFilter(null)}>
            All
          </button>
          <button
            type="button"
            aria-pressed={stateFilter === "attention"}
            className={`filter-chip${stateFilter === "attention" ? " is-on" : ""}`}
            onClick={() => setStateFilter((f) => (f === "attention" ? null : "attention"))}
          >
            <Icon name="alert" size={12} /> Attention
          </button>
          {SERVICE_STATES.filter((s) => presentStates.has(s)).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={stateFilter === s}
              className={`filter-chip${stateFilter === s ? " is-on" : ""}`}
              onClick={() => setStateFilter((f) => (f === s ? null : s))}
            >
              <StateDot state={s} decorative /> {s}
            </button>
          ))}
        </div>
      </header>

      <div className="map-layout">
        <div className="map-stage">
          <ServiceMap model={model} selectedId={selectedId} onSelect={setSelectedId} filter={filter} focusNodeId={focusNodeId} />
        </div>

        <aside className="inspector" aria-label="Service inspector">
          {!selected ? (
            <div className="inspector-hint">
              <h2>The graph is the product</h2>
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
                <button type="button" className="icon-btn" onClick={() => { setFocusNodeId(selected.id); setSelectedId(null); }} aria-label={`Clear ${identityText(selected.name, UNAVAILABLE_SERVICE)} service selection`}>
                  <Icon name="close" size={15} />
                </button>
              </div>
              <h2 className="inspector-title">{identityText(selected.name, UNAVAILABLE_SERVICE)}</h2>
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
                    {selected.ports.map((p, index) => (
                      <Tag key={`${p}-${index}`} icon="link">
                        {p === "" ? UNAVAILABLE_PORT : p}
                      </Tag>
                    ))}
                  </div>
                </div>
              )}

              <KeyValue label="Image" value={<IdentityRef name={selected.image} fallback={UNAVAILABLE_IMAGE} to={model.imageByRef.has(selected.image) ? `/images/${encodeURIComponent(selected.image)}` : undefined} className="entity-detail-link" />} mono />
              {selected.networks.length > 0 && <div className="inspector-section"><h4>Networks</h4><div className="tag-wrap">{selected.networks.map((network, index) => model.networkByName.has(network) ? <Link key={`${network}-${index}`} className="ref-chip" to={`/networks/${encodeURIComponent(network)}`}>{network}</Link> : <Tag key={`${network}-${index}`} icon="network"><IdentityRef name={network} fallback={UNAVAILABLE_NETWORK} /></Tag>)}</div></div>}
              {selected.mounts.some((mount) => mount.kind === "named_volume") && (
                <div className="inspector-section">
                  <h4>Named volumes</h4>
                  <div className="tag-wrap">
                    {selected.mounts.map((mount, index) => {
                      if (mount.kind !== "named_volume") return null;
                      // Occurrence-qualified keys keep duplicate/empty mount ids
                      // distinct. A source links only when it resolves to exactly
                      // one volume record; collided (excluded from volumeByName),
                      // unresolved, and empty sources stay VISIBLE as non-routable
                      // evidence — "Unavailable volume name" for "", "anonymous"
                      // for null, plus the collision hint/tag when the source is a
                      // collided redacted identity.
                      const source = mount.source;
                      const routable = source !== null && source !== "" && model.volumeByName.has(source);
                      const collided = source !== null && source !== "" && model.volumeNameCollisions.has(source);
                      return routable ? (
                        <Link key={`${mount.id}-${index}`} className="ref-chip" to={`/volumes/${encodeURIComponent(source)}`}>{source}</Link>
                      ) : (
                        <Fragment key={`${mount.id}-${index}`}>
                          <Tag icon="storage">
                            {collided ? (
                              <span className="collision-identity" title={COLLISION_HINT}>{source}</span>
                            ) : (
                              <span>{source === "" ? UNAVAILABLE_VOLUME : source ?? "anonymous"}</span>
                            )}
                          </Tag>
                          {collided && <Tag tone="warn">{COLLISION_TAG}</Tag>}
                        </Fragment>
                      );
                    })}
                  </div>
                </div>
              )}
              {model.byName.has(selected.name) ? <Link className="primary-link" to={`/services/${encodeURIComponent(selected.name)}`}>
                Open service detail <Icon name="arrow" size={14} />
              </Link> : <p className="muted-line">Service detail is unavailable for this ambiguous identity.</p>}
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
          {ids.map((id, index) => {
            const svc = model.byId.get(id);
            if (!svc) return null;
            return (
              <li key={`${id}-${index}`}>
                <StateDot state={svc.state} />
                {model.byName.has(svc.name) ? <Link to={`/services/${encodeURIComponent(svc.name)}`}>{identityText(svc.name, UNAVAILABLE_SERVICE)}</Link> : <span>{identityText(svc.name, UNAVAILABLE_SERVICE)}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
