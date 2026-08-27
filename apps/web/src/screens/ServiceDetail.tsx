import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useParams } from "react-router-dom";
import type { LogsResponse } from "@dockermap/contracts";
import { useApp } from "../context";
import { useApiResource } from "../hooks/useApiResource";
import { computeImpact, type DependencyOccurrence, type Service, type SystemModel } from "../lib/model";
import { resourceFor } from "../lib/stubs";
import { evidenceLabel, type EvidenceMode, type ModelProvenance } from "../lib/evidence";
import { formatKbps, formatMb, formatPercent, formatRelative } from "../lib/format";
import Icon, { KIND_ICON } from "../components/Icon";
import ServiceMap from "../components/ServiceMap";
import { IdentityRef } from "../components/identity";
import { COLLISION_HINT, COLLISION_TAG, identityText, UNAVAILABLE_CONTAINER_ID, UNAVAILABLE_IMAGE, UNAVAILABLE_MOUNT_TARGET, UNAVAILABLE_NETWORK, UNAVAILABLE_PORT, UNAVAILABLE_SERVICE, UNAVAILABLE_SERVICE_ROLE, UNAVAILABLE_SERVICE_STATUS, UNAVAILABLE_VOLUME } from "../lib/identity";
import { Bar, EmptyState, ErrorState, KeyValue, Loading, Metric, Panel, Sparkline, StatePill, StateDot, Tag } from "../components/primitives";
import { UPDATE_STATUS_LABEL } from "../lib/updates";

type Tab = "overview" | "dependencies" | "resources" | "logs" | "config";
const TABS: { id: Tab; label: string; icon: Parameters<typeof Icon>[0]["name"] }[] = [
  { id: "overview", label: "Overview", icon: "service" },
  { id: "dependencies", label: "Dependencies", icon: "link" },
  { id: "resources", label: "Resources", icon: "cpu" },
  { id: "logs", label: "Logs", icon: "logs" },
  { id: "config", label: "Configuration", icon: "layers" }
];

export default function ServiceDetail({ defaultTab = "overview", defaultOpen = false }: { defaultTab?: Tab; defaultOpen?: boolean }) {
  const { name = "" } = useParams();
  const { model, modelProvenance, loading, error, tick, evidenceMode } = useApp();
  const [tab, setTab] = useState<Tab>(defaultTab);
  const [focusedTab, setFocusedTab] = useState<Tab>(defaultTab);
  const tabRefs = useRef(new Map<Tab, HTMLButtonElement>());
  const [showInternals, setShowInternals] = useState(defaultOpen);

  const service = useMemo(() => model?.byName.get(name) ?? null, [model, name]);

  if (loading && !model) return <Loading label={`Loading ${identityText(name, UNAVAILABLE_SERVICE)}…`} />;
  if (error && !model) return <ErrorState title="Service unavailable" body={error} />;
  if (model?.serviceNameCollisions.has(name)) {
    return <div className="screen"><section className="empty"><h1>Service unavailable</h1><p>Multiple services share the identity “{identityText(name, UNAVAILABLE_SERVICE)}” after redaction, so detail routing is unavailable.</p><Link className="primary-link" to="/map">Back to Service Map</Link></section></div>;
  }
  if (!model || !service) {
    return (
      <EmptyState
        icon="search"
        title="Service not found"
        body={`No service named "${identityText(name, UNAVAILABLE_SERVICE)}" is on the current map.`}
        action={
          <Link className="primary-link" to="/map">
            Back to Service Map
          </Link>
        }
      />
    );
  }

  const impact = computeImpact(model, service.id);
  const moveFocus = (index: number) => {
    const next = TABS[(index + TABS.length) % TABS.length].id;
    setFocusedTab(next);
    tabRefs.current.get(next)?.focus();
  };
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number, id: Tab) => {
    if (event.key === "ArrowRight") { event.preventDefault(); moveFocus(index + 1); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); moveFocus(index - 1); }
    else if (event.key === "Home") { event.preventDefault(); moveFocus(0); }
    else if (event.key === "End") { event.preventDefault(); moveFocus(TABS.length - 1); }
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setTab(id); setFocusedTab(id); }
  };

  return (
    <div className="screen">
      <header className="screen-head detail-head">
        <div className="detail-id">
          <span className="detail-kind">
            <Icon name={KIND_ICON[service.kind]} size={18} />
          </span>
          <div>
            <div className="eyebrow">{identityText(service.role, UNAVAILABLE_SERVICE_ROLE)}</div>
            <h1 className="screen-title">{identityText(service.name, UNAVAILABLE_SERVICE)}</h1>
          </div>
          <StatePill state={service.state} />
        </div>
        <Link className="ghost-link" to="/map">
          <Icon name="map" size={14} /> View on map
        </Link>
      </header>

      <div className="impact-band wide">
        <div className="impact-cell">
          <strong>{impact.downstream.length}</strong>
          <span>downstream declarations</span>
        </div>
        <div className="impact-cell">
          <strong>{impact.upstream.length}</strong>
          <span>upstream declarations</span>
        </div>
        <div className="impact-cell">
          <strong>{service.ports.length}</strong>
          <span>published ports</span>
        </div>
        <div className="impact-cell impact-cell-updates">
          <strong>{UPDATE_STATUS_LABEL}</strong>
          <span>update status</span>
        </div>
      </div>

      <nav className="tabs" aria-label="Service sections" role="tablist">
        {TABS.map((item, index) => (
          <button
            key={item.id}
            ref={(element) => { if (element) tabRefs.current.set(item.id, element); }}
            id={`service-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            aria-controls="service-tabpanel"
            tabIndex={focusedTab === item.id ? 0 : -1}
            className={`tab${tab === item.id ? " is-on" : ""}`}
            onFocus={() => setFocusedTab(item.id)}
            onKeyDown={(event) => onTabKeyDown(event, index, item.id)}
            onClick={() => { setTab(item.id); setFocusedTab(item.id); }}
          >
            <Icon name={item.icon} size={14} /> {item.label}
          </button>
        ))}
      </nav>

      <div id="service-tabpanel" role="tabpanel" aria-labelledby={`service-tab-${tab}`}>
        {tab === "overview" && <Overview service={service} model={model} />}
        {tab === "dependencies" && <Dependencies service={service} model={model} />}
        {tab === "resources" && <Resources service={service} evidenceMode={evidenceMode} modelProvenance={modelProvenance} />}
        {tab === "logs" && <Logs name={service.name} tick={tick} evidenceMode={evidenceMode} modelProvenance={modelProvenance} />}
        {tab === "config" && (
          <Config service={service} model={model} showInternals={showInternals} onToggleInternals={() => setShowInternals((v) => !v)} />
        )}
      </div>
    </div>
  );
}

function Overview({ service, model }: { service: Service; model: NonNullable<ReturnType<typeof useApp>["model"]> }) {
  // Per-entry mapping preserves duplicate/empty network identities (unlike a
  // raw join, which collapses ["", "bridge1"] to ", bridge1"); the em dash is
  // reserved for a genuinely empty array.
  const networksLabel = service.networks.length === 0 ? "—" : service.networks.map((network) => (network === "" ? UNAVAILABLE_NETWORK : network)).join(", ");
  return (
    <div className="grid-2">
      <Panel title="At a glance" icon="service">
        <KeyValue label="State" value={<StatePill state={service.state} />} />
        <KeyValue label="Raw status" value={identityText(service.status, UNAVAILABLE_SERVICE_STATUS)} mono />
        <KeyValue label="Image" value={<IdentityRef name={service.image} fallback={UNAVAILABLE_IMAGE} to={model.imageByRef.has(service.image) ? `/images/${encodeURIComponent(service.image)}` : undefined} className="entity-detail-link" />} mono />
        <KeyValue label="Role" value={identityText(service.role, UNAVAILABLE_SERVICE_ROLE)} />
        <KeyValue label="Networks" value={networksLabel} />
      </Panel>
      <Panel title="Relationships" icon="link" actions={<Link className="ghost-link" to="/map">Trace</Link>}>
        {/* The route identifies this service by its UNIQUE NAME; pass the exact
            occurrence so the map highlights only it — a collided canonical id
            (duplicate container ids after redaction) must never highlight every
            record that shares the id. */}
        <ServiceMap model={model} selectedId={service.id} selectedService={service} onSelect={() => {}} interactive={false} height={240} />
      </Panel>
    </div>
  );
}

function Dependencies({ service, model }: { service: Service; model: NonNullable<ReturnType<typeof useApp>["model"]> }) {
  return (
    <div className="grid-2">
      <Panel title="Declares start order after" icon="up" hint="Recorded upstream declaration">
        <RelList model={model} occurrences={service.dependencyOccurrences} empty="No Compose start-order declaration recorded." />
      </Panel>
      <Panel title="Declared after by" icon="down" hint="Recorded downstream declaration">
        <RelList model={model} occurrences={service.dependents.map((id) => ({ ref: id, resolvedId: id }))} empty="No service declares start order after this one." />
      </Panel>
    </div>
  );
}

function RelList({ model, occurrences, empty }: { model: SystemModel; occurrences: DependencyOccurrence[]; empty: string }) {
  if (occurrences.length === 0) return <p className="muted-line">{empty}</p>;
  return (
    <ul className="svc-list">
      {occurrences.map((occurrence, index) => {
        const svc = occurrence.resolvedId ? model.byId.get(occurrence.resolvedId) : undefined;
        if (svc) {
          return (
            <li key={`${occurrence.resolvedId}-${index}`} className="svc-row">
              <Icon name={KIND_ICON[svc.kind]} size={15} />
              <IdentityRef name={svc.name} fallback={UNAVAILABLE_SERVICE} to={model.byName.has(svc.name) ? `/services/${encodeURIComponent(svc.name)}` : undefined} className="svc-name" />
              <StatePill state={svc.state} />
            </li>
          );
        }
        // Raw occurrence that could not be resolved uniquely (empty ref,
        // redaction-collided alias, or unknown reference): it stays VISIBLE
        // as non-routable evidence — never a link, never silently dropped.
        const collided = occurrence.ref !== "" && model.serviceAliasCollisions.has(occurrence.ref);
        return (
          <li key={`${occurrence.ref}-${index}`} className="svc-row">
            <span className={`svc-name${collided ? " collision-identity" : ""}`} title={collided ? COLLISION_HINT : undefined}>
              {identityText(occurrence.ref, UNAVAILABLE_SERVICE)}
            </span>
            {collided && <Tag tone="warn">{COLLISION_TAG}</Tag>}
          </li>
        );
      })}
    </ul>
  );
}

function Resources({ service, evidenceMode, modelProvenance }: { service: Service; evidenceMode: EvidenceMode | null; modelProvenance: ModelProvenance | null }) {
  const resources = resourceFor(service, evidenceMode, modelProvenance);
  return (
    <Panel className="panel-resources" title="Resources" icon="cpu" hint={evidenceLabel(resources.kind).label}>
      {resources.kind === "unavailable" ? (
        <EmptyState icon="cpu" title={evidenceLabel(resources.kind).label} body={resources.detail} />
      ) : <div className="res-grid">
        <div className="res-cell">
          <Metric label="CPU" value={formatPercent(resources.value.cpuPercent)} />
          <Sparkline data={resources.value.cpuSeries} state={service.state} />
        </div>
        <div className="res-cell">
          <Metric label="Memory" value={formatMb(resources.value.memoryMb)} sub={formatPercent(resources.value.memoryPercent)} />
          <Bar value={resources.value.memoryPercent} state={service.state} label={`Memory ${formatPercent(resources.value.memoryPercent)} — ${evidenceLabel(resources.kind).label}`} />
        </div>
        <div className="res-cell">
          <Metric label="Network" value={formatKbps(resources.value.networkKbps)} />
          <Icon name="network" size={18} />
        </div>
      </div>}
    </Panel>
  );
}

function Logs({ name, tick, evidenceMode, modelProvenance }: { name: string; tick: number; evidenceMode: ReturnType<typeof useApp>["evidenceMode"]; modelProvenance: ReturnType<typeof useApp>["modelProvenance"] }) {
  const logs = useApiResource<LogsResponse>(`/api/logs?service=${encodeURIComponent(name)}`, tick);
  const sampleLogs = evidenceMode === "demo" || (evidenceMode === "mock" && modelProvenance === "mock");
  if (logs.loading && !logs.data) return <Loading label="Loading logs…" />;
  if (logs.error) return <ErrorState title="Logs unavailable" body={logs.error} />;
  const entries = logs.data?.entries ?? [];
  if (entries.length === 0) return <EmptyState icon="logs" title="No logs" body="No recent log output for this service." />;
  return (
    <Panel title="Recent output" icon="logs">
      {sampleLogs && <Tag tone="warn" title="These log lines are fabricated sample data, not real host activity.">Sample data — not from a host</Tag>}
      <ul className="log-stream">
        {entries.map((entry, index) => (
          <li key={`${entry.id}-${index}`} className={`log-line lvl-${entry.level}`}>
            <span className="log-time">{formatRelative(entry.timestamp)}</span>
            <span className="log-lvl">{entry.level}</span>
            <span className="log-msg">{entry.message}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Config({
  service,
  model,
  showInternals,
  onToggleInternals
}: {
  service: Service;
  model: NonNullable<ReturnType<typeof useApp>["model"]>;
  showInternals: boolean;
  onToggleInternals: () => void;
}) {
  return (
    <div className="stack">
      <Panel title="Mounts" icon="storage">
        {service.mounts.length === 0 ? (
          <p className="muted-line">No volumes or bind mounts.</p>
        ) : (
          <ul className="mount-list">
            {service.mounts.map((m, index) => (
              <li key={`${m.id}-${index}`} className="mount-row">
                <Tag tone="muted">{m.kind.replace("_", " ")}</Tag>
                {m.kind === "named_volume" && m.source && model.volumeByName.has(m.source) ? <Link className="entity-detail-link" to={`/volumes/${encodeURIComponent(m.source)}`}>{m.source}</Link> : <code>{m.source === "" ? UNAVAILABLE_VOLUME : m.source ?? "anonymous"}</code>}
                <Icon name="arrow" size={13} />
                <code>{m.target === "" ? UNAVAILABLE_MOUNT_TARGET : m.target}</code>
                {m.readOnly && <Tag tone="warn">read-only</Tag>}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Networking" icon="network">
        <div className="tag-wrap">
          {service.networks.map((n, index) =>
            model.networkByName.has(n) ? <Link key={`${n}-${index}`} className="ref-chip" to={`/networks/${encodeURIComponent(n)}`}>{n}</Link> : <Tag key={`${n}-${index}`} icon="network"><IdentityRef name={n} fallback={UNAVAILABLE_NETWORK} /></Tag>
          )}
          {service.ports.map((p, index) => (
            <Tag key={`${p}-${index}`} icon="link" tone="accent">
              {p === "" ? UNAVAILABLE_PORT : p}
            </Tag>
          ))}
        </div>
      </Panel>

      <Panel
        title="Docker internals"
        icon="layers"
        hint="Layer 4 — shown on request"
        actions={
          <button type="button" className="ghost-link" aria-label={showInternals ? "Hide service internals" : "Show service internals"} aria-expanded={showInternals} aria-controls="service-internals" onClick={onToggleInternals}>
            {showInternals ? "Hide" : "Show"} <Icon name={showInternals ? "up" : "down"} size={13} />
          </button>
        }
      >
        <div id="service-internals">
          {showInternals ? (
            <>
              <KeyValue label="Container ID" value={service.id === "" ? UNAVAILABLE_CONTAINER_ID : service.id} mono />
              <KeyValue label="Image reference" value={<IdentityRef name={service.image} fallback={UNAVAILABLE_IMAGE} to={model.imageByRef.has(service.image) ? `/images/${encodeURIComponent(service.image)}` : undefined} className="entity-detail-link" />} mono />
              <KeyValue label="Raw status" value={identityText(service.status, UNAVAILABLE_SERVICE_STATUS)} mono />
              <KeyValue label="Port bindings" value={service.ports.filter((p) => p !== "").join(", ") || "none"} mono />
            </>
          ) : (
            <p className="muted-line">Container IDs, raw image refs and port bindings are hidden until you ask for them.</p>
          )}
        </div>
      </Panel>
    </div>
  );
}
