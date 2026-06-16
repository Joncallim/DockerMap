import { Link } from "react-router-dom";
import type { NetworkRecord } from "@dockermap/contracts";
import { useApiResource } from "../hooks/useApiResource";
import { useSearchParamState } from "../hooks/useSearchParamState";
import EmptyPanel from "../components/EmptyPanel";
import StatePanel from "../components/StatePanel";

export default function NetworksPage(props: { heartbeat: number }) {
  const { searchParams } = useSearchParamState();
  const resource = useApiResource<{ networks: NetworkRecord[] }>("/api/networks", props.heartbeat);
  const focus = searchParams.get("network");

  if (resource.loading) {
    return <StatePanel title="Loading networks" body="Resolving bridge zones and service membership." />;
  }

  if (resource.error || !resource.data) {
    return <StatePanel title="Networks unavailable" body={resource.error ?? "Unknown failure"} tone="error" />;
  }

  const networks = focus
    ? resource.data.networks.filter((network) => network.id === focus || network.name === focus)
    : resource.data.networks;

  return (
    <section className="card-grid">
      {networks.length === 0 ? (
        <EmptyPanel title="No networks match this focus." body="Try clearing the selected network chip." />
      ) : (
        networks.map((network) => (
          <article className="panel-card" key={network.id}>
            <div className="panel-label">{network.internal ? "Internal network" : "Network"}</div>
            <h3>{network.name}</h3>
            <p className="subtle-copy">{network.driver}</p>
            <div className="pill-row">
              {network.members.map((member) => (
                <Link key={member} className="pill" to={`/containers/${member}`}>
                  {member}
                </Link>
              ))}
            </div>
          </article>
        ))
      )}
    </section>
  );
}
