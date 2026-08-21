import { useMemo } from "react";
import type { DiagnosticsEntry, DiagnosticsReport } from "@dockermap/contracts";
import { useApp } from "../context";
import { useApiResource } from "../hooks/useApiResource";
import Icon from "../components/Icon";
import { EmptyState, ErrorState, Loading, Panel, Tag } from "../components/primitives";
import { identityText, UNAVAILABLE_DIAGNOSTIC_FILE, UNAVAILABLE_DIAGNOSTIC_MESSAGE, UNAVAILABLE_DIAGNOSTIC_SOURCE, UNAVAILABLE_SERVICE } from "../lib/identity";

const SEVERITY_ORDER = ["blocked", "error", "warning", "info"] as const;
const SOURCE_LABEL = { compose: "Compose", runtime: "Runtime", api: "API" } as const;

export default function Diagnostics() {
  const { tick } = useApp();
  const report = useApiResource<DiagnosticsReport>("/api/diagnostics", tick);

  const entries = report.data?.entries ?? [];

  const { bySeverity, bySource, sorted } = useMemo(() => {
    const severityCounts: Record<string, number> = {};
    const sourceCounts: Record<string, number> = {};
    for (const entry of entries) {
      severityCounts[entry.severity] = (severityCounts[entry.severity] ?? 0) + 1;
      sourceCounts[entry.source] = (sourceCounts[entry.source] ?? 0) + 1;
    }
    const ordered = [...entries].sort((left, right) => {
      const leftRank = SEVERITY_ORDER.indexOf(left.severity as (typeof SEVERITY_ORDER)[number]);
      const rightRank = SEVERITY_ORDER.indexOf(right.severity as (typeof SEVERITY_ORDER)[number]);
      if (leftRank !== rightRank) {
        return (leftRank === -1 ? SEVERITY_ORDER.length : leftRank) - (rightRank === -1 ? SEVERITY_ORDER.length : rightRank);
      }
      return left.message.localeCompare(right.message);
    });
    return { bySeverity: severityCounts, bySource: sourceCounts, sorted: ordered };
  }, [entries]);

  if (report.loading && !report.data) return <Loading label="Collecting diagnostics…" />;
  if (report.error) return <ErrorState title="Diagnostics unavailable" body={report.error} />;

  const download = () => {
    if (!report.data) return;
    const blob = new Blob([JSON.stringify(report.data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `dockermap-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <div className="eyebrow">Validation and provider health</div>
          <h1 className="screen-title">Diagnostics</h1>
        </div>
        <div className="screen-actions">
          {entries.length > 0 && (
            <button type="button" className="ghost-link" onClick={download}>
              <Icon name="down" size={14} /> Export JSON
            </button>
          )}
        </div>
      </header>

      <div className="metric-row">
        {SEVERITY_ORDER.map((severity) => (
          <div key={severity} className="metric">
            <div className="metric-label">
              <Tag tone={severity === "info" ? "muted" : severity === "warning" ? "warn" : "error"}>{severity}</Tag>
            </div>
            <div className="metric-value">{bySeverity[severity] ?? 0}</div>
          </div>
        ))}
        <div className="metric">
          <div className="metric-label">Sources</div>
          <div className="metric-value">
            {Object.keys(bySource)
              .map((source) => `${SOURCE_LABEL[source as keyof typeof SOURCE_LABEL] ?? identityText(source, UNAVAILABLE_DIAGNOSTIC_SOURCE)}:${bySource[source]}`)
              .join(" · ")}
          </div>
        </div>
      </div>

      {entries.length === 0 ? (
        <EmptyState
          icon="check"
          title="No diagnostics"
          body="Compose validation and every runtime provider returned cleanly. Re-check after a refresh if you expect findings."
        />
      ) : (
        <Panel title="Findings" icon="alert" hint={`${entries.length}`}>
          <ul className="diag-list">
            {sorted.map((entry: DiagnosticsEntry, index) => (
              <li key={`${entry.source}-${entry.id ?? "entry"}-${index}`} className={`diag-row sev-${entry.severity}`}>
                <Icon name="alert" size={13} />
                <span className="diag-message">{identityText(entry.message, UNAVAILABLE_DIAGNOSTIC_MESSAGE)}</span>
                <Tag tone={entry.severity === "info" ? "muted" : entry.severity === "warning" ? "warn" : "error"}>{entry.severity}</Tag>
                <Tag tone="muted">{SOURCE_LABEL[entry.source] ?? UNAVAILABLE_DIAGNOSTIC_SOURCE}</Tag>
                {entry.service !== null && <Tag tone="muted">{identityText(entry.service, UNAVAILABLE_SERVICE)}</Tag>}
                {entry.file !== null && <code className="diag-file">{identityText(entry.file, UNAVAILABLE_DIAGNOSTIC_FILE)}</code>}
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
