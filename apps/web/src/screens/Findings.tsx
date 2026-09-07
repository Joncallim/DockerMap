import { Link } from "react-router-dom";
import { useApp } from "../context";
import Icon from "../components/Icon";
import { EmptyState, Loading, Panel, Tag } from "../components/primitives";
import { presentationForFinding } from "../lib/findingPresentation";

export default function Findings() {
  const { findings, loading, evidenceMode, modelProvenance } = useApp();
  // AppShell already revision-gates findings. Keep the surface defensive too:
  // direct demo/mock rendering must never turn fixture data into host advice.
  const liveFindings = evidenceMode === "live" && modelProvenance === "live" ? findings : null;

  if (loading && !liveFindings) return <Loading label="Checking bounded findings…" />;

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <div className="eyebrow">Evidence-backed review</div>
          <h1 className="screen-title">Findings</h1>
          <p className="screen-sub">A small set of explicit evidence conditions. These are not health, readiness, traffic, Internet-reachability, or security conclusions.</p>
        </div>
        <Link className="ghost-link" to="/runtime">Open Runtime <Icon name="arrow" size={14} /></Link>
      </header>

      {!liveFindings ? (
        <Panel title="Not collected" icon="alert">
          <EmptyState icon="alert" title="Live evidence is not established" body="Findings appear only when their model revision matches the current live Docker model." />
        </Panel>
      ) : liveFindings.findings.length === 0 ? (
        <Panel title="Findings" icon="check" hint="Live evidence">
          <FindingSummary summary={liveFindings.summary} />
          <EmptyState icon="check" title="No current findings" body="No supported declared-dependency condition is currently detected." />
        </Panel>
      ) : (
        <div className="stack">
          <Panel title="Finding summary" icon="alert" hint="Closed counts">
            <FindingSummary summary={liveFindings.summary} />
          </Panel>
          {liveFindings.findings.map((finding, index) => {
            const presentation = presentationForFinding(finding);
            if (!presentation) return null;
            return <Panel key={`${finding.ruleId}-${index}`} title={presentation.title} icon="alert" hint={presentation.hint}>
              <div className="tag-wrap"><Tag tone={presentation.tone}>{presentation.severityLabel}</Tag><Tag tone="muted">{presentation.category}</Tag></div>
              <p className="muted-copy">{presentation.summary}</p>
              <p className="muted-copy">{presentation.recommendation}</p>
              <details>
                <summary>Inspect rule basis</summary>
                <p className="muted-copy">{presentation.inspection.ruleLabel} ({presentation.inspection.ruleId})</p>
                <p className="muted-copy">{presentation.inspection.freshEvidenceRequirement}</p>
                <p className="muted-copy">{presentation.inspection.factDescription}</p>
                <p className="muted-copy">{presentation.inspection.limits}</p>
              </details>
              {presentation.inspectChanges && <Link className="ghost-link" to="/changes">Inspect recent changes <Icon name="arrow" size={14} /></Link>}
            </Panel>;
          })}
        </div>
      )}
    </div>
  );
}

function FindingSummary({ summary }: { summary: { warningCount: number; advisoryCount: number; declaredDependencyCount: number; dockerDaemonAuthorityCount: number; hostPortPublicationCount: number; evidenceIntegrityCount: number } }) {
  return <div className="stack">
    <p className="muted-copy">{summary.warningCount} warning{summary.warningCount === 1 ? "" : "s"} · {summary.advisoryCount} advisor{summary.advisoryCount === 1 ? "y" : "ies"}</p>
    <p className="muted-copy">Declared dependencies: {summary.declaredDependencyCount} · Docker daemon authority: {summary.dockerDaemonAuthorityCount} · Host-port publication: {summary.hostPortPublicationCount} · Evidence integrity: {summary.evidenceIntegrityCount}</p>
  </div>;
}
