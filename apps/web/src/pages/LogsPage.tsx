import type { ContainerRecord, LogsResponse } from "@dockermap/contracts";
import { useApiResource } from "../hooks/useApiResource";
import { useSearchParamState } from "../hooks/useSearchParamState";
import { formatTime } from "../utils/format";
import EmptyPanel from "../components/EmptyPanel";
import StatePanel from "../components/StatePanel";

export default function LogsPage(props: { heartbeat: number }) {
  const { searchParams, update } = useSearchParamState();
  const service = searchParams.get("service") ?? "";
  const q = searchParams.get("q") ?? "";
  const path = `/api/logs${service || q ? `?${new URLSearchParams({ ...(service ? { service } : {}), ...(q ? { q } : {}) }).toString()}` : ""}`;
  const logs = useApiResource<LogsResponse>(path, props.heartbeat);
  const containers = useApiResource<{ containers: ContainerRecord[] }>("/api/containers", props.heartbeat);

  if (logs.loading || containers.loading) {
    return <StatePanel title="Loading logs" body="Hydrating log stream and service filter options." />;
  }

  if (logs.error || containers.error || !logs.data || !containers.data) {
    return <StatePanel title="Logs unavailable" body={logs.error ?? containers.error ?? "Unknown failure"} tone="error" />;
  }

  return (
    <section className="stack">
      <div className="page-header">
        <div>
          <div className="panel-label">Log Stream</div>
          <h2>Recent output and service focus.</h2>
        </div>
        <select className="service-select" value={service} onChange={(event) => update({ service: event.target.value || null })}>
          <option value="">All services</option>
          {containers.data.containers.map((container) => (
            <option key={container.id} value={container.name}>
              {container.name}
            </option>
          ))}
        </select>
      </div>

      <section className="log-panel">
        {logs.data.entries.length === 0 ? (
          <EmptyPanel title="No logs found" body="Try another service or clear the current search." />
        ) : (
          logs.data.entries.map((entry) => (
            <div className="log-row" key={entry.id}>
              <span>{formatTime(entry.timestamp)}</span>
              <span>{entry.container}</span>
              <span>{entry.message}</span>
            </div>
          ))
        )}
      </section>
    </section>
  );
}
