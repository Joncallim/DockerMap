import { useMemo } from "react";
import type {
  ComposeDiagnostic,
  ComposeGraph,
  ComposeGraphNode,
  ComposeMount,
  ComposeScan,
  ComposeService,
  MountCorrelation
} from "@dockermap/contracts";
import { useApiResource } from "../hooks/useApiResource";
import { useSearchParamState } from "../hooks/useSearchParamState";
import EmptyPanel from "../components/EmptyPanel";
import KpiCard from "../components/KpiCard";
import StatePanel from "../components/StatePanel";

function severityRank(diagnostic: ComposeDiagnostic) {
  return ["blocked", "error", "warning", "info"].indexOf(diagnostic.severity);
}

function shortPath(path: string) {
  const parts = path.split("/");
  return parts.length > 3 ? parts.slice(-3).join("/") : path;
}

function composePath(file: string | null) {
  if (!file) {
    return "/api/compose/scan";
  }
  return `/api/compose/scan?${new URLSearchParams({ file }).toString()}`;
}

function composeGraphPath(file: string | null) {
  if (!file) {
    return "/api/compose/graph";
  }
  return `/api/compose/graph?${new URLSearchParams({ file }).toString()}`;
}

function matchesQuery(values: Array<string | null | undefined>, query: string) {
  if (!query) {
    return true;
  }
  return values.some((value) => value?.toLowerCase().includes(query));
}

function ComposeNode(props: { node: ComposeGraphNode }) {
  return (
    <div className={`compose-node compose-${props.node.type}`}>
      <span>{props.node.type.replace("_", " ")}</span>
      <strong>{props.node.label}</strong>
    </div>
  );
}

function ServiceList(props: { services: ComposeService[] }) {
  if (props.services.length === 0) {
    return <EmptyPanel title="No services match this search." body="Clear the query or scan a Compose file with services." />;
  }

  return (
    <section className="compose-service-grid" aria-label="Compose services">
      {props.services.map((service) => (
        <article className="panel-card compact" key={service.name}>
          <div className="panel-label">Service</div>
          <strong>{service.name}</strong>
          <div className="subtle-copy">{service.image ?? "No image declared"}</div>
          <div className="pill-row">
            {service.dependsOn.length === 0 ? (
              <span className="pill muted-pill">No dependencies</span>
            ) : (
              service.dependsOn.map((dependency) => (
                <span className="pill" key={dependency}>
                  {dependency}
                </span>
              ))
            )}
          </div>
        </article>
      ))}
    </section>
  );
}

function MountTable(props: { mounts: ComposeMount[] }) {
  if (props.mounts.length === 0) {
    return <EmptyPanel title="No mounts match this search." body="DockerMap found no bind, named, or anonymous volume declarations for this view." />;
  }

  return (
    <section className="compose-mount-panel" aria-label="Compose mount declarations">
      <div className="compose-mount-header">
        <span>Service</span>
        <span>Source</span>
        <span>Target</span>
        <span>Origin</span>
      </div>
      {props.mounts.map((mount) => (
        <div className="compose-mount-row" key={mount.id}>
          <div>
            <strong>{mount.service}</strong>
            <div className={`mount-kind mount-${mount.kind}`}>{mount.kind.replace("_", " ")}</div>
          </div>
          <code className="path-tag" title={mount.resolvedSource ?? mount.source ?? "anonymous volume"}>
            {mount.resolvedSource ?? mount.source ?? "anonymous volume"}
          </code>
          <code className="path-tag container-path" title={mount.target}>
            {mount.target}
          </code>
          <div>
            <code className="origin-tag" title={mount.origin.file}>
              {shortPath(mount.origin.file)}
            </code>
            <div className="subtle-copy">{mount.origin.field}</div>
            {mount.readOnly ? <span className="readonly-flag">read only</span> : null}
          </div>
        </div>
      ))}
    </section>
  );
}

function DiagnosticList(props: { diagnostics: ComposeDiagnostic[] }) {
  if (props.diagnostics.length === 0) {
    return (
      <section className="info-panel">
        <div className="panel-label">Diagnostics</div>
        <div className="healthy-strip">No Compose diagnostics in the current scan.</div>
      </section>
    );
  }

  return (
    <section className="diagnostic-panel" aria-label="Compose diagnostics">
      <div className="panel-label">Diagnostics</div>
      {props.diagnostics.map((diagnostic, index) => (
        <article
          className={`diagnostic-strip severity-${diagnostic.severity}`}
          key={`${diagnostic.id}-${diagnostic.origin.file}-${diagnostic.origin.field}-${index}`}
        >
          <div>
            <span>{diagnostic.severity}</span>
            <strong>{diagnostic.message}</strong>
          </div>
          <code>{diagnostic.id}</code>
          <div className="subtle-copy">
            {shortPath(diagnostic.origin.file)}
            {diagnostic.origin.service ? ` / ${diagnostic.origin.service}` : ""} / {diagnostic.origin.field}
          </div>
        </article>
      ))}
    </section>
  );
}

function CorrelationList(props: { correlations: MountCorrelation[] }) {
  if (props.correlations.length === 0) {
    return (
      <section className="info-panel">
        <div className="panel-label">Runtime Check</div>
        <div className="healthy-strip">No runtime mount differences in the current scan.</div>
      </section>
    );
  }

  return (
    <section className="diagnostic-panel" aria-label="Compose runtime mount correlation">
      <div className="panel-label">Runtime Check</div>
      {props.correlations.map((correlation) => (
        <article className={`diagnostic-strip status-${correlation.status}`} key={correlation.id}>
          <div>
            <span>{correlation.status}</span>
            <strong>
              {correlation.service}
              {correlation.container ? ` / ${correlation.container}` : ""} / {correlation.target}
            </strong>
          </div>
          <code>{correlation.kind.replace("_", " ")}</code>
          <div className="subtle-copy">
            {correlation.declaredSource ?? "not declared"}
            {" -> "}
            {correlation.runtimeSource ?? "not mounted"}
          </div>
        </article>
      ))}
    </section>
  );
}

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
      graphNodes: [] as ComposeGraphNode[]
    };

    if (!scan.data || !graph.data) {
      return empty;
    }

    const services = scan.data.services.filter((service) =>
      matchesQuery([service.name, service.image, ...service.dependsOn], q),
    );
    const mounts = scan.data.mounts.filter((mount) =>
      matchesQuery(
        [
          mount.service,
          mount.kind,
          mount.source,
          mount.resolvedSource,
          mount.target,
          mount.origin.file,
          mount.origin.field
        ],
        q,
      ),
    );
    const diagnostics = [...scan.data.diagnostics.filter((diagnostic) =>
        matchesQuery(
          [
            diagnostic.id,
            diagnostic.severity,
            diagnostic.message,
            diagnostic.origin.file,
            diagnostic.origin.service,
            diagnostic.origin.field
          ],
          q,
        ),
      )].sort((left, right) => severityRank(left) - severityRank(right));
    const correlations = scan.data.correlations.filter((correlation) =>
      matchesQuery(
        [
          correlation.service,
          correlation.container,
          correlation.kind,
          correlation.target,
          correlation.declaredSource,
          correlation.runtimeSource,
          correlation.status
        ],
        q,
      ),
    );
    const graphNodes = graph.data.nodes.filter((node) => matchesQuery([node.type, node.label], q));

    return { services, mounts, correlations, diagnostics, graphNodes };
  }, [graph.data, q, scan.data]);

  if (scan.loading || graph.loading) {
    return <StatePanel title="Scanning Compose" body="Reading Compose files, services, mounts, and graph edges." />;
  }

  if (scan.error || graph.error || !scan.data || !graph.data) {
    return <StatePanel title="Compose unavailable" body={scan.error ?? graph.error ?? "Unknown failure"} tone="error" />;
  }

  return (
    <section className="stack">
      <div className="page-header">
        <div>
          <div className="panel-label">Compose Map</div>
          <h2>Declared services, mount paths, and file provenance.</h2>
        </div>
        <select
          className="service-select"
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
      </div>

      <section className="kpi-grid">
        <KpiCard label="Files" value={scan.data.files.length} detail={shortPath(scan.data.projectRoot)} />
        <KpiCard label="Services" value={filtered.services.length} detail="Compose service declarations" />
        <KpiCard label="Mounts" value={filtered.mounts.length} detail="Bind and volume declarations" />
        <KpiCard label="Runtime" value={filtered.correlations.length} detail="Matched, missing, and extra mounts" />
        <KpiCard label="Diagnostics" value={filtered.diagnostics.length} detail="Warnings, errors, and blockers" />
      </section>

      <section className="compose-layout">
        <section className="hero-panel">
          <div className="panel-label">Mount Graph</div>
          {filtered.graphNodes.length === 0 ? (
            <EmptyPanel title="No graph nodes match this search." body="Clear the query to see all Compose graph nodes." />
          ) : (
            <div className="compose-graph-grid">
              {filtered.graphNodes.map((node) => (
                <ComposeNode key={node.id} node={node} />
              ))}
            </div>
          )}
          <div className="edge-list">
            {graph.data.edges.slice(0, 12).map((edge, index) => (
              <div className="edge-row" key={`${edge.source}-${edge.target}-${index}`}>
                <span>{edge.source.replace("compose_", "")}</span>
                <span>{edge.relationship}</span>
                <span>{edge.target.replace("compose_", "")}</span>
              </div>
            ))}
          </div>
        </section>

        <ServiceList services={filtered.services} />
      </section>

      <MountTable mounts={filtered.mounts} />
      <CorrelationList correlations={filtered.correlations} />
      <DiagnosticList diagnostics={filtered.diagnostics} />
    </section>
  );
}
