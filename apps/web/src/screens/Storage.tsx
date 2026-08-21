import { useState } from "react";
import { Link } from "react-router-dom";
import { useApp } from "../context";
import Icon from "../components/Icon";
import { EmptyState, ErrorState, Loading, Panel, StateDot, Tag } from "../components/primitives";
import { IdentityRef } from "../components/identity";
import { COLLISION_HINT, COLLISION_TAG, UNAVAILABLE_CONTAINER, UNAVAILABLE_VOLUME } from "../lib/identity";

export default function Storage() {
  const { model, loading, error } = useApp();
  const [search, setSearch] = useState("");
  if (loading && !model) return <Loading label="Mapping persistent state…" />;
  if (error && !model) return <ErrorState title="Storage unavailable" body={error} />;
  if (!model) return <EmptyState icon="storage" title="No volumes" body="Connect a Docker host to see persistent storage." />;

  const needle = search.trim().toLowerCase();
  const volumes = model.volumes.filter(
    (vol) => needle === "" || vol.name.toLowerCase().includes(needle)
  );

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <div className="eyebrow">Persistent state</div>
          <h1 className="screen-title">Storage</h1>
        </div>
        <span className="muted-line">{volumes.length} of {model.volumes.length} volumes</span>
      </header>

      <div className="log-controls">
        <input
          className="log-search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter volumes…"
          aria-label="Filter volumes"
        />
      </div>

      {model.volumes.length === 0 ? (
        <EmptyState icon="storage" title="No volumes" body="No named volumes are attached to any service." />
      ) : volumes.length === 0 ? (
        <EmptyState icon="search" title="No matching volumes" body="No volumes match the current filter." />
      ) : (
        <div className="card-grid">
          {volumes.map((vol, index) => {
            const collided = vol.name !== "" && model.volumeNameCollisions.has(vol.name);
            const routable = vol.name !== "" && !collided;
            return (
              <Panel key={`${vol.id}-${index}`} title={routable ? <Link className="entity-detail-link" to={`/volumes/${encodeURIComponent(vol.name)}`}>{vol.name}</Link> : vol.name === "" ? UNAVAILABLE_VOLUME : <span className="collision-identity" title={COLLISION_HINT}>{vol.name}</span>} icon="storage" actions={routable ? <Link className="ghost-link entity-detail-action" aria-label={`Open ${vol.name} volume detail`} to={`/volumes/${encodeURIComponent(vol.name)}`}>Open detail</Link> : undefined}>
                <div className="tag-wrap">
                  <Tag tone={vol.attachedTo.length ? "accent" : "muted"}>
                    {vol.attachedTo.length ? `${vol.attachedTo.length} consumer${vol.attachedTo.length === 1 ? "" : "s"}` : "idle"}
                  </Tag>
                  {collided && <Tag tone="warn">{COLLISION_TAG}</Tag>}
                </div>
                {vol.attachedTo.length === 0 ? (
                  <p className="muted-line">Not mounted by any service.</p>
                ) : (
                  <ul className="rel-list">
                    {vol.attachedTo.map((member, memberIndex) => {
                      const svc = model.byName.get(member);
                      return (
                        <li key={`${member}-${memberIndex}`}>
                          <Icon name="arrow" size={13} />
                          <StateDot state={svc?.state ?? "unknown"} />
                          <IdentityRef name={member} fallback={UNAVAILABLE_CONTAINER} to={svc ? `/services/${encodeURIComponent(svc.name)}` : undefined} />
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Panel>
            );
          })}
        </div>
      )}
    </div>
  );
}
