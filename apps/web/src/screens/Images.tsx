import { useState } from "react";
import { Link } from "react-router-dom";
import type { ImageRecord } from "@dockermap/contracts";
import { useApp } from "../context";
import { useApiResource } from "../hooks/useApiResource";
import { EmptyState, ErrorState, Loading, Panel, StateDot, Tag } from "../components/primitives";

export default function Images() {
  const { model, tick } = useApp();
  const resource = useApiResource<{ images: ImageRecord[] }>("/api/images", tick);
  const [sort, setSort] = useState<"name" | "usage">("name");
  const [search, setSearch] = useState("");

  if (resource.loading && !resource.data) return <Loading label="Grouping services by image…" />;
  if (resource.error) return <ErrorState title="Images unavailable" body={resource.error} />;

  const images = resource.data?.images ?? [];
  const needle = search.trim().toLowerCase();
  const visible = [...images]
    .filter((img) => needle === "" || img.image.toLowerCase().includes(needle))
    .sort((left, right) =>
      sort === "name"
        ? left.image.localeCompare(right.image)
        : right.containers.length - left.containers.length
    );

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <div className="eyebrow">Image lineage</div>
          <h1 className="screen-title">Images</h1>
        </div>
        <span className="muted-line">{visible.length} of {images.length} images</span>
      </header>

      <div className="log-controls">
        <select
          className="log-level-select"
          value={sort}
          onChange={(e) => setSort(e.target.value as "name" | "usage")}
          aria-label="Sort images"
        >
          <option value="name">Sort by name</option>
          <option value="usage">Sort by usage</option>
        </select>
        <input
          className="log-search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter images…"
          aria-label="Filter images"
        />
      </div>

      {images.length === 0 ? (
        <EmptyState icon="image" title="No images" body="No images are backing any running service." />
      ) : visible.length === 0 ? (
        <EmptyState icon="search" title="No matching images" body="No images match the current filter." />
      ) : (
        <Panel title="In use" icon="image">
          <ul className="svc-list">
            {visible.map((img) => (
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
