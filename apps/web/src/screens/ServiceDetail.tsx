import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { LogsResponse } from "@dockermap/contracts";
import { useApp } from "../context";
import { useApiResource } from "../hooks/useApiResource";
import { computeImpact, type Service } from "../lib/model";
import { resourceFor, STUB_NOTICE } from "../lib/stubs";
import { formatKbps, formatMb, formatPercent, formatRelative } from "../lib/format";
import Icon, { KIND_ICON } from "../components/Icon";
import ServiceMap from "../components/ServiceMap";
import { Bar, EmptyState, ErrorState, KeyValue, Loading, Metric, Panel, Sparkline, StatePill, StateDot, Tag } from "../components/primitives";

type Tab = "overview" | "dependencies" | "resources" | "logs" | "config";
const TABS: { id: Tab; label: string; icon: Parameters<typeof Icon>[0]["name"] }[] = [
  { id: "overview", label: "Overview", icon: "service" },
  { id: "dependencies", label: "Dependencies", icon: "link" },
  { id: "resources", label: "Resources", icon: "cpu" },
  { id: "logs", label: "Logs", icon: "logs" },
  { id: "config", label: "Configuration", icon: "layers" }
];

export default function ServiceDetail() {
  const { name = "" } = useParams();
  const { model, loading, error, tick } = useApp();
  const [tab, setTab] = useState<Tab>("overview");
  const [showInternals, setShowInternals] = useState(false);

  const service = useMemo(() => model?.byName.get(name) ?? null, [model, name]);

  if (loading && !model) return <Loading label={`Loading ${name}…`} />;
  if (error && !model) return <ErrorState title="Service unavailable" body={error} />;
  if (!model || !service) {
    return (
      <EmptyState
        icon="search"
        title="Service not found"
        body={`No service named "${name}" is on the current map.`}
        action={
          <Link className="primary-link" to="/map">
            Back to Service Map
          </Link>
        }
      />
    );
  }

  const impact = computeImpact(model, service.id);

  return (
    <div className="screen">
      <header className="screen-head detail-head">
        <div className="detail-id">
          <span className="detail-kind">
            <Icon name={KIND_ICON[service.kind]} size={18} />
          </span>
          <div>
            <div className="eyebrow">{service.role}</div>
            <h1 className="screen-title">{service.name}</h1>
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
          <span>affected if it fails</span>
        </div>
        <div className="impact-cell">
          <strong>{impact.upstream.length}</strong>
          <span>dependencies</span>
        </div>
        <div className="impact-cell">
          <strong>{service.ports.length}</strong>
          <span>published ports</span>
        </div>
        <div className="impact-cell">
          <strong>{service.updateAvailable ? "Yes" : "No"}</strong>
          <span>update available</span>
        </div>
      </div>

      <nav className="tabs" aria-label="Service sections">
        {TABS.map((t) => (
          <button key={t.id} type="button" className={`tab${tab === t.id ? " is-on" : ""}`} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} size={14} /> {t.label}
          </button>
        ))}
      </nav>

      {tab === "overview" && <Overview service={service} model={model} />}
      {tab === "dependencies" && <Dependencies service={service} model={model} />}
      {tab === "resources" && <Resources service={service} />}
      {tab === "logs" && <Logs name={service.name} tick={tick} />}
      {tab === "config" && (
        <Config service={service} showInternals={showInternals} onToggleInternals={() => setShowInternals((v) => !v)} />
      )}
    </div>
  );
}

function Overview({ service, model }: { service: Service; model: NonNullable<ReturnType<typeof useApp>["model"]> }) {
  return (
    <div className="grid-2">
      <Panel title="At a glance" icon="service">
        <KeyValue label="State" value={<StatePill state={service.state} />} />
        <KeyValue label="Raw status" value={service.status} mono />
        <KeyValue label="Image" value={`${service.imageRepo}:${service.imageTag}`} mono />
        <KeyValue label="Role" value={service.role} />
        <KeyValue label="Networks" value={service.networks.join(", ") || "—"} />
      </Panel>
      <Panel title="Relationships" icon="link" actions={<Link className="ghost-link" to="/map">Trace</Link>}>
        <ServiceMap model={model} selectedId={service.id} onSelect={() => {}} interactive={false} height={240} />
      </Panel>
    </div>
  );
}

function Dependencies({ service, model }: { service: Service; model: NonNullable<ReturnType<typeof useApp>["model"]> }) {
  return (
    <div className="grid-2">
      <Panel title="Depends on" icon="up" hint="Upstream">
        <RelList model={model} ids={service.dependsOn} empty="This service depends on nothing." />
      </Panel>
      <Panel title="Used by" icon="down" hint="Downstream">
        <RelList model={model} ids={service.dependents} empty="Nothing depends on this service." />
      </Panel>
    </div>
  );
}

function RelList({ model, ids, empty }: { model: NonNullable<ReturnType<typeof useApp>["model"]>; ids: string[]; empty: string }) {
  if (ids.length === 0) return <p className="muted-line">{empty}</p>;
  return (
    <ul className="svc-list">
      {ids.map((id) => {
        const svc = model.byId.get(id);
        if (!svc) return null;
        return (
          <li key={id} className="svc-row">
            <Icon name={KIND_ICON[svc.kind]} size={15} />
            <Link className="svc-name" to={`/services/${encodeURIComponent(svc.name)}`}>
              {svc.name}
            </Link>
            <StatePill state={svc.state} />
          </li>
        );
      })}
    </ul>
  );
}

function Resources({ service }: { service: Service }) {
  const res = resourceFor(service);
  return (
    <Panel title="Resources" icon="cpu" hint={STUB_NOTICE}>
      <div className="res-grid">
        <div className="res-cell">
          <Metric label="CPU" value={formatPercent(res.cpuPercent)} />
          <Sparkline data={res.cpuSeries} state={service.state} />
        </div>
        <div className="res-cell">
          <Metric label="Memory" value={formatMb(res.memoryMb)} sub={formatPercent(res.memoryPercent)} />
          <Bar value={res.memoryPercent} state={service.state} />
        </div>
        <div className="res-cell">
          <Metric label="Network" value={formatKbps(res.networkKbps)} />
          <Icon name="network" size={18} />
        </div>
      </div>
    </Panel>
  );
}

function Logs({ name, tick }: { name: string; tick: number }) {
  const logs = useApiResource<LogsResponse>(`/api/logs?service=${encodeURIComponent(name)}`, tick);
  if (logs.loading && !logs.data) return <Loading label="Loading logs…" />;
  if (logs.error) return <ErrorState title="Logs unavailable" body={logs.error} />;
  const entries = logs.data?.entries ?? [];
  if (entries.length === 0) return <EmptyState icon="logs" title="No logs" body="No recent log output for this service." />;
  return (
    <Panel title="Recent output" icon="logs">
      <ul className="log-stream">
        {entries.map((entry) => (
          <li key={entry.id} className={`log-line lvl-${entry.level}`}>
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
  showInternals,
  onToggleInternals
}: {
  service: Service;
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
            {service.mounts.map((m) => (
              <li key={m.id} className="mount-row">
                <Tag tone="muted">{m.kind.replace("_", " ")}</Tag>
                <code>{m.source ?? "anonymous"}</code>
                <Icon name="arrow" size={13} />
                <code>{m.target}</code>
                {m.readOnly && <Tag tone="warn">read-only</Tag>}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Networking" icon="network">
        <div className="tag-wrap">
          {service.networks.map((n) => (
            <Tag key={n} icon="network">
              {n}
            </Tag>
          ))}
          {service.ports.map((p) => (
            <Tag key={p} icon="link" tone="accent">
              {p}
            </Tag>
          ))}
        </div>
      </Panel>

      <Panel
        title="Docker internals"
        icon="layers"
        hint="Layer 4 — shown on request"
        actions={
          <button type="button" className="ghost-link" onClick={onToggleInternals}>
            {showInternals ? "Hide" : "Show"} <Icon name={showInternals ? "up" : "down"} size={13} />
          </button>
        }
      >
        {showInternals ? (
          <>
            <KeyValue label="Container ID" value={service.id} mono />
            <KeyValue label="Image reference" value={service.image} mono />
            <KeyValue label="Raw status" value={service.status} mono />
            <KeyValue label="Port bindings" value={service.ports.join(", ") || "none"} mono />
          </>
        ) : (
          <p className="muted-line">Container IDs, raw image refs and port bindings are hidden until you ask for them.</p>
        )}
      </Panel>
    </div>
  );
}
