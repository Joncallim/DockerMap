import { Link } from "react-router-dom";
import type { VolumeRecord } from "@dockermap/contracts";
import { useApiResource } from "../hooks/useApiResource";
import { useSearchParamState } from "../hooks/useSearchParamState";
import Icon from "../components/Icon";
import { Badge, Chip, PageHead, StateView } from "../components/ui";

export default function VolumesPage(props: { heartbeat: number }) {
  const { searchParams, update } = useSearchParamState();
  const resource = useApiResource<{ volumes: VolumeRecord[] }>("/api/volumes", props.heartbeat);
  const focus = searchParams.get("volume");

  if (resource.loading) {
    return <StateView kind="loading" title="Loading volumes" body="Mapping attached services and persistent state." icon="volume" />;
  }
  if (resource.error || !resource.data) {
    return <StateView kind="error" title="Volumes unavailable" body={resource.error ?? "Unknown failure"} />;
  }

  const volumes = focus
    ? resource.data.volumes.filter((v) => v.id === focus || v.name === focus)
    : resource.data.volumes;

  return (
    <section className="stack">
      <PageHead
        eyebrow="Persistent state"
        title="Volumes"
        subtitle="Named volumes and the containers that mount them."
        actions={focus ? <Chip onClick={() => update({ volume: null })}>Clear focus ✕</Chip> : undefined}
      />

      {volumes.length === 0 ? (
        <StateView kind="empty" title="No volumes match this focus" body="Clear the selected volume to see all state." icon="volume" />
      ) : (
        <div className="card-grid">
          {volumes.map((v) => (
            <article className={`tile ${focus ? "tile-focus" : ""}`} key={v.id}>
              <div className="tile-top">
                <span className="tile-icon tile-icon-coral">
                  <Icon name="volume" size={18} />
                </span>
                <Badge tone={v.attachedTo.length ? "ok" : "neutral"}>
                  {v.attachedTo.length ? "attached" : "idle"}
                </Badge>
              </div>
              <h3 className="tile-title">{v.name}</h3>
              <div className="tile-meta">
                {v.attachedTo.length} consumer{v.attachedTo.length === 1 ? "" : "s"}
              </div>
              <div className="chip-row chip-row-spaced">
                {v.attachedTo.length === 0 ? (
                  <span className="cell-sub">no containers mount this volume</span>
                ) : (
                  v.attachedTo.map((c) => (
                    <Link key={c} className="chip" to={`/containers/${c}`}>
                      <Icon name="container" size={12} />
                      {c}
                    </Link>
                  ))
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
