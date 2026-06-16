import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { ImageRecord } from "@dockermap/contracts";
import { useApiResource } from "../hooks/useApiResource";
import { useSearchParamState } from "../hooks/useSearchParamState";
import StatePanel from "../components/StatePanel";

export default function ImagesPage(props: { heartbeat: number }) {
  const { searchParams } = useSearchParamState();
  const resource = useApiResource<{ images: ImageRecord[] }>("/api/images", props.heartbeat);
  const q = (searchParams.get("q") ?? "").toLowerCase();

  const images = useMemo(
    () =>
      resource.data?.images.filter(
        (image) =>
          q.length === 0 ||
          image.image.toLowerCase().includes(q) ||
          image.containers.some((container) => container.toLowerCase().includes(q)),
      ) ?? [],
    [q, resource.data],
  );

  if (resource.loading) {
    return <StatePanel title="Loading images" body="Grouping services by image lineage." />;
  }

  if (resource.error || !resource.data) {
    return <StatePanel title="Images unavailable" body={resource.error ?? "Unknown failure"} tone="error" />;
  }

  return (
    <section className="card-grid">
      {images.map((image) => (
        <article className="panel-card" key={image.image}>
          <div className="panel-label">Image</div>
          <h3>{image.image}</h3>
          <div className="pill-row">
            {image.containers.map((container) => (
              <Link key={container} className="pill" to={`/containers/${container}`}>
                {container}
              </Link>
            ))}
          </div>
        </article>
      ))}
    </section>
  );
}
