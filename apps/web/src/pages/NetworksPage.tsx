import { Link } from "react-router-dom";
import type { NetworkRecord } from "@dockermap/contracts";
import { useApiResource } from "../hooks/useApiResource";
import { useSearchParamState } from "../hooks/useSearchParamState";
import Icon from "../components/Icon";
import { Badge, Chip, PageHead, StateView } from "../components/ui";

export default function NetworksPage(props: { heartbeat: number }) {
  const { searchParams, update } = useSearchParamState();
  const resource = useApiResource<{ networks: NetworkRecord[] }>("/api/networks", props.heartbeat);
  const focus = searchParams.get("network");

  if (resource.loading) {
    return <StateView kind="loading" title="Loading networks" body="Resolving bridge zones and service membership." icon="network" />;
  }
  if (resource.error || !resource.data) {
    return <StateView kind="error" title="Networks unavailable" body={resource.error ?? "Unknown failure"} />;
  }

  const all = resource.data.networks;
  const maxMembers = Math.max(1, ...all.map((n) => n.members.length));
  const networks = focus ? all.filter((n) => n.id === focus || n.name === focus) : all;

  return (
    <section className="stack">
      <PageHead
        eyebrow="Segmentation"
        title="Networks"
        subtitle="Bridge and internal zones, and the services attached to each."
        actions={focus ? <Chip onClick={() => update({ network: null })}>Clear focus ✕</Chip> : undefined}
      />

      {networks.length === 0 ? (
        <StateView kind="empty" title="No networks match this focus" body="Clear the selected network to see all zones." icon="network" />
      ) : (
        <div className="card-grid">
          {networks.map((n) => (
            <article className={`tile ${focus ? "tile-focus" : ""}`} key={n.id}>
              <div className="tile-top">
                <span className="tile-icon tile-icon-aqua">
                  <Icon name="network" size={18} />
                </span>
                <Badge tone={n.internal ? "gold" : "aqua"} icon="shield">
                  {n.internal ? "internal" : "bridge"}
                </Badge>
              </div>
              <h3 className="tile-title">{n.name}</h3>
              <div className="tile-meta">
                <code className="cell-mono">{n.driver}</code> · {n.members.length} members
              </div>
              <div className="bar" aria-hidden="true">
                <span style={{ width: `${(n.members.length / maxMembers) * 100}%`, background: n.internal ? "var(--gold)" : "var(--aqua)" }} />
              </div>
              <div className="chip-row chip-row-spaced">
                {n.members.map((m) => (
                  <Link key={m} className="chip" to={`/containers/${m}`}>
                    <Icon name="container" size={12} />
                    {m}
                  </Link>
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
