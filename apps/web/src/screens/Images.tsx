import { Link } from "react-router-dom";
import type { ImageRecord } from "@dockermap/contracts";
import { useApp } from "../context";
import { useApiResource } from "../hooks/useApiResource";
import { EmptyState, ErrorState, Loading, Panel, StateDot, Tag } from "../components/primitives";

export default function Images() {
  const { model, tick } = useApp();
  const resource = useApiResource<{ images: ImageRecord[] }>("/api/images", tick);

  if (resource.loading && !resource.data) return <Loading label="Grouping services by image…" />;
  if (resource.error) return <ErrorState title="Images unavailable" body={resource.error} />;

  const images = resource.data?.images ?? [];

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <div className="eyebrow">Image lineage</div>
          <h1 className="screen-title">Images</h1>
        </div>
        <span className="muted-line">{images.length} images</span>
      </header>

      {images.length === 0 ? (
        <EmptyState icon="image" title="No images" body="No images are backing any running service." />
      ) : (
        <Panel title="In use" icon="image">
          <ul className="svc-list">
            {images.map((img) => (
              <li key={img.image} className="svc-row image-row">
                <code className="image-name">{img.image}</code>
                <Tag tone="muted">{img.containers.length} service{img.containers.length === 1 ? "" : "s"}</Tag>
                <div className="tag-wrap">
                  {img.containers.map((c) => {
                    const svc = model?.byName.get(c);
                    return (
                      <Link key={c} className="ref-chip" to={`/services/${encodeURIComponent(c)}`}>
                        <StateDot state={svc?.state ?? "unknown"} /> {c}
                      </Link>
                    );
                  })}
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
