import type { ComposeScan } from "@dockermap/contracts";
import { useApp } from "../context";
import { useApiResource } from "../hooks/useApiResource";
import Icon from "../components/Icon";
import { EmptyState, ErrorState, Loading, Panel, Tag } from "../components/primitives";
import { identityText, UNAVAILABLE_COMPOSE_SERVICE, UNAVAILABLE_COMPOSE_SOURCE, UNAVAILABLE_COMPOSE_TARGET, UNAVAILABLE_DIAGNOSTIC_FILE, UNAVAILABLE_DIAGNOSTIC_MESSAGE } from "../lib/identity";

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
  // A real scan is evidenced by scanned files; an empty service/correlation
  // result from a real scan is NOT "no project scanned" (#76).
  const noSourceScanned = !data || data.files.length === 0;
  const emptyScan = data && data.files.length > 0 && services.length === 0 && correlations.length === 0;

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
            {diagnostics.map((diagnostic, index) => (
              <li key={`${diagnostic.id}-${index}`} className={`diag-row sev-${diagnostic.severity}`}>
                <Icon name="alert" size={13} />
                <span className="diag-message">{identityText(diagnostic.message, UNAVAILABLE_DIAGNOSTIC_MESSAGE)}</span>
                <Tag tone={diagnostic.severity === "info" ? "muted" : diagnostic.severity === "warning" ? "warn" : "error"}>{diagnostic.severity}</Tag>
                <Tag tone="muted">Compose · {identityText(diagnostic.origin.file, UNAVAILABLE_DIAGNOSTIC_FILE)}</Tag>
                {diagnostic.origin.service !== null && <Tag tone="muted">{identityText(diagnostic.origin.service, UNAVAILABLE_COMPOSE_SERVICE)}</Tag>}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {noSourceScanned ? (
        <EmptyState
          icon="compose"
          title="No Compose project scanned"
          body="Compose scanning needs the Rust daemon and a Compose file. Connect a Docker host with a project to see declared-vs-running drift."
        />
      ) : emptyScan ? (
        <EmptyState
          icon="compose"
          title="No Compose services found"
          body="The scanned Compose files define no services or correlations to compare against the running host."
        />
      ) : (
        <div className="grid-2">
          <Panel title="Services" icon="layers" hint={`${services.length}`}>
            <ul className="svc-list">
              {services.map((service, index) => (
                <li key={`${service.name}-${index}`} className="svc-row">
                  <Icon name="service" size={15} />
                  <span className="svc-name">{identityText(service.name, UNAVAILABLE_COMPOSE_SERVICE)}</span>
                  {service.image !== null && <Tag tone="muted">{identityText(service.image, UNAVAILABLE_COMPOSE_SOURCE)}</Tag>}
                  {service.dependsOn.length > 0 && <span className="svc-meta">declares start order after {service.dependsOn.map((dependency) => identityText(dependency, UNAVAILABLE_COMPOSE_SERVICE)).join(", ")}</span>}
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Mount drift" icon="storage" hint="declared vs running">
            {correlations.length === 0 ? (
              <p className="muted-line">No mount correlations found.</p>
            ) : (
              <ul className="mount-list">
                {correlations.map((correlation, index) => (
                  <li key={`${correlation.id}-${index}`} className="mount-row">
                    <Tag tone={STATUS_TONE[correlation.status]}>{correlation.status}</Tag>
                    <span className="svc-meta">{identityText(correlation.service, UNAVAILABLE_COMPOSE_SERVICE)}</span>
                    <code>{identityText(correlation.declaredSource ?? correlation.runtimeSource, UNAVAILABLE_COMPOSE_SOURCE)}</code>
                    <Icon name="arrow" size={13} />
                    <code>{identityText(correlation.target, UNAVAILABLE_COMPOSE_TARGET)}</code>
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
