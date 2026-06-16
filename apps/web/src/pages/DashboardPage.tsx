import { Link } from "react-router-dom";
import type { DockerSnapshot, GraphResponse } from "@dockermap/contracts";
import { useApiResource } from "../hooks/useApiResource";
import GraphNodeCard from "../components/GraphNodeCard";
import KpiCard from "../components/KpiCard";
import StatePanel from "../components/StatePanel";

export default function DashboardPage(props: { heartbeat: number }) {
  const snapshot = useApiResource<DockerSnapshot>("/api/snapshot", props.heartbeat);
  const graph = useApiResource<GraphResponse>("/api/graph", props.heartbeat);

  if (snapshot.loading || graph.loading) {
    return <StatePanel title="Building topology" body="Refreshing containers, networks, volumes, and graph edges." />;
  }

  if (snapshot.error || graph.error || !snapshot.data || !graph.data) {
    return <StatePanel title="Graph unavailable" body={snapshot.error ?? graph.error ?? "Unknown failure"} tone="error" />;
  }

  return (
    <div className="page-grid">
      <section className="hero-panel">
        <div className="panel-label">Topology Canvas</div>
        <div className="graph-grid">
          {graph.data.nodes.map((node) => (
            <GraphNodeCard key={node.id} node={node} />
          ))}
        </div>
        <div className="edge-list">
          {graph.data.edges.map((edge, index) => (
            <div className="edge-row" key={`${edge.source}-${edge.target}-${index}`}>
              <span>{edge.source.replace("container_", "").replace("network_", "").replace("volume_", "")}</span>
              <span>{edge.relationship}</span>
              <span>{edge.target.replace("container_", "").replace("network_", "").replace("volume_", "")}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="kpi-grid">
        <KpiCard label="Containers" value={snapshot.data.containers.length} detail="Live runtime inventory" />
        <KpiCard label="Images" value={snapshot.data.images.length} detail="Derived image groups" />
        <KpiCard label="Networks" value={snapshot.data.networks.length} detail="Bridge and internal zones" />
        <KpiCard label="Volumes" value={snapshot.data.volumes.length} detail="Persistent state" />
      </section>

      <section className="info-panel">
        <div className="panel-label">Dependencies</div>
        {snapshot.data.containers.map((container) => (
          <div className="list-row" key={container.id}>
            <div>
              <Link className="inline-link" to={`/containers/${container.name}`}>
                {container.name}
              </Link>
              <div className="subtle-copy">{container.role}</div>
            </div>
            <div className="pill-row">
              {container.dependsOn.map((dependency) => (
                <Link
                  className="pill"
                  key={dependency}
                  to={`/containers/${dependency.replace("container_", "")}`}
                >
                  {dependency.replace("container_", "")}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
