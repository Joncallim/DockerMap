import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { Link } from "react-router-dom";
import { useApp } from "../context";
import { computeImpact, needsAttention, SERVICE_STATES, type DependencyOccurrence, type Service, type ServiceState } from "../lib/model";
import Icon, { KIND_ICON } from "../components/Icon";
import ServiceMap from "../components/ServiceMap";
import { EmptyState, ErrorState, KeyValue, Loading, Metric, StatePill, StateDot, Tag } from "../components/primitives";
import { IdentityRef } from "../components/identity";
import { COLLISION_HINT, COLLISION_TAG, identityText, UNAVAILABLE_IMAGE, UNAVAILABLE_NETWORK, UNAVAILABLE_PORT, UNAVAILABLE_SERVICE, UNAVAILABLE_VOLUME } from "../lib/identity";

export default function MapScreen({ initialSelectedId = null }: { initialSelectedId?: string | null }) {
  const { model, loading, error } = useApp();
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const [focusRequest, setFocusRequest] = useState<{ id: string; token: number } | null>(null);
  const [returnFocusId, setReturnFocusId] = useState<string | null>(null);
  const focusTokenRef = useRef(0);
  const directoryRefs = useRef(new Map<string, HTMLButtonElement>());
  const [stateFilter, setStateFilter] = useState<ServiceState | "attention" | null>(null);

  const filter = useMemo(() => {
    if (!stateFilter) return undefined;
    if (stateFilter === "attention") return (s: Service) => needsAttention(s.state);
    return (s: Service) => s.state === stateFilter;
  }, [stateFilter]);
  const visibleServices = useMemo(() => model ? (filter ? model.services.filter(filter) : model.services) : [], [filter, model]);

  useEffect(() => {
    if (!model || !selectedId) return;
    if (!visibleServices.some((service) => service.id === selectedId && model.byId.has(service.id))) setSelectedId(null);
  }, [model, selectedId, visibleServices]);

  useLayoutEffect(() => {
    if (!returnFocusId || selectedId) return;
    const button = directoryRefs.current.get(returnFocusId);
    if (!button) return;
    button.focus();
    setReturnFocusId(null);
  }, [returnFocusId, selectedId, visibleServices]);

  if (loading && !model) return <Loading label="Resolving the service map…" />;
  if (error && !model) return <ErrorState title="Map unavailable" body={error} />;
  if (!model) return <EmptyState icon="map" title="Nothing to map" body="Connect a Docker host to build the service map." />;

  const selected = selectedId ? model.byId.get(selectedId) ?? null : null;
  const impact = selected ? computeImpact(model, selected.id) : null;
  const presentStates = new Set(model.services.map((s) => s.state));
  const resolvedTopologyIds = new Set(model.relationships.flatMap((relationship) => [relationship.from, relationship.to]));
  // Count service OCCURRENCES, not canonical ids: two preserved records with
  // the same collided id each carry their own declarations, so a Set keyed by
  // service.id would undercount and then falsely report the remaining
  // occurrences as "no recorded declaration" (#84 B1).
  const recordedDeclarationCount = model.services.filter((service) => service.dependencyOccurrences.length > 0 || service.dependents.length > 0).length;
  const noRecordedDeclarationCount = model.services.length - recordedDeclarationCount;
  const selectedContextIds = selected && impact ? new Set([selected.id, ...impact.upstream, ...impact.downstream]) : null;
  const graphFilter = (service: Service) => {
    if (filter && !filter(service)) return false;
    return selectedContextIds ? selectedContextIds.has(service.id) : resolvedTopologyIds.has(service.id);
  };
  const graphEmptyMessage = stateFilter
    ? "No services match the current filter. Clear the filter to widen the view."
    : selected
      ? "DockerMap has no resolved Compose start-order relationship for this service. Any recorded unresolved declarations remain in the inspector alongside its ports, networks, and storage."
      : "DockerMap has no resolved Compose start-order declarations in this snapshot. The service directory still lists every service.";
  const selectService = (id: string | null) => {
    if (id) {
      setSelectedId(id);
      focusTokenRef.current += 1;
      setFocusRequest({ id, token: focusTokenRef.current });
    } else {
      // Toggle-off (mouse click or Enter/Space on an already-selected graph
      // node): restore focus to the service's directory entry so keyboard
      // navigation is never dropped on body after the node unmounts.
      setReturnFocusId(selectedId);
      setSelectedId(null);
    }
  };

  return (
    <div className="screen map-screen">
      <header className="screen-head">
        <div>
          <div className="eyebrow">Evidence-backed topology</div>
          <h1 className="screen-title">Service Map</h1>
        </div>
        <div className="filter-row">
          <button type="button" aria-pressed={stateFilter === null} className={`filter-chip${stateFilter === null ? " is-on" : ""}`} onClick={() => setStateFilter(null)}>All</button>
          <button type="button" aria-pressed={stateFilter === "attention"} className={`filter-chip${stateFilter === "attention" ? " is-on" : ""}`} onClick={() => setStateFilter((f) => (f === "attention" ? null : "attention"))}><Icon name="alert" size={12} /> Attention</button>
          {SERVICE_STATES.filter((s) => presentStates.has(s)).map((s) => (
            <button key={s} type="button" aria-pressed={stateFilter === s} className={`filter-chip${stateFilter === s ? " is-on" : ""}`} onClick={() => setStateFilter((f) => (f === s ? null : s))}><StateDot state={s} decorative /> {s}</button>
          ))}
        </div>
      </header>

      <section className="story map-coverage" aria-label="Service map coverage">
        <Metric label="Services in this snapshot" value={model.services.length} />
        <Metric label="Resolved start-order links" value={model.relationships.length} />
        <Metric label="Services with recorded declarations" value={recordedDeclarationCount} />
        <Metric label="No recorded declaration" value={noRecordedDeclarationCount} />
      </section>

      <div className="map-layout">
        <div className="stack">
          <section className="map-evidence-note" aria-live="polite">
            <Icon name="layers" size={15} />
            <span>The graph shows Compose start-order declarations in the current snapshot. Shared networks and storage are context, not proof of communication or causality.</span>
          </section>
          <div className="map-stage">
            <ServiceMap model={model} selectedId={selectedId} onSelect={selectService} filter={graphFilter} focusNodeId={focusRequest?.id ?? null} focusToken={focusRequest?.token} emptyMessage={graphEmptyMessage} />
          </div>
        </div>

        <aside className="inspector" aria-label="Service inspector" aria-live="polite" aria-atomic="true">
          {!selected ? (
            <div className="inspector-body">
              <h2>Select a service to inspect</h2>
              <p className="muted-line">The directory contains every service in this snapshot. Select one to see declared start order, derived reachability, and network and storage context.</p>
              <ServiceDirectory model={model} services={visibleServices} selectedId={selectedId} onSelect={selectService} buttonRefs={directoryRefs} />
            </div>
          ) : (
            <div className="inspector-body">
              <div className="inspector-head">
                <span className="inspector-kind"><Icon name={KIND_ICON[selected.kind]} size={15} /> {selected.kind} (inferred)</span>
                <button type="button" className="icon-btn" onClick={() => { setReturnFocusId(selected.id); setSelectedId(null); }} aria-label={`Clear ${identityText(selected.name, UNAVAILABLE_SERVICE)} service selection`}><Icon name="close" size={15} /></button>
              </div>
              <h2 className="inspector-title">{identityText(selected.name, UNAVAILABLE_SERVICE)}</h2>
              <StatePill state={selected.state} />
              <div className="impact-band">
                <div className="impact-cell"><strong>{impact?.downstream.length ?? 0}</strong><span>downstream declarations</span></div>
                <div className="impact-cell"><strong>{impact?.upstream.length ?? 0}</strong><span>upstream declarations</span></div>
              </div>
              <p className="muted-line">Derived from resolved Compose start-order declarations; it does not predict runtime failure impact.</p>
              <Relist title="Declares start order after" model={model} occurrences={selected.dependencyOccurrences} empty="No Compose start-order declaration recorded" />
              <Relist title="Declared after by" model={model} occurrences={selected.dependents.map((id) => ({ ref: id, resolvedId: id }))} empty="No service declares start order after this one" />
              {selected.ports.length > 0 && <div className="inspector-section"><h4>Ports</h4><div className="tag-wrap">{selected.ports.map((p, index) => <Tag key={`${p}-${index}`} icon="link">{p === "" ? UNAVAILABLE_PORT : p}</Tag>)}</div></div>}
              <KeyValue label="Image" value={<IdentityRef name={selected.image} fallback={UNAVAILABLE_IMAGE} to={model.imageByRef.has(selected.image) ? `/images/${encodeURIComponent(selected.image)}` : undefined} className="entity-detail-link" />} mono />
              {selected.networks.length > 0 && <div className="inspector-section"><h4>Docker networks</h4><p className="muted-line">Membership can allow communication; it does not prove communication.</p><div className="tag-wrap">{selected.networks.map((network, index) => model.networkByName.has(network) ? <Link key={`${network}-${index}`} className="ref-chip" to={`/networks/${encodeURIComponent(network)}`}>{network}</Link> : <Tag key={`${network}-${index}`} icon="network"><IdentityRef name={network} fallback={UNAVAILABLE_NETWORK} /></Tag>)}</div></div>}
              {selected.mounts.some((mount) => mount.kind === "named_volume") && <NamedVolumes model={model} service={selected} />}
              {model.byName.has(selected.name) ? <Link className="primary-link" to={`/services/${encodeURIComponent(selected.name)}`}>Open service detail <Icon name="arrow" size={14} /></Link> : <p className="muted-line">Service detail is unavailable for this ambiguous identity.</p>}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function ServiceDirectory({ model, services, selectedId, onSelect, buttonRefs }: { model: ReturnType<typeof useApp>["model"]; services: Service[]; selectedId: string | null; onSelect: (id: string | null) => void; buttonRefs: MutableRefObject<Map<string, HTMLButtonElement>> }) {
  if (!model) return null;
  return <div className="inspector-section"><h3>Service directory ({services.length})</h3>{services.length === 0 ? <EmptyState icon="search" title="No matching services" body="Clear a filter to see every service." /> : <ul className="runtime-node-list service-directory">{services.map((service, index) => {
    const collided = model.serviceIdCollisions.has(service.id) || model.serviceNameCollisions.has(service.name);
    const selectable = !collided && model.byId.has(service.id);
    const content = <><span className="runtime-node-main"><Icon name={KIND_ICON[service.kind]} size={15} /><span className="runtime-node-copy"><span className={`runtime-node-label${collided ? " collision-identity" : ""}`} title={collided ? COLLISION_HINT : undefined}>{identityText(service.name, UNAVAILABLE_SERVICE)}</span><span className="runtime-node-meta">{service.kind} · inferred{service.dependencyOccurrences.length || service.dependents.length ? " · recorded start order" : " · no recorded start order"}</span></span></span><StatePill state={service.state} />{collided && <Tag tone="warn">{COLLISION_TAG}</Tag>}</>;
    return <li key={`${service.id}-${index}`}>{selectable ? <button type="button" aria-label={`${identityText(service.name, UNAVAILABLE_SERVICE)}, ${service.state}`} ref={(element) => { if (element) buttonRefs.current.set(service.id, element); else buttonRefs.current.delete(service.id); }} className={`runtime-node-btn${selectedId === service.id ? " is-active" : ""}`} aria-pressed={selectedId === service.id} onClick={() => onSelect(service.id)}>{content}</button> : <div className="runtime-node-btn runtime-node-unresolved" aria-label={`${identityText(service.name, UNAVAILABLE_SERVICE)} is unavailable for selection${collided ? ` (${COLLISION_HINT})` : ""}`}>{content}</div>}</li>;
  })}</ul>}</div>;
}

function NamedVolumes({ model, service }: { model: NonNullable<ReturnType<typeof useApp>["model"]>; service: Service }) {
  return <div className="inspector-section"><h4>Observed named volumes</h4><p className="muted-line">Mounting the same volume does not establish data direction or a service dependency.</p><div className="tag-wrap">{service.mounts.map((mount, index) => {
    if (mount.kind !== "named_volume") return null;
    const source = mount.source ?? null;
    const routable = source !== null && source !== "" && model.volumeByName.has(source);
    const collided = source !== null && source !== "" && model.volumeNameCollisions.has(source);
    return routable ? <Link key={`${mount.id}-${index}`} className="ref-chip" to={`/volumes/${encodeURIComponent(source)}`}>{source}</Link> : <Fragment key={`${mount.id}-${index}`}><Tag icon="storage">{collided ? <span className="collision-identity" title={COLLISION_HINT}>{source}</span> : <span>{source === "" ? UNAVAILABLE_VOLUME : source ?? "anonymous"}</span>}</Tag>{collided && <Tag tone="warn">{COLLISION_TAG}</Tag>}</Fragment>;
  })}</div></div>;
}

function Relist({ title, model, occurrences, empty }: { title: string; model: ReturnType<typeof useApp>["model"]; occurrences: DependencyOccurrence[]; empty: string }) {
  if (!model) return null;
  return <div className="inspector-section"><h4>{title}</h4>{occurrences.length === 0 ? <p className="muted-line">{empty}</p> : <ul className="rel-list">{occurrences.map((occurrence, index) => {
    const svc = occurrence.resolvedId ? model.byId.get(occurrence.resolvedId) : undefined;
    if (svc) return <li key={`${occurrence.resolvedId}-${index}`}><StateDot state={svc.state} />{model.byName.has(svc.name) ? <Link to={`/services/${encodeURIComponent(svc.name)}`}>{identityText(svc.name, UNAVAILABLE_SERVICE)}</Link> : <span>{identityText(svc.name, UNAVAILABLE_SERVICE)}</span>}</li>;
    const collided = occurrence.ref !== "" && model.serviceAliasCollisions.has(occurrence.ref);
    return <li key={`${occurrence.ref}-${index}`}><span className={collided ? "collision-identity" : undefined} title={collided ? COLLISION_HINT : undefined}>{identityText(occurrence.ref, UNAVAILABLE_SERVICE)}</span>{collided && <Tag tone="warn">{COLLISION_TAG}</Tag>}</li>;
  })}</ul>}</div>;
}
