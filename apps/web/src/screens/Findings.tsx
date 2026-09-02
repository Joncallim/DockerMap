import { Link } from "react-router-dom";
import { useApp } from "../context";
import Icon from "../components/Icon";
import { EmptyState, Loading, Panel, Tag } from "../components/primitives";

export default function Findings() {
  const { findings, loading } = useApp();

  if (loading && !findings) return <Loading label="Checking bounded findings…" />;

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <div className="eyebrow">Evidence-backed review</div>
          <h1 className="screen-title">Findings</h1>
          <p className="screen-sub">A small set of explicit, declared dependency conditions. These are not health, readiness, traffic, or security conclusions.</p>
        </div>
        <Link className="ghost-link" to="/runtime">Open Runtime <Icon name="arrow" size={14} /></Link>
      </header>

      {!findings ? (
        <Panel title="Not collected" icon="alert">
          <EmptyState icon="alert" title="Live evidence is not established" body="Findings appear only when their model revision matches the current live Docker model." />
        </Panel>
      ) : findings.findings.length === 0 ? (
        <Panel title="Findings" icon="check" hint="Live evidence">
          <EmptyState icon="check" title="No current findings" body="No supported declared-dependency condition is currently detected." />
        </Panel>
      ) : (
        <div className="stack">
          {findings.findings.map((finding) => (
            <Panel key={finding.id} title="Declared dependency needs review" icon="alert" hint="Observed declaration">
              <div className="tag-wrap"><Tag tone="warn">Warning</Tag><Tag tone="muted">Systemd Requires</Tag></div>
              <p>{finding.summary}</p>
              <p className="muted-copy">{finding.recommendation}</p>
              <dl className="detail-grid">
                <div><dt>Declaring service</dt><dd>{finding.subjectRef}</dd></div>
                <div><dt>Target service</dt><dd>{finding.targetRef}</dd></div>
              </dl>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}
