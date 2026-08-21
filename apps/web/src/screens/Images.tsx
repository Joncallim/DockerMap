import { useState } from "react";
import { Link } from "react-router-dom";
import { useApp } from "../context";
import { EmptyState, ErrorState, Loading, Panel, StateDot, Tag } from "../components/primitives";
import { UNAVAILABLE_CONTAINER } from "../lib/identity";

export default function Images() {
  const { model, loading, error } = useApp();
  const [sort, setSort] = useState<"name" | "usage">("name");
  const [search, setSearch] = useState("");

  if (loading && !model) return <Loading label="Grouping services by image…" />;
  if (error && !model) return <ErrorState title="Images unavailable" body={error} />;
  if (!model) return <EmptyState icon="image" title="No images" body="Connect a Docker host to inspect image usage." />;

  const images = model.images;
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
            {visible.map((img, index) => (
              <li key={`${img.image}-${index}`} className="svc-row image-row">
                {img.image ? <Link className="image-detail-link" to={`/images/${encodeURIComponent(img.image)}`}>{img.image}</Link> : <code className="image-name">Unavailable image reference</code>}
                <Tag tone="muted">{img.containers.length} service{img.containers.length === 1 ? "" : "s"}</Tag>
                <div className="tag-wrap">
                  {img.containers.map((c, index) => {
                    const svc = c ? model?.byName.get(c) : undefined;
                    return svc ? (
                      <Link key={`${c}-${index}`} className="ref-chip" to={`/services/${encodeURIComponent(svc.name)}`}>
                        <StateDot state={svc.state} /> {c}
                      </Link>
                    ) : (
                      <span key={`${c}-${index}`} className="ref-chip"><StateDot state="unknown" /> {c || UNAVAILABLE_CONTAINER}</span>
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
