import { Link } from "react-router-dom";
import { useApp } from "../context";
import Icon from "../components/Icon";
import { EmptyState, Loading, Panel, Tag } from "../components/primitives";
import { isCoherentRepeatedContainerDiedFinding } from "../lib/temporalFinding";

const TEMPORAL_FINDING_RULE = "docker.repeated_container_died_events";

export default function Findings() {
  const { findings: response, loading, evidenceMode, modelProvenance } = useApp();
  // AppShell already supplies findings only beside a coherent live model. This
  // guard keeps the standalone screen equally conservative in tests, future
  // call sites, and any direct context consumer.
  const explicitNonLive = evidenceMode === "demo" || evidenceMode === "mock" || modelProvenance === "demo" || modelProvenance === "mock";
  const hasMalformedTemporalFinding = response?.findings.some((finding) =>
    finding.ruleId === TEMPORAL_FINDING_RULE && !isCoherentRepeatedContainerDiedFinding(finding)
  ) ?? false;
  const findings = explicitNonLive || hasMalformedTemporalFinding ? null : response;

  if (loading && !findings) return <Loading label="Checking bounded findings…" />;

  const presentationFor = (ruleId: string) => {
    if (ruleId === "systemd.requires_target_not_active") return ["Declared dependency needs review", "Observed declaration"] as const;
    if (ruleId === "docker.daemon_state_bind_mount") return ["Docker daemon-state access needs review", "Observed Docker fact"] as const;
    return ["Internal-network port publication needs review", "Observed Docker facts"] as const;
  };

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
          {findings.findings.map((finding) => {
            if (finding.ruleId === TEMPORAL_FINDING_RULE) {
              // The contract guard above makes this branch safe. Its contents
              // intentionally never render opaque subjects, event IDs,
              // anchors, source times, or daemon-provided copy.
              return <Panel key={finding.id} title="Docker event history needs review" icon="alert" hint="Historical observation">
                <div className="tag-wrap"><Tag tone="muted">Advisory</Tag><Tag tone="muted">Docker event stream</Tag><Tag tone="muted">3 retained observations</Tag></div>
                <p>Three retained Docker event observations fall within the five-minute review threshold.</p>
                <p className="muted-copy"><Link className="ghost-link" to="/changes">Review Change Center <Icon name="arrow" size={14} /></Link> for bounded Docker event observations.</p>
              </Panel>;
            }
            const [title, hint] = presentationFor(finding.ruleId);
            const category = finding.ruleId === "systemd.requires_target_not_active" ? "Systemd Requires" : finding.ruleId === "docker.daemon_state_bind_mount" ? "Docker daemon state" : "Internal network + host port";
            return <Panel key={finding.id} title={title} icon="alert" hint={hint}>
              <div className="tag-wrap"><Tag tone={finding.severity === "warning" ? "warn" : "muted"}>{finding.severity === "warning" ? "Warning" : "Advisory"}</Tag><Tag tone="muted">{category}</Tag><Tag tone="muted">{finding.evidenceRefs.length} supporting fact{finding.evidenceRefs.length === 1 ? "" : "s"}</Tag></div>
              <p>{finding.summary}</p>
              <p className="muted-copy">{finding.recommendation}</p>
              <dl className="detail-grid">
                <div><dt>Declaring service</dt><dd>{finding.subjectRef}</dd></div>
                <div><dt>Target service</dt><dd>{finding.targetRef}</dd></div>
              </dl>
            </Panel>;
          })}
        </div>
      )}
    </div>
  );
}
