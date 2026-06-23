import { Link } from "react-router-dom";
import { useApp } from "../context";
import Icon from "../components/Icon";
import { EmptyState, ErrorState, Loading, Panel, StateDot, Tag } from "../components/primitives";

export default function Storage() {
  const { model, loading, error } = useApp();
  if (loading && !model) return <Loading label="Mapping persistent state…" />;
  if (error && !model) return <ErrorState title="Storage unavailable" body={error} />;
  if (!model) return <EmptyState icon="storage" title="No volumes" body="Connect a Docker host to see persistent storage." />;

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <div className="eyebrow">Persistent state</div>
          <h1 className="screen-title">Storage</h1>
        </div>
        <span className="muted-line">{model.volumes.length} volumes</span>
      </header>

      {model.volumes.length === 0 ? (
        <EmptyState icon="storage" title="No volumes" body="No named volumes are attached to any service." />
      ) : (
        <div className="card-grid">
          {model.volumes.map((vol) => (
            <Panel key={vol.id} title={vol.name} icon="storage">
              <div className="tag-wrap">
                <Tag tone={vol.attachedTo.length ? "accent" : "muted"}>
                  {vol.attachedTo.length ? `${vol.attachedTo.length} consumer${vol.attachedTo.length === 1 ? "" : "s"}` : "idle"}
                </Tag>
              </div>
              {vol.attachedTo.length === 0 ? (
                <p className="muted-line">Not mounted by any service.</p>
              ) : (
                <ul className="rel-list">
                  {vol.attachedTo.map((member) => {
                    const svc = model.byName.get(member);
                    return (
                      <li key={member}>
                        <Icon name="arrow" size={13} />
                        <StateDot state={svc?.state ?? "unknown"} />
                        {svc ? <Link to={`/services/${encodeURIComponent(svc.name)}`}>{svc.name}</Link> : <span>{member}</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}
