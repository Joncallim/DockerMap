import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { ContainerRecord } from "@dockermap/contracts";
import { useApiResource } from "../hooks/useApiResource";
import { useSearchParamState } from "../hooks/useSearchParamState";
import EmptyPanel from "../components/EmptyPanel";
import StatePanel from "../components/StatePanel";

export default function ContainersPage(props: { heartbeat: number }) {
  const { searchParams, update } = useSearchParamState();
  const resource = useApiResource<{ containers: ContainerRecord[] }>("/api/containers", props.heartbeat);
  const q = (searchParams.get("q") ?? "").toLowerCase();
  const status = searchParams.get("status") ?? "";

  const containers = useMemo(() => {
    if (!resource.data) {
      return [];
    }
    return resource.data.containers.filter((container) => {
      const matchesQuery =
        q.length === 0 ||
        [container.name, container.image, container.role].some((value) =>
          value.toLowerCase().includes(q),
        );
      const matchesStatus = status.length === 0 || container.status === status;
      return matchesQuery && matchesStatus;
    });
  }, [q, resource.data, status]);

  if (resource.loading) {
    return <StatePanel title="Loading containers" body="Collecting runtime inventory from the daemon." />;
  }

  if (resource.error || !resource.data) {
    return <StatePanel title="Containers unavailable" body={resource.error ?? "Unknown failure"} tone="error" />;
  }

  return (
    <section className="stack">
      <div className="page-header">
        <div>
          <div className="panel-label">Container Index</div>
          <h2>Running services and dependency flow.</h2>
        </div>
        <div className="pill-row">
          <button className={`pill ${status === "" ? "active-pill" : ""}`} onClick={() => update({ status: null })}>
            All
          </button>
          <button className={`pill ${status === "running" ? "active-pill" : ""}`} onClick={() => update({ status: "running" })}>
            Running
          </button>
          <button className={`pill ${status === "exited" ? "active-pill" : ""}`} onClick={() => update({ status: "exited" })}>
            Exited
          </button>
        </div>
      </div>

      <div className="table-panel">
        {containers.length === 0 ? (
          <EmptyPanel title="No containers match this filter." body="Try clearing the query or switching status." />
        ) : (
          containers.map((container) => (
            <div className="table-row" key={container.id}>
              <div>
                <Link className="inline-link" to={`/containers/${container.name}`}>
                  {container.name}
                </Link>
                <div className="subtle-copy">{container.image}</div>
              </div>
              <div className="subtle-copy">{container.role}</div>
              <div className="pill-row">
                {container.networks.slice(0, 2).map((networkId) => (
                  <Link className="pill" key={networkId} to={`/networks?network=${networkId}`}>
                    {networkId.replace("network_", "")}
                  </Link>
                ))}
              </div>
              <Link className="ghost-button small" to={`/logs?service=${container.name}`}>
                Logs
              </Link>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
