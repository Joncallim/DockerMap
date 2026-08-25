import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useApp } from "../context";
import { changeFeed, type ChangeEvent } from "../lib/stubs";
import { formatRelative } from "../lib/format";
import { evidenceLabel } from "../lib/evidence";
import { CHANGE_HISTORY_CLAIM, SAMPLE_EMPTY_BODY, SAMPLE_EMPTY_TITLE } from "../lib/history";
import Icon from "../components/Icon";
import { EmptyState, ErrorState, Loading, Panel } from "../components/primitives";

const KINDS: { id: ChangeEvent["kind"] | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "restart", label: "Restarts" },
  { id: "failure", label: "Failures" },
  { id: "recovery", label: "Recoveries" }
];

export default function Changes() {
  const { model, modelProvenance, loading, error, evidenceMode } = useApp();
  const [kind, setKind] = useState<ChangeEvent["kind"] | "all">("all");
  const history = useMemo(
    () => (model ? changeFeed(model, evidenceMode, modelProvenance) : CHANGE_HISTORY_CLAIM),
    [model, evidenceMode, modelProvenance]
  );
  const events = history.kind === "unavailable" ? [] : history.value;
  const filtered = kind === "all" ? events : events.filter((event) => event.kind === kind);

  if (loading && !model) return <Loading label="Reconstructing change history…" />;
  if (error && !model) return <ErrorState title="Changes unavailable" body={error} />;

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <div className="eyebrow">Causality</div>
          <h1 className="screen-title">Change Center</h1>
        </div>
        {history.kind !== "unavailable" && (
          <div className="filter-row">
            {KINDS.map((filterKind) => (
              <button key={filterKind.id} type="button" aria-pressed={kind === filterKind.id} className={`filter-chip${kind === filterKind.id ? " is-on" : ""}`} onClick={() => setKind(filterKind.id)}>
                {filterKind.label}
              </button>
            ))}
          </div>
        )}
      </header>

      <Panel className="panel-change-timeline" title="Timeline" icon="history" hint={evidenceLabel(history.kind).label}>
        {history.kind === "unavailable" ? (
          <EmptyState icon="history" title={evidenceLabel(history.kind).label} body={history.detail} />
        ) : filtered.length === 0 ? (
          <EmptyState icon="history" title={SAMPLE_EMPTY_TITLE} body={SAMPLE_EMPTY_BODY} />
        ) : (
          <ol className="timeline">
            {filtered.map((event, index) => {
              const routable = event.routeName !== null;
              return <li key={`${event.id}-${index}`} className={`timeline-row k-${event.kind}`}>
                <span className="timeline-marker" aria-hidden="true">
                  <Icon name={iconForKind(event.kind)} size={13} />
                </span>
                <div className="timeline-body">
                  <div className="timeline-top">
                    {routable ? <Link className="timeline-title" to={`/services/${encodeURIComponent(event.routeName!)}`}>{event.summary}</Link> : <span className="timeline-title">{event.summary}</span>}
                    <span className="timeline-time">{formatRelative(event.at)}</span>
                  </div>
                  {event.detail && <p className="timeline-detail">{event.detail}</p>}
                </div>
              </li>;
            })}
          </ol>
        )}
      </Panel>
    </div>
  );
}

function iconForKind(kind: ChangeEvent["kind"]): Parameters<typeof Icon>[0]["name"] {
  switch (kind) {
    case "failure": return "alert";
    case "recovery": return "check";
    case "restart": return "refresh";
    case "config": return "layers";
    case "deploy": return "up";
  }
}
