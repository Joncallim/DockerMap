import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { ImageRecord } from "@dockermap/contracts";
import { useApiResource } from "../hooks/useApiResource";
import { useSearchParamState } from "../hooks/useSearchParamState";
import Icon from "../components/Icon";
import { Badge, PageHead, StateView } from "../components/ui";

function splitImage(ref: string) {
  const at = ref.lastIndexOf(":");
  if (at <= 0) return { repo: ref, tag: "latest" };
  return { repo: ref.slice(0, at), tag: ref.slice(at + 1) };
}

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
    return <StateView kind="loading" title="Loading images" body="Grouping services by image lineage." icon="image" />;
  }
  if (resource.error || !resource.data) {
    return <StateView kind="error" title="Images unavailable" body={resource.error ?? "Unknown failure"} />;
  }

  return (
    <section className="stack">
      <PageHead eyebrow="Image lineage" title="Images" subtitle="Distinct image references and the services they back." />

      {images.length === 0 ? (
        <StateView kind="empty" title="No images match" body="Try clearing the search query." icon="search" />
      ) : (
        <div className="card-grid">
          {images.map((image) => {
            const { repo, tag } = splitImage(image.image);
            return (
              <article className="tile" key={image.image}>
                <div className="tile-top">
                  <span className="tile-icon tile-icon-gold">
                    <Icon name="image" size={18} />
                  </span>
                  <Badge tone="neutral">{tag}</Badge>
                </div>
                <h3 className="tile-title">{repo}</h3>
                <div className="tile-meta">
                  {image.containers.length} container{image.containers.length === 1 ? "" : "s"}
                </div>
                <div className="chip-row chip-row-spaced">
                  {image.containers.map((container) => (
                    <Link key={container} className="chip" to={`/containers/${container}`}>
                      <Icon name="container" size={12} />
                      {container}
                    </Link>
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
