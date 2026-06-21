import { Link, useNavigate } from "react-router-dom";
import type { DockerSnapshot, GraphResponse } from "@dockermap/contracts";
import { useApiResource } from "../hooks/useApiResource";
import NetworkScene from "../components/NetworkScene";
import Icon from "../components/Icon";
import { Badge, Kpi, SectionCard, StateView, StatusDot } from "../components/ui";
import type { SceneNode } from "../lib/topology";

const ACCENT = { container: "#5fe3d1", network: "#f3c06a", volume: "#f0937a" };

export default function DashboardPage(props: { heartbeat: number }) {
  const navigate = useNavigate();
  const snapshot = useApiResource<DockerSnapshot>("/api/snapshot", props.heartbeat);
  const graph = useApiResource<GraphResponse>("/api/graph", props.heartbeat);

  if (snapshot.loading || graph.loading) {
    return <StateView kind="loading" title="Building topology" body="Resolving containers, networks, volumes and graph edges." icon="orbit" />;
  }
  if (snapshot.error || graph.error || !snapshot.data || !graph.data) {
    return <StateView kind="error" title="Graph unavailable" body={snapshot.error ?? graph.error ?? "Unknown failure"} />;
  }

  const s = snapshot.data;
  const running = s.containers.filter((c) => c.status.toLowerCase() === "running").length;
  const stopped = s.containers.length - running;
  const internalNets = s.networks.filter((n) => n.internal).length;
  const attachedVolumes = s.volumes.filter((v) => v.attachedTo.length > 0).length;

  const onSelect = (node: SceneNode) => {
    if (node.type === "container") navigate(`/containers/${node.label}`);
    else if (node.type === "network") navigate(`/networks?network=${node.id}`);
    else navigate(`/volumes?volume=${node.id}`);
  };

  return (
    <div className="dashboard">
      <SectionCard
        flush
        eyebrow="Topology · Observe mode"
        title="Network architecture"
        icon="orbit"
        actions={
          <Badge tone="aqua" icon="pulse">
            {graph.data.nodes.length} nodes · {graph.data.edges.length} links
          </Badge>
        }
        className="scene-card"
      >
        <NetworkScene graph={graph.data} height={480} onSelect={onSelect} />
      </SectionCard>

      <div className="kpi-row">
        <Kpi
          icon="container"
          label="Containers"
          value={s.containers.length}
          accent="aqua"
          segments={[
            { color: "var(--ok)", value: running, label: "running" },
            { color: "var(--err)", value: stopped, label: "stopped" },
          ]}
        />
        <Kpi icon="image" label="Images" value={s.images.length} accent="gold" sub="Distinct image lineages in use" />
        <Kpi
          icon="network"
          label="Networks"
          value={s.networks.length}
          accent="aqua"
          segments={[
            { color: "var(--aqua)", value: s.networks.length - internalNets, label: "bridge" },
            { color: "var(--gold)", value: internalNets, label: "internal" },
          ]}
        />
        <Kpi
          icon="volume"
          label="Volumes"
          value={s.volumes.length}
          accent="gold"
          segments={[
            { color: "var(--ok)", value: attachedVolumes, label: "attached" },
            { color: "var(--muted)", value: s.volumes.length - attachedVolumes, label: "idle" },
          ]}
        />
      </div>

      <div className="dashboard-cols">
        <SectionCard eyebrow="Service graph" title="Dependency flow" icon="link">
          <div className="flow-list">
            {s.containers.map((c) => (
              <div className="flow-row" key={c.id}>
                <div className="flow-node">
                  <StatusDot status={c.status} pulse={c.status.toLowerCase() === "running"} />
                  <Link className="flow-name" to={`/containers/${c.name}`}>
                    {c.name}
                  </Link>
                  <span className="flow-role">{c.role}</span>
                </div>
                <div className="flow-deps">
                  {c.dependsOn.length === 0 ? (
                    <span className="flow-empty">no upstreams</span>
                  ) : (
                    c.dependsOn.map((d) => (
                      <Link className="chip" key={d} to={`/containers/${d.replace("container_", "")}`}>
                        <Icon name="arrow" size={12} />
                        {d.replace("container_", "")}
                      </Link>
                    ))
                  )}
                </div>
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard eyebrow="Segmentation" title="Networks at a glance" icon="network">
          <div className="mini-list">
            {s.networks.map((n) => (
              <Link className="mini-row" key={n.id} to={`/networks?network=${n.id}`}>
                <div className="mini-main">
                  <span className="mini-name">{n.name}</span>
                  <span className="mini-sub">{n.driver}</span>
                </div>
                <div className="mini-end">
                  <Badge tone={n.internal ? "gold" : "aqua"}>{n.internal ? "internal" : "bridge"}</Badge>
                  <span className="mini-count">{n.members.length} members</span>
                </div>
              </Link>
            ))}
          </div>

          <div className="legend-foot">
            {(["container", "network", "volume"] as const).map((t) => (
              <span key={t}>
                <i style={{ background: ACCENT[t] }} />
                {t}
              </span>
            ))}
          </div>
        </SectionCard>
      </div>
    </div>
  );
}
