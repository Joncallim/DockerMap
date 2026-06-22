import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { ContainerRecord } from "@dockermap/contracts";
import { useApiResource } from "../hooks/useApiResource";
import { useSearchParamState } from "../hooks/useSearchParamState";
import Icon from "../components/Icon";
import { Badge, Chip, PageHead, StateView, StatusDot, toneForStatus } from "../components/ui";

const FILTERS = [
  { key: "", label: "All" },
  { key: "running", label: "Running" },
  { key: "exited", label: "Exited" },
];

export default function ContainersPage(props: { heartbeat: number }) {
  const { searchParams, update } = useSearchParamState();
  const resource = useApiResource<{ containers: ContainerRecord[] }>("/api/containers", props.heartbeat);
  const q = (searchParams.get("q") ?? "").toLowerCase();
  const status = searchParams.get("status") ?? "";

  const containers = useMemo(() => {
    if (!resource.data) return [];
    return resource.data.containers.filter((container) => {
      const matchesQuery =
        q.length === 0 ||
        [container.name, container.image, container.role].some((value) => value.toLowerCase().includes(q));
      const matchesStatus = status.length === 0 || container.status === status;
      return matchesQuery && matchesStatus;
    });
  }, [q, resource.data, status]);

  if (resource.loading) {
    return <StateView kind="loading" title="Loading containers" body="Collecting runtime inventory from the daemon." icon="container" />;
  }
  if (resource.error || !resource.data) {
    return <StateView kind="error" title="Containers unavailable" body={resource.error ?? "Unknown failure"} />;
  }

  const total = resource.data.containers.length;

  return (
    <section className="stack">
      <PageHead
        eyebrow="Runtime inventory"
        title="Container Index"
        subtitle="Running services, their reachable networks and dependency edges."
        actions={
          <div className="chip-row">
            {FILTERS.map((f) => (
              <Chip key={f.key} active={status === f.key} onClick={() => update({ status: f.key || null })}>
                {f.label}
              </Chip>
            ))}
          </div>
        }
      />

      <section className="section section-flush">
        <div className="table" role="table">
          <div className="table-head" role="row">
            <span>Service</span>
            <span>Status</span>
            <span>Networks</span>
            <span>Ports</span>
            <span>Depends on</span>
            <span />
          </div>
          {containers.length === 0 ? (
            <StateView kind="empty" title="No containers match" body="Try clearing the query or switching status filter." icon="search" />
          ) : (
            containers.map((c) => (
              <div className="table-row" role="row" key={c.id}>
                <div className="cell-primary">
                  <Link className="cell-name" to={`/containers/${c.name}`}>
                    {c.name}
                  </Link>
                  <code className="cell-mono">{c.image}</code>
                </div>
                <div>
                  <span className="status-text">
                    <StatusDot status={c.status} pulse={c.status.toLowerCase() === "running"} />
                    <span className={`status-${toneForStatus(c.status)}`}>{c.status}</span>
                  </span>
                  <div className="cell-sub">{c.role}</div>
                </div>
                <div className="chip-row">
                  {c.networks.length === 0 ? (
                    <span className="cell-sub">—</span>
                  ) : (
                    c.networks.map((n) => (
                      <Link className="chip" key={n} to={`/networks?network=${n}`}>
                        {n.replace("network_", "")}
                      </Link>
                    ))
                  )}
                </div>
                <div className="port-list">
                  {c.ports.length === 0 ? (
                    <span className="cell-sub">none</span>
                  ) : (
                    c.ports.map((p) => (
                      <code className="port" key={p}>
                        {p}
                      </code>
                    ))
                  )}
                </div>
                <div>
                  {c.dependsOn.length === 0 ? (
                    <span className="cell-sub">—</span>
                  ) : (
                    <Badge tone="neutral">{c.dependsOn.length} upstream</Badge>
                  )}
                </div>
                <Link className="btn btn-ghost btn-sm" to={`/logs?service=${c.name}`}>
                  <Icon name="logs" size={15} />
                  Logs
                </Link>
              </div>
            ))
          )}
        </div>
        <footer className="table-foot">
          Showing {containers.length} of {total} containers
        </footer>
      </section>
    </section>
  );
}
