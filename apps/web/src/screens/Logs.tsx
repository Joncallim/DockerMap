import { useState } from "react";
import type { LogsResponse } from "@dockermap/contracts";
import { useApp } from "../context";
import { useApiResource } from "../hooks/useApiResource";
import { formatRelative } from "../lib/format";
import { EmptyState, ErrorState, Loading, Panel } from "../components/primitives";

export default function Logs() {
  const { model, tick } = useApp();
  const [service, setService] = useState("");
  const path = service ? `/api/logs?service=${encodeURIComponent(service)}` : "/api/logs";
  const logs = useApiResource<LogsResponse>(path, tick);

  const entries = logs.data?.entries ?? [];

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <div className="eyebrow">Output stream</div>
          <h1 className="screen-title">Logs</h1>
        </div>
        <select className="service-select" value={service} onChange={(e) => setService(e.target.value)} aria-label="Filter by service">
          <option value="">All services</option>
          {model?.services.map((s) => (
            <option key={s.id} value={s.name}>
              {s.name}
            </option>
          ))}
        </select>
      </header>

      <Panel title="Recent output" icon="logs" hint={service || "all services"}>
        {logs.loading && !logs.data ? (
          <Loading label="Hydrating log stream…" />
        ) : logs.error ? (
          <ErrorState title="Logs unavailable" body={logs.error} />
        ) : entries.length === 0 ? (
          <EmptyState icon="logs" title="No logs" body="No recent output for this selection." />
        ) : (
          <ul className="log-stream">
            {entries.map((entry) => (
              <li key={entry.id} className={`log-line lvl-${entry.level}`}>
                <span className="log-time">{formatRelative(entry.timestamp)}</span>
                <span className="log-svc">{entry.container}</span>
                <span className="log-lvl">{entry.level}</span>
                <span className="log-msg">{entry.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
