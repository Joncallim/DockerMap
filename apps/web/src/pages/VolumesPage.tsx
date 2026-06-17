import { Link } from "react-router-dom";
import type { VolumeRecord } from "@dockermap/contracts";
import { useApiResource } from "../hooks/useApiResource";
import { useSearchParamState } from "../hooks/useSearchParamState";
import EmptyPanel from "../components/EmptyPanel";
import StatePanel from "../components/StatePanel";

export default function VolumesPage(props: { heartbeat: number }) {
  const { searchParams } = useSearchParamState();
  const resource = useApiResource<{ volumes: VolumeRecord[] }>("/api/volumes", props.heartbeat);
  const focus = searchParams.get("volume");

  if (resource.loading) {
    return <StatePanel title="Loading volumes" body="Mapping attached services and persistent state." />;
  }

  if (resource.error || !resource.data) {
    return <StatePanel title="Volumes unavailable" body={resource.error ?? "Unknown failure"} tone="error" />;
  }

  const volumes = focus
    ? resource.data.volumes.filter((volume) => volume.id === focus || volume.name === focus)
    : resource.data.volumes;

  return (
    <section className="card-grid">
      {volumes.length === 0 ? (
        <EmptyPanel title="No volumes match this focus." body="Try clearing the selected volume chip." />
      ) : (
        volumes.map((volume) => (
          <article className="panel-card" key={volume.id}>
            <div className="panel-label">Volume</div>
            <h3>{volume.name}</h3>
            <div className="pill-row">
              {volume.attachedTo.map((container) => (
                <Link key={container} className="pill" to={`/containers/${container}`}>
                  {container}
                </Link>
              ))}
            </div>
          </article>
        ))
      )}
    </section>
  );
}
