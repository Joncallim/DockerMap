import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useApp } from "../context";
import { answer, suggestions, type CopilotAnswer } from "../lib/copilot";
import { evidenceLabel } from "../lib/evidence";
import Icon from "../components/Icon";
import { EmptyState, ErrorState, Loading, Panel, StateDot, Tag } from "../components/primitives";

export default function Copilot() {
  const { model, loading, error, evidenceMode, modelProvenance, observedDockerEvents } = useApp();
  const [params, setParams] = useSearchParams();
  const initial = params.get("q") ?? "";
  const [query, setQuery] = useState(initial);
  const [submitted, setSubmitted] = useState(initial);

  useEffect(() => {
    const q = params.get("q") ?? "";
    setQuery(q);
    setSubmitted(q);
  }, [params]);

  const result = useMemo<CopilotAnswer | null>(() => {
    if (!model || !submitted.trim()) return null;
    return answer(model, submitted, evidenceMode, modelProvenance, observedDockerEvents);
  }, [model, submitted, evidenceMode, modelProvenance, observedDockerEvents]);

  if (loading && !model) return <Loading label="Reading your topology…" />;
  if (error && !model) return <ErrorState title="Copilot unavailable" body={error} />;
  if (!model) return <EmptyState icon="spark" title="Nothing to explain yet" body="Connect a Docker host so Copilot can reason about it." />;

  const submit = (value: string) => {
    setSubmitted(value);
    if (value.trim()) setParams({ q: value });
    else setParams({});
  };

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <div className="eyebrow">Interpreter</div>
          <h1 className="screen-title">Copilot</h1>
        </div>
        <span className="muted-line">Reasons over your service map — never controls it</span>
      </header>

      <form
        className="copilot-input"
        onSubmit={(e) => {
          e.preventDefault();
          submit(query);
        }}
      >
        <Icon name="spark" size={17} />
        <label htmlFor="copilot-query" className="sr-only">Ask Copilot</label>
        <input
          id="copilot-query"
          aria-label="Ask Copilot"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ask why something is offline, what depends on a service, what changed…"
        />
        <button type="submit">Ask</button>
      </form>

      <div className="chip-cloud">
        {suggestions(model).map((s) => (
          <button key={s.query} type="button" className="suggest-chip" onClick={() => { setQuery(s.query); submit(s.query); }}>
            {s.label}
          </button>
        ))}
      </div>

      {result && (
        <Panel title={result.headline} icon="spark">
          <div className="copilot-answer">
            {result.body.map((line, i) => (
              <p key={i}>{line}</p>
            ))}
          </div>
          {result.references.length > 0 && (
            <div className="copilot-refs">
              {dedupe(result.references).map((ref) => {
                const svc = model.byName.get(ref);
                if (!svc) return null;
                return (
                  <Link key={ref} className="ref-chip" to={`/services/${encodeURIComponent(ref)}`}>
                    <StateDot state={svc.state} /> {ref}
                  </Link>
                );
              })}
            </div>
          )}
          <div className="copilot-evidence">
            {result.authorityUnresolved ? (
              <>
                <Tag tone="warn" title="The model's source authority is not established, so no substantive answer is produced.">Source authority unresolved</Tag>
                <span className="muted-line">DockerMap cannot verify where these bytes came from; the data may be collected but its source is unverifiable.</span>
              </>
            ) : (
              <>
                <Tag tone="muted" title={evidenceLabel(result.evidence).description}>
                  {evidenceLabel(result.evidence).label}
                </Tag>
                <span className="muted-line">{evidenceLabel(result.evidence).description}</span>
              </>
            )}
          </div>
        </Panel>
      )}
    </div>
  );
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
