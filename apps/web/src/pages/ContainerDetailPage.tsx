import { Link, useParams } from "react-router-dom";
import type { ContainerRecord, LogsResponse } from "@dockermap/contracts";
import { useApiResource } from "../hooks/useApiResource";
import { formatTime } from "../utils/format";
import EmptyPanel from "../components/EmptyPanel";
import InfoCard from "../components/InfoCard";
import StatePanel from "../components/StatePanel";

export default function ContainerDetailPage(props: { heartbeat: number }) {
  const params = useParams();
  const detail = useApiResource<ContainerRecord>(`/api/containers/${params.name ?? ""}`, props.heartbeat);
  const logs = useApiResource<LogsResponse>(`/api/logs?service=${params.name ?? ""}`, props.heartbeat);

  if (detail.loading) {
    return <StatePanel title="Loading container detail" body="Resolving container relationships and logs." />;
  }

  if (detail.error || !detail.data) {
    return <StatePanel title="Container not found" body={detail.error ?? "Unknown failure"} tone="error" />;
  }

  const container = detail.data;

  return (
    <section className="stack">
      <div className="page-header">
        <div>
          <div className="panel-label">Service Detail</div>
          <h2>{container.name}</h2>
          <p className="subtle-copy">{container.role}</p>
        </div>
        <div className="pill-row">
          <Link className="ghost-button small" to="/containers">
            Back to containers
          </Link>
          <Link className="ghost-button small" to={`/logs?service=${container.name}`}>
            Full logs
          </Link>
        </div>
      </div>

      <div className="detail-grid">
        <InfoCard title="Image" value={container.image} />
        <InfoCard title="Status" value={container.status} />
        <InfoCard title="Ports" value={container.ports.join(", ") || "None"} />
      </div>

      <section className="info-panel">
        <div className="panel-label">Networks and dependencies</div>
        <div className="pill-row">
          {container.networks.map((networkId) => (
            <Link key={networkId} className="pill" to={`/networks?network=${networkId}`}>
              {networkId.replace("network_", "")}
            </Link>
          ))}
          {container.dependsOn.map((dependency) => (
            <Link key={dependency} className="pill" to={`/containers/${dependency.replace("container_", "")}`}>
              {dependency.replace("container_", "")}
            </Link>
          ))}
        </div>
      </section>

      <section className="log-panel">
        <div className="panel-label">Recent logs</div>
        {logs.loading ? (
          <div className="subtle-copy">Loading log tail...</div>
        ) : logs.data && logs.data.entries.length > 0 ? (
          logs.data.entries.slice(0, 8).map((entry) => (
            <div className="log-row" key={entry.id}>
              <span>{formatTime(entry.timestamp)}</span>
              <span>{entry.level}</span>
              <span>{entry.message}</span>
            </div>
          ))
        ) : (
          <EmptyPanel title="No recent logs" body="This container is not emitting log lines right now." />
        )}
      </section>
    </section>
  );
}
