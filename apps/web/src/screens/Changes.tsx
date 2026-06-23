import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useApp } from "../context";
import { changeFeed, type ChangeEvent, STUB_CHANGES_NOTICE } from "../lib/stubs";
import { formatRelative } from "../lib/format";
import Icon from "../components/Icon";
import { EmptyState, ErrorState, Loading, Panel } from "../components/primitives";

const KINDS: { id: ChangeEvent["kind"] | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "image_update", label: "Updates" },
  { id: "restart", label: "Restarts" },
  { id: "failure", label: "Failures" },
  { id: "recovery", label: "Recoveries" }
];

export default function Changes() {
  const { model, loading, error } = useApp();
  const [kind, setKind] = useState<ChangeEvent["kind"] | "all">("all");

  const events = useMemo(() => (model ? changeFeed(model) : []), [model]);
  const filtered = kind === "all" ? events : events.filter((e) => e.kind === kind);

  if (loading && !model) return <Loading label="Reconstructing change history…" />;
  if (error && !model) return <ErrorState title="Changes unavailable" body={error} />;

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <div className="eyebrow">Causality</div>
          <h1 className="screen-title">Change Center</h1>
        </div>
        <div className="filter-row">
          {KINDS.map((k) => (
            <button key={k.id} type="button" className={`filter-chip${kind === k.id ? " is-on" : ""}`} onClick={() => setKind(k.id)}>
              {k.label}
            </button>
          ))}
        </div>
      </header>

      <Panel title="Timeline" icon="history" hint={STUB_CHANGES_NOTICE}>
        {filtered.length === 0 ? (
          <EmptyState icon="history" title="No change recorded" body="Deployments, restarts and failures will appear here." />
        ) : (
          <ol className="timeline">
            {filtered.map((event) => (
              <li key={event.id} className={`timeline-row k-${event.kind}`}>
                <span className="timeline-marker" aria-hidden="true">
                  <Icon name={iconForKind(event.kind)} size={13} />
                </span>
                <div className="timeline-body">
                  <div className="timeline-top">
                    <Link className="timeline-title" to={`/services/${encodeURIComponent(event.serviceName)}`}>
                      {event.summary}
                    </Link>
                    <span className="timeline-time">{formatRelative(event.at)}</span>
                  </div>
                  {event.detail && <p className="timeline-detail">{event.detail}</p>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </div>
  );
}

function iconForKind(kind: ChangeEvent["kind"]): Parameters<typeof Icon>[0]["name"] {
  switch (kind) {
    case "image_update":
      return "up";
    case "failure":
      return "alert";
    case "recovery":
      return "check";
    case "restart":
      return "refresh";
    case "config":
      return "layers";
    default:
      return "history";
  }
}
