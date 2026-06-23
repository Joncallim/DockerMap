import type { ComposeScan } from "@dockermap/contracts";
import { useApp } from "../context";
import { useApiResource } from "../hooks/useApiResource";
import Icon from "../components/Icon";
import { EmptyState, ErrorState, Loading, Panel, Tag } from "../components/primitives";

const STATUS_TONE = { matched: "accent", missing: "warn", extra: "muted" } as const;

export default function Compose() {
  const { tick } = useApp();
  const scan = useApiResource<ComposeScan>("/api/compose/scan", tick);

  if (scan.loading && !scan.data) return <Loading label="Scanning Compose definitions…" />;
  if (scan.error) return <ErrorState title="Compose unavailable" body={scan.error} />;

  const data = scan.data;
  const services = data?.services ?? [];
  const correlations = data?.correlations ?? [];
  const diagnostics = data?.diagnostics ?? [];
  const unavailable = services.length === 0 && correlations.length === 0;

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <div className="eyebrow">Declared vs running</div>
          <h1 className="screen-title">Compose</h1>
        </div>
        {data && <span className="muted-line">{data.files.length} file{data.files.length === 1 ? "" : "s"}</span>}
      </header>

      {diagnostics.length > 0 && (
        <Panel title="Diagnostics" icon="alert">
          <ul className="diag-list">
            {diagnostics.map((d) => (
              <li key={d.id} className={`diag-row sev-${d.severity}`}>
                <Icon name="alert" size={13} /> {d.message}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {unavailable ? (
        <EmptyState
          icon="compose"
          title="No Compose project scanned"
          body="Compose scanning needs the Rust daemon and a Compose file. Connect a Docker host with a project to see declared-vs-running drift."
        />
      ) : (
        <div className="grid-2">
          <Panel title="Services" icon="layers" hint={`${services.length}`}>
            <ul className="svc-list">
              {services.map((s) => (
                <li key={s.name} className="svc-row">
                  <Icon name="service" size={15} />
                  <span className="svc-name">{s.name}</span>
                  {s.image && <Tag tone="muted">{s.image}</Tag>}
                  {s.dependsOn.length > 0 && <span className="svc-meta">depends on {s.dependsOn.join(", ")}</span>}
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Mount drift" icon="storage" hint="declared vs running">
            {correlations.length === 0 ? (
              <p className="muted-line">No mount correlations found.</p>
            ) : (
              <ul className="mount-list">
                {correlations.map((c) => (
                  <li key={c.id} className="mount-row">
                    <Tag tone={STATUS_TONE[c.status]}>{c.status}</Tag>
                    <span className="svc-meta">{c.service}</span>
                    <code>{c.declaredSource ?? c.runtimeSource ?? "—"}</code>
                    <Icon name="arrow" size={13} />
                    <code>{c.target}</code>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
