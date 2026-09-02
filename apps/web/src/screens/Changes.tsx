import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useApp } from "../context";
import { changeFeed, type ChangeEvent } from "../lib/stubs";
import { observedChangeFeed } from "../lib/observedHistory";
import { coherentObservedDockerEvents, observedDockerEventKindToken } from "../lib/observedDockerEvents";
import { formatRelative } from "../lib/format";
import { evidenceLabel } from "../lib/evidence";
import {
  CHANGE_HISTORY_CLAIM,
  SAMPLE_EMPTY_BODY,
  SAMPLE_EMPTY_TITLE,
  SAMPLE_FILTERED_EMPTY_BODY
} from "../lib/history";
import Icon from "../components/Icon";
import { EmptyState, ErrorState, Loading, Panel } from "../components/primitives";

const KINDS: { id: ChangeEvent["kind"] | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "restart", label: "Restarts" },
  { id: "failure", label: "Failures" },
  { id: "recovery", label: "Recoveries" }
];

export default function Changes() {
  const { model, modelProvenance, loading, error, evidenceMode, observedHistory, observedDockerEvents } = useApp();
  const [kind, setKind] = useState<ChangeEvent["kind"] | "all">("all");
  const history = useMemo(
    () => {
      if (!model) return CHANGE_HISTORY_CLAIM;
      const observed = observedChangeFeed(model, evidenceMode, modelProvenance, observedHistory);
      return observed.kind === "observed" ? observed : changeFeed(model, evidenceMode, modelProvenance);
    },
    [model, evidenceMode, modelProvenance, observedHistory]
  );
  const events = history.kind === "unavailable" ? [] : history.value;
  const filtered = kind === "all" ? events : events.filter((event) => event.kind === kind);
  const streamHistory = useMemo(
    () => coherentObservedDockerEvents(model, evidenceMode, modelProvenance, observedDockerEvents),
    [model, evidenceMode, modelProvenance, observedDockerEvents]
  );

  if (loading && !model) return <Loading label="Reconstructing change history…" />;
  if (error && !model) return <ErrorState title="Changes unavailable" body={error} />;

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <div className="eyebrow">{history.kind === "observed" ? "Observed changes" : "Causality"}</div>
          <h1 className="screen-title">Change Center</h1>
        </div>
        {history.kind === "demo" && (
          <div className="filter-row">
            {KINDS.map((filterKind) => (
              <button
                key={filterKind.id}
                type="button"
                aria-pressed={kind === filterKind.id}
                className={`filter-chip${kind === filterKind.id ? " is-on" : ""}`}
                onClick={() => setKind(filterKind.id)}
              >
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
          <EmptyState
            icon="history"
            title={SAMPLE_EMPTY_TITLE}
            body={events.length === 0 ? SAMPLE_EMPTY_BODY : SAMPLE_FILTERED_EMPTY_BODY}
          />
        ) : (
          <ol className="timeline">
            {filtered.map((event, index) => {
              const routable = event.routeName !== null;
              return (
                <li key={`${event.id}-${index}`} className={`timeline-row k-${event.kind}`}>
                  <span className="timeline-marker" aria-hidden="true">
                    <Icon name={iconForKind(event.kind)} size={13} />
                  </span>
                  <div className="timeline-body">
                    <div className="timeline-top">
                      {routable ? (
                        <Link className="timeline-title" to={`/services/${encodeURIComponent(event.routeName!)}`}>
                          {event.summary}
                        </Link>
                      ) : (
                        <span className="timeline-title">{event.summary}</span>
                      )}
                      <span className="timeline-time">{formatRelative(event.at)}</span>
                    </div>
                    {event.detail && <p className="timeline-detail">{event.detail}</p>}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </Panel>

      {streamHistory && <DockerEventObservations history={streamHistory} />}
    </div>
  );
}

function DockerEventObservations({ history }: { history: NonNullable<ReturnType<typeof coherentObservedDockerEvents>> }) {
  const collectionLabel = collectionStateLabel(history.collectionState);
  return (
    <Panel
      className="panel-docker-event-observations"
      title="Docker event observations"
      icon="history"
      hint="Observed"
    >
      <p id="docker-event-observation-boundary" className="stream-observation-boundary">
        Bounded daemon-lifetime observations from the read-only Docker event stream. They are separate from
        snapshot-derived changes and are not a complete historical record; reconnects can leave gaps.
      </p>
      <p className="stream-collection-state" role="status" aria-live="polite">
        Collection state: {collectionLabel}
      </p>
      {history.events.length === 0 ? (
        <EmptyState
          icon="history"
          title="No retained stream observations"
          body="Retention is bounded to the current daemon process lifetime."
        />
      ) : (
        <ol className="stream-observation-list" aria-describedby="docker-event-observation-boundary">
          {history.events.map((event) => (
            <li className="stream-observation-row" key={event.id}>
              <span className="stream-observation-marker" aria-hidden="true">
                <Icon name="history" size={13} />
              </span>
              <div className="stream-observation-body">
                <div className="stream-observation-top">
                  <span className="stream-observation-title">Docker stream observation</span>
                  <time className="timeline-time" dateTime={new Date(event.observedAtMs).toISOString()}>
                    {formatRelative(event.observedAtMs)}
                  </time>
                </div>
                <div className="stream-observation-meta">
                  <span>Event kind</span>
                  <code>{observedDockerEventKindToken(event.kind)}</code>
                  <span>Stream source</span>
                  <code>{event.evidenceSource}</code>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

function collectionStateLabel(state: NonNullable<ReturnType<typeof coherentObservedDockerEvents>>["collectionState"]): string {
  switch (state) {
    case "connecting":
      return "connecting";
    case "collecting":
      return "collecting";
    case "reconnecting":
      return "reconnecting; observations may be incomplete";
    // coherentObservedDockerEvents excludes this state before this renderer is
    // reached. Keep the branch exhaustive so a future call-site cannot turn
    // an uncollected response into an implied stream record.
    case "unavailable":
      return "unavailable";
  }
}

function iconForKind(kind: ChangeEvent["kind"]): Parameters<typeof Icon>[0]["name"] {
  // Exhaustive by design: no default swallow. Adding a new kind to the union
  // must be a compile error here until its visual language is chosen.
  switch (kind) {
    case "failure":
      return "alert";
    case "recovery":
      return "check";
    case "restart":
      return "refresh";
    case "config":
      return "layers";
    case "deploy":
      return "up";
    case "container_appeared":
      return "up";
    case "container_disappeared":
      return "layers";
    case "container_status_changed":
      return "history";
  }
}
