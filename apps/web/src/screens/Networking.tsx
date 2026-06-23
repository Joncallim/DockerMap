import { Link } from "react-router-dom";
import { useApp } from "../context";
import Icon from "../components/Icon";
import { EmptyState, ErrorState, Loading, Panel, StateDot, Tag } from "../components/primitives";

export default function Networking() {
  const { model, loading, error } = useApp();
  if (loading && !model) return <Loading label="Resolving networks…" />;
  if (error && !model) return <ErrorState title="Networking unavailable" body={error} />;
  if (!model) return <EmptyState icon="network" title="No networks" body="Connect a Docker host to see network segmentation." />;

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <div className="eyebrow">Segmentation</div>
          <h1 className="screen-title">Networking</h1>
        </div>
        <span className="muted-line">{model.networks.length} networks</span>
      </header>

      {model.networks.length === 0 ? (
        <EmptyState icon="network" title="No networks" body="No Docker networks are defined." />
      ) : (
        <div className="card-grid">
          {model.networks.map((net) => (
            <Panel key={net.id} title={net.name} icon="network" hint={net.driver}>
              <div className="tag-wrap">
                <Tag tone={net.internal ? "warn" : "accent"}>{net.internal ? "internal" : "bridge"}</Tag>
                <Tag tone="muted">{net.members.length} members</Tag>
              </div>
              <ul className="rel-list">
                {net.members.map((member) => {
                  const svc = model.byName.get(member);
                  return (
                    <li key={member}>
                      <StateDot state={svc?.state ?? "unknown"} />
                      {svc ? (
                        <Link to={`/services/${encodeURIComponent(svc.name)}`}>{svc.name}</Link>
                      ) : (
                        <span>{member}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}
