import { useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { ContainerRecord, GraphResponse, LogsResponse } from "@dockermap/contracts";
import { useApiResource } from "../hooks/useApiResource";
import { formatTime } from "../utils/format";
import NetworkScene from "../components/NetworkScene";
import Icon from "../components/Icon";
import { Badge, MetaItem, SectionCard, StateView, StatusDot, toneForStatus } from "../components/ui";
import type { SceneNode } from "../lib/topology";

function neighborhood(c: ContainerRecord): GraphResponse {
  const nodes: GraphResponse["nodes"] = [{ id: c.id, type: "container", label: c.name }];
  const edges: GraphResponse["edges"] = [];
  for (const n of c.networks) {
    nodes.push({ id: n, type: "network", label: n.replace("network_", "") });
    edges.push({ source: c.id, target: n, relationship: "connected_to" });
  }
  for (const m of c.mounts) {
    if (m.source) {
      const id = `volume_${m.source}`;
      if (!nodes.some((x) => x.id === id)) nodes.push({ id, type: "volume", label: m.source });
      edges.push({ source: c.id, target: id, relationship: "mounts" });
    }
  }
  for (const d of c.dependsOn) {
    const id = d.startsWith("container_") ? d : `container_${d}`;
    nodes.push({ id, type: "container", label: d.replace("container_", "") });
    edges.push({ source: c.id, target: id, relationship: "connected_to" });
  }
  return { nodes, edges };
}

export default function ContainerDetailPage(props: { heartbeat: number }) {
  const params = useParams();
  const navigate = useNavigate();
  const detail = useApiResource<ContainerRecord>(`/api/containers/${params.name ?? ""}`, props.heartbeat);
  const logs = useApiResource<LogsResponse>(`/api/logs?service=${params.name ?? ""}`, props.heartbeat);

  const container = detail.data;
  const graph = useMemo(() => (container ? neighborhood(container) : null), [container]);

  if (detail.loading) {
    return <StateView kind="loading" title="Loading container" body="Resolving container relationships and logs." icon="container" />;
  }
  if (detail.error || !container || !graph) {
    return <StateView kind="error" title="Container not found" body={detail.error ?? "Unknown failure"} />;
  }

  const onSelect = (node: SceneNode) => {
    if (node.id === container.id) return;
    if (node.type === "container") navigate(`/containers/${node.label}`);
    else if (node.type === "network") navigate(`/networks?network=${node.id}`);
    else navigate(`/volumes?volume=${node.id}`);
  };

  return (
    <section className="stack">
      <div className="detail-header">
        <div className="detail-id">
          <Link className="back-link" to="/containers">
            <Icon name="chevron" size={14} style={{ transform: "rotate(180deg)" }} />
            Containers
          </Link>
          <h1 className="page-title">{container.name}</h1>
          <p className="page-subtitle">{container.role}</p>
        </div>
        <div className="detail-status">
          <span className="status-text status-lg">
            <StatusDot status={container.status} pulse={container.status.toLowerCase() === "running"} />
            <span className={`status-${toneForStatus(container.status)}`}>{container.status}</span>
          </span>
          <Link className="btn btn-ghost btn-sm" to={`/logs?service=${container.name}`}>
            <Icon name="logs" size={15} />
            Full logs
          </Link>
        </div>
      </div>

      <div className="detail-grid">
        <SectionCard flush eyebrow="Connectivity" title="Service neighborhood" icon="orbit" className="scene-card">
          <NetworkScene graph={graph} height={360} onSelect={onSelect} />
        </SectionCard>

        <SectionCard eyebrow="Facts" title="Runtime" icon="container">
          <div className="meta-grid">
            <MetaItem label="Image" value={container.image} mono />
            <MetaItem label="Status" value={container.status} />
            <MetaItem label="Ports" value={container.ports.length ? container.ports.join(", ") : "none"} mono />
            <MetaItem label="Networks" value={container.networks.length} />
            <MetaItem label="Mounts" value={container.mounts.length} />
            <MetaItem label="Depends on" value={container.dependsOn.length || "—"} />
          </div>
          <div className="chip-row chip-row-spaced">
            {container.networks.map((n) => (
              <Link className="chip" key={n} to={`/networks?network=${n}`}>
                <Icon name="network" size={12} />
                {n.replace("network_", "")}
              </Link>
            ))}
            {container.dependsOn.map((d) => (
              <Link className="chip" key={d} to={`/containers/${d.replace("container_", "")}`}>
                <Icon name="arrow" size={12} />
                {d.replace("container_", "")}
              </Link>
            ))}
          </div>
        </SectionCard>
      </div>

      <SectionCard eyebrow="Persistence" title="Mounts" icon="volume">
        {container.mounts.length === 0 ? (
          <StateView kind="empty" title="No mounts" body="This container has no bind or volume mounts." icon="volume" />
        ) : (
          <div className="mounts">
            <div className="mounts-head">
              <span>Source</span>
              <span>Target</span>
              <span>Kind</span>
            </div>
            {container.mounts.map((m) => (
              <div className="mounts-row" key={m.id}>
                <code className="path">{m.source ?? "anonymous"}</code>
                <code className="path path-target">{m.target}</code>
                <div className="mounts-tags">
                  <Badge tone={m.kind === "bind" ? "aqua" : "gold"}>{m.kind.replace("_", " ")}</Badge>
                  {m.readOnly && <Badge tone="warn">read-only</Badge>}
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard eyebrow="Output" title="Recent logs" icon="logs">
        {logs.loading ? (
          <p className="cell-sub">Loading log tail…</p>
        ) : logs.data && logs.data.entries.length > 0 ? (
          <div className="logstream logstream-compact">
            {logs.data.entries.slice(0, 10).map((e) => (
              <div className={`logline log-${e.level}`} key={e.id}>
                <time>{formatTime(e.timestamp)}</time>
                <span className="log-level">{e.level}</span>
                <span className="log-msg">{e.message}</span>
              </div>
            ))}
          </div>
        ) : (
          <StateView kind="empty" title="No recent logs" body="This container is not emitting log lines right now." icon="logs" />
        )}
      </SectionCard>
    </section>
  );
}
