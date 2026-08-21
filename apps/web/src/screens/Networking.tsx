import { Link } from "react-router-dom";
import { useApp } from "../context";
import Icon from "../components/Icon";
import { EmptyState, ErrorState, Loading, Panel, StateDot, Tag } from "../components/primitives";
import { COLLISION_HINT, COLLISION_TAG, UNAVAILABLE_NETWORK_DRIVER } from "../lib/identity";

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
          {model.networks.map((net, index) => {
            const collided = net.name !== "" && model.networkNameCollisions.has(net.name);
            const routable = net.name !== "" && !collided;
            return (
              <Panel key={`${net.id}-${index}`} title={routable ? <Link className="entity-detail-link" to={`/networks/${encodeURIComponent(net.name)}`}>{net.name}</Link> : net.name === "" ? "Unavailable network name" : <span className="collision-identity" title={COLLISION_HINT}>{net.name}</span>} icon="network" hint={net.driver === "" ? UNAVAILABLE_NETWORK_DRIVER : net.driver} actions={routable ? <Link className="ghost-link entity-detail-action" aria-label={`Open ${net.name} network detail`} to={`/networks/${encodeURIComponent(net.name)}`}>Open detail</Link> : undefined}>
                <div className="tag-wrap">
                  <Tag tone={net.internal ? "warn" : "accent"}>{net.internal ? "internal" : "bridge"}</Tag>
                  <Tag tone="muted">{net.members.length} members</Tag>
                  {collided && <Tag tone="warn">{COLLISION_TAG}</Tag>}
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
            );
          })}
        </div>
      )}
    </div>
  );
}
