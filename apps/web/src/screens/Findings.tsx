import { Link } from "react-router-dom";
import { useApp } from "../context";
import Icon from "../components/Icon";
import { EmptyState, Loading, Panel, Tag } from "../components/primitives";

const TEMPORAL_RULE = "docker.repeated_container_died_events";

/** A second strict browser boundary for the static temporal projection. */
function isCoherentTemporalFinding(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const finding = value as Record<string, unknown>;
  const keys = Object.keys(finding);
  const expected = ["id", "ruleId", "severity", "summary", "recommendation", "evidenceRefs", "temporalEvidence"];
  if (keys.length !== expected.length || !expected.every((key) => Object.hasOwn(finding, key))) return false;
  if (finding.id !== "finding_docker_repeated_container_died_events"
    || finding.ruleId !== TEMPORAL_RULE
    || finding.severity !== "advisory"
    || finding.summary !== "Three retained Docker container exit observations need review."
    || finding.recommendation !== "Review the container's recent configuration and logs to determine whether the repeated exits are expected."
    || !Array.isArray(finding.evidenceRefs) || finding.evidenceRefs.length !== 0
    || !Array.isArray(finding.temporalEvidence) || finding.temporalEvidence.length !== 3) return false;
  return finding.temporalEvidence.every((witness) => {
    if (!witness || typeof witness !== "object" || Array.isArray(witness)) return false;
    const row = witness as Record<string, unknown>;
    const witnessKeys = Object.keys(row);
    return witnessKeys.length === 2 && witnessKeys.includes("source") && witnessKeys.includes("kind")
      && row.source === "docker_event_stream" && row.kind === "container_died";
  });
}

export default function Findings() {
  const { findings: response, loading, evidenceMode, modelProvenance, model } = useApp();
  // AppShell provides a revision-coherent live response. Keep the temporal
  // card independently guarded so a future direct context consumer cannot
  // relabel demo/mock/stale data as a host historical observation.
  const temporalAuthority = evidenceMode === "live"
    && modelProvenance === "live"
    && model !== null
    && response?.modelRevision === model.modelRevision;
  const temporalFindingCount = response?.findings.filter((finding) => finding.ruleId === TEMPORAL_RULE).length ?? 0;
  const findings = response ? {
    ...response,
    findings: response.findings.filter((finding) => finding.ruleId !== TEMPORAL_RULE
      || (temporalAuthority && temporalFindingCount === 1 && isCoherentTemporalFinding(finding)))
  } : null;

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
            if (finding.ruleId === TEMPORAL_RULE) {
              // Deliberately render only fixed copy. No ID, subject, target,
              // event time, evidence object, service relation or raw Docker
              // material crosses this presentation boundary.
              return <Panel key={finding.id} title="Docker event history needs review" icon="alert" hint="Historical observation">
                <div className="tag-wrap"><Tag tone="muted">Advisory</Tag><Tag tone="muted">Docker event stream</Tag><Tag tone="muted">3 retained observations</Tag></div>
                <p>Three retained Docker exit observations met the short review threshold.</p>
                <p className="muted-copy"><Link className="ghost-link" to="/changes">Review Change Center <Icon name="arrow" size={14} /></Link></p>
              </Panel>;
            }
            if (finding.ruleId !== "systemd.requires_target_not_active"
              && finding.ruleId !== "docker.daemon_state_bind_mount"
              && finding.ruleId !== "docker.internal_network_member_publishes_port") return null;
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
