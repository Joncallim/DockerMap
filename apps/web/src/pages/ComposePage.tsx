import { useMemo } from "react";
import type {
  ComposeDiagnostic,
  ComposeGraph,
  ComposeGraphNode,
  ComposeMount,
  ComposeScan,
  ComposeService,
  MountCorrelation,
} from "@dockermap/contracts";
import { useApiResource } from "../hooks/useApiResource";
import { useSearchParamState } from "../hooks/useSearchParamState";
import Icon from "../components/Icon";
import { Badge, Kpi, PageHead, SectionCard, StateView, type Tone } from "../components/ui";

function severityRank(d: ComposeDiagnostic) {
  return ["blocked", "error", "warning", "info"].indexOf(d.severity);
}
function shortPath(path: string) {
  const parts = path.split("/");
  return parts.length > 3 ? parts.slice(-3).join("/") : path;
}
function composePath(file: string | null) {
  return file ? `/api/compose/scan?${new URLSearchParams({ file })}` : "/api/compose/scan";
}
function composeGraphPath(file: string | null) {
  return file ? `/api/compose/graph?${new URLSearchParams({ file })}` : "/api/compose/graph";
}
function matchesQuery(values: Array<string | null | undefined>, query: string) {
  return !query || values.some((value) => value?.toLowerCase().includes(query));
}

const SEVERITY_TONE: Record<string, Tone> = { blocked: "err", error: "err", warning: "warn", info: "info" };
const STATUS_TONE: Record<string, Tone> = { matched: "ok", missing: "err", extra: "warn" };
const NODE_TONE: Record<string, Tone> = {
  service: "aqua",
  container_path: "aqua",
  host_path: "ok",
  named_volume: "gold",
  anonymous_volume: "gold",
};

export default function ComposePage(props: { heartbeat: number }) {
  const { searchParams, update } = useSearchParamState();
  const q = (searchParams.get("q") ?? "").toLowerCase();
  const focusedFile = searchParams.get("file");
  const scan = useApiResource<ComposeScan>(composePath(focusedFile), props.heartbeat);
  const graph = useApiResource<ComposeGraph>(composeGraphPath(focusedFile), props.heartbeat);

  const filtered = useMemo(() => {
    const empty = {
      services: [] as ComposeService[],
      mounts: [] as ComposeMount[],
      correlations: [] as MountCorrelation[],
      diagnostics: [] as ComposeDiagnostic[],
      graphNodes: [] as ComposeGraphNode[],
    };
    if (!scan.data || !graph.data) return empty;

    const services = scan.data.services.filter((s) => matchesQuery([s.name, s.image, ...s.dependsOn], q));
    const mounts = scan.data.mounts.filter((m) =>
      matchesQuery([m.service, m.kind, m.source, m.resolvedSource, m.target, m.origin.file, m.origin.field], q),
    );
    const diagnostics = scan.data.diagnostics
      .filter((d) => matchesQuery([d.id, d.severity, d.message, d.origin.file, d.origin.service, d.origin.field], q))
      .sort((l, r) => severityRank(l) - severityRank(r));
    const correlations = scan.data.correlations.filter((c) =>
      matchesQuery([c.service, c.container, c.kind, c.target, c.declaredSource, c.runtimeSource, c.status], q),
    );
    const graphNodes = graph.data.nodes.filter((n) => matchesQuery([n.type, n.label], q));
    return { services, mounts, correlations, diagnostics, graphNodes };
  }, [graph.data, q, scan.data]);

  if (scan.loading || graph.loading) {
    return <StateView kind="loading" title="Scanning Compose" body="Reading Compose files, services, mounts and graph edges." icon="compose" />;
  }
  if (scan.error || graph.error || !scan.data || !graph.data) {
    return <StateView kind="error" title="Compose unavailable" body={scan.error ?? graph.error ?? "Unknown failure"} />;
  }

  return (
    <section className="stack">
      <PageHead
        eyebrow="Declared vs running"
        title="Compose"
        subtitle="Services, mount paths, file provenance and runtime drift."
        actions={
          <select
            className="select"
            value={focusedFile ?? ""}
            onChange={(event) => update({ file: event.target.value || null })}
            aria-label="Compose file focus"
          >
            <option value="">Discovered files</option>
            {scan.data.files.map((file) => (
              <option key={file} value={file}>
                {shortPath(file)}
              </option>
            ))}
          </select>
        }
      />

      <div className="kpi-row">
        <Kpi icon="compose" label="Files" value={scan.data.files.length} accent="aqua" sub={shortPath(scan.data.projectRoot)} />
        <Kpi icon="container" label="Services" value={filtered.services.length} accent="aqua" sub="Service declarations" />
        <Kpi icon="volume" label="Mounts" value={filtered.mounts.length} accent="gold" sub="Bind & volume declarations" />
        <Kpi icon="link" label="Runtime drift" value={filtered.correlations.length} accent="gold" sub="Matched, missing, extra" />
        <Kpi icon="shield" label="Diagnostics" value={filtered.diagnostics.length} accent="aqua" sub="Warnings, errors, blockers" />
      </div>

      <div className="compose-layout">
        <SectionCard eyebrow="Mount graph" title="Declarations" icon="layers">
          {filtered.graphNodes.length === 0 ? (
            <StateView kind="empty" title="No graph nodes match" body="Clear the query to see all Compose graph nodes." icon="search" />
          ) : (
            <div className="node-grid">
              {filtered.graphNodes.map((node) => (
                <div className="gnode" key={node.id}>
                  <Badge tone={NODE_TONE[node.type] ?? "neutral"}>{node.type.replace("_", " ")}</Badge>
                  <strong>{node.label}</strong>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard eyebrow="Compose file" title="Services" icon="container">
          {filtered.services.length === 0 ? (
            <StateView kind="empty" title="No services match" body="Clear the query or scan a Compose file with services." icon="search" />
          ) : (
            <div className="mini-list">
              {filtered.services.map((s) => (
                <div className="mini-row mini-static" key={s.name}>
                  <div className="mini-main">
                    <span className="mini-name">{s.name}</span>
                    <span className="mini-sub mono">{s.image ?? "no image declared"}</span>
                  </div>
                  <div className="chip-row">
                    {s.dependsOn.length === 0 ? (
                      <span className="cell-sub">no deps</span>
                    ) : (
                      s.dependsOn.map((d) => (
                        <span className="chip" key={d}>
                          {d}
                        </span>
                      ))
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard eyebrow="Provenance" title="Mounts" icon="volume">
        {filtered.mounts.length === 0 ? (
          <StateView kind="empty" title="No mounts match" body="No bind, named, or anonymous volume declarations for this view." icon="volume" />
        ) : (
          <div className="mounts mounts-4">
            <div className="mounts-head">
              <span>Service</span>
              <span>Source</span>
              <span>Target</span>
              <span>Origin</span>
            </div>
            {filtered.mounts.map((m) => (
              <div className="mounts-row" key={m.id}>
                <div>
                  <strong className="cell-name">{m.service}</strong>
                  <div className="mounts-tags">
                    <Badge tone={m.kind === "bind" ? "ok" : "gold"}>{m.kind.replace("_", " ")}</Badge>
                    {m.readOnly && <Badge tone="warn">ro</Badge>}
                  </div>
                </div>
                <code className="path" title={m.resolvedSource ?? m.source ?? "anonymous volume"}>
                  {m.resolvedSource ?? m.source ?? "anonymous volume"}
                </code>
                <code className="path path-target" title={m.target}>
                  {m.target}
                </code>
                <div className="mounts-origin">
                  <code title={m.origin.file}>{shortPath(m.origin.file)}</code>
                  <span className="cell-sub">{m.origin.field}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard eyebrow="Declared vs running" title="Runtime check" icon="link">
        {filtered.correlations.length === 0 ? (
          <div className="ok-strip">
            <Icon name="shield" size={16} />
            No runtime mount differences in the current scan.
          </div>
        ) : (
          <div className="strips">
            {filtered.correlations.map((c) => (
              <article className={`strip strip-${STATUS_TONE[c.status] ?? "info"}`} key={c.id}>
                <Badge tone={STATUS_TONE[c.status] ?? "info"}>{c.status}</Badge>
                <div className="strip-body">
                  <strong>
                    {c.service}
                    {c.container ? ` · ${c.container}` : ""} · {c.target}
                  </strong>
                  <span className="cell-sub mono">
                    {c.declaredSource ?? "not declared"} → {c.runtimeSource ?? "not mounted"}
                  </span>
                </div>
                <code className="strip-kind">{c.kind.replace("_", " ")}</code>
              </article>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard eyebrow="Lints" title="Diagnostics" icon="shield">
        {filtered.diagnostics.length === 0 ? (
          <div className="ok-strip">
            <Icon name="shield" size={16} />
            No Compose diagnostics in the current scan.
          </div>
        ) : (
          <div className="strips">
            {filtered.diagnostics.map((d, i) => (
              <article className={`strip strip-${SEVERITY_TONE[d.severity] ?? "info"}`} key={`${d.id}-${i}`}>
                <Badge tone={SEVERITY_TONE[d.severity] ?? "info"}>{d.severity}</Badge>
                <div className="strip-body">
                  <strong>{d.message}</strong>
                  <span className="cell-sub">
                    {shortPath(d.origin.file)}
                    {d.origin.service ? ` · ${d.origin.service}` : ""} · {d.origin.field}
                  </span>
                </div>
                <code className="strip-kind">{d.id}</code>
              </article>
            ))}
          </div>
        )}
      </SectionCard>
    </section>
  );
}
