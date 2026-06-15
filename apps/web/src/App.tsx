import { useEffect, useMemo, useState } from "react";
import {
  Link,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams
} from "react-router-dom";
import type {
  ContainerRecord,
  DockerSnapshot,
  GraphResponse,
  HealthResponse,
  ImageRecord,
  LogsResponse,
  NetworkRecord,
  VolumeRecord
} from "@dockermap/contracts";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4000";

const navigation = [
  { path: "/", label: "Dashboard" },
  { path: "/containers", label: "Containers" },
  { path: "/images", label: "Images" },
  { path: "/networks", label: "Networks" },
  { path: "/volumes", label: "Volumes" },
  { path: "/logs", label: "Logs" }
] as const;

type ResourceState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
};

function apiUrl(path: string) {
  return `${API_BASE}${path}`;
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(apiUrl(path));
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

function useApiResource<T>(path: string, refreshTick = 0): ResourceState<T> {
  const [state, setState] = useState<ResourceState<T>>({
    data: null,
    error: null,
    loading: true
  });

  useEffect(() => {
    let cancelled = false;
    setState((current) => ({ ...current, loading: true, error: null }));

    fetchJson<T>(path)
      .then((data) => {
        if (!cancelled) {
          setState({ data, error: null, loading: false });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setState({
            data: null,
            error: error instanceof Error ? error.message : "Unknown request failure",
            loading: false
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [path, refreshTick]);

  return state;
}

function useDaemonHeartbeat() {
  const [tick, setTick] = useState(0);
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    const source = new EventSource(apiUrl("/api/events/stream"));

    source.addEventListener("snapshot", (event) => {
      const message = JSON.parse((event as MessageEvent).data) as HealthResponse;
      setHealth(message);
      setTick((value) => value + 1);
    });

    source.addEventListener("error", () => {
      setHealth((current) =>
        current
          ? { ...current, status: "degraded", message: "Live stream interrupted" }
          : current,
      );
    });

    return () => {
      source.close();
    };
  }, []);

  return { tick, health };
}

function useSearchParamState() {
  const [searchParams, setSearchParams] = useSearchParams();

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "") {
        next.delete(key);
      } else {
        next.set(key, value);
      }
    }
    setSearchParams(next);
  };

  return { searchParams, update };
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    day: "numeric"
  }).format(new Date(timestamp));
}

function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const { health } = useDaemonHeartbeat();
  const [searchParams] = useSearchParams();
  const [draftQuery, setDraftQuery] = useState(searchParams.get("q") ?? "");

  useEffect(() => {
    setDraftQuery(searchParams.get("q") ?? "");
  }, [searchParams]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = new URLSearchParams(searchParams);
      if (draftQuery) {
        next.set("q", draftQuery);
      } else {
        next.delete("q");
      }
      navigate(`${location.pathname}?${next.toString()}`, { replace: true });
    }, 250);

    return () => {
      window.clearTimeout(timer);
    };
  }, [draftQuery, location.pathname, navigate, searchParams]);

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand-lockup">
          <div className="brand-mark">DM</div>
          <div>
            <div className="brand-title">DockerMap</div>
            <div className="brand-subtitle">Kinetic Engine</div>
          </div>
        </div>

        <div className="engine-card">
          <div className={`status-dot ${health?.dockerReachable ? "up" : "down"}`} />
          <div>
            <div className="panel-label">Host</div>
            <div className="panel-title">{health?.mode === "docker" ? "Docker Socket" : "Mock Engine"}</div>
          </div>
        </div>

        <nav className="nav-list">
          {navigation.map((item) => (
            <NavLink key={item.path} to={item.path} end={item.path === "/"}>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="side-meta">
          <div className="panel-label">Daemon</div>
          <div className={`daemon-state daemon-${health?.status ?? "degraded"}`}>
            {health?.status ?? "connecting"}
          </div>
          <p>{health?.message ?? "Waiting for daemon heartbeat."}</p>
          <div className="panel-foot">
            {health ? `Updated ${formatTime(health.lastUpdated)}` : "No live data yet"}
          </div>
        </div>
      </aside>

      <div className="surface">
        <header className="topbar">
          <div>
            <div className="eyebrow">Observe Mode</div>
            <h1>Single-host Docker graph and inventory.</h1>
          </div>
          <div className="toolbar">
            <input
              value={draftQuery}
              onChange={(event) => setDraftQuery(event.target.value)}
              className="search-input"
              placeholder="Search services, images, networks, volumes"
            />
            <Link className="ghost-button" to="/logs">
              Open Logs
            </Link>
          </div>
        </header>

        <main className="content">
          <Routes>
            <Route path="/" element={<DashboardPage heartbeat={health?.lastUpdated ?? 0} />} />
            <Route path="/containers" element={<ContainersPage heartbeat={health?.lastUpdated ?? 0} />} />
            <Route path="/containers/:name" element={<ContainerDetailPage heartbeat={health?.lastUpdated ?? 0} />} />
            <Route path="/images" element={<ImagesPage heartbeat={health?.lastUpdated ?? 0} />} />
            <Route path="/networks" element={<NetworksPage heartbeat={health?.lastUpdated ?? 0} />} />
            <Route path="/volumes" element={<VolumesPage heartbeat={health?.lastUpdated ?? 0} />} />
            <Route path="/logs" element={<LogsPage heartbeat={health?.lastUpdated ?? 0} />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </main>

        <nav className="mobile-nav">
          {navigation.map((item) => (
            <NavLink key={item.path} to={item.path} end={item.path === "/"}>
              {item.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}

function DashboardPage(props: { heartbeat: number }) {
  const snapshot = useApiResource<DockerSnapshot>("/api/snapshot", props.heartbeat);
  const graph = useApiResource<GraphResponse>("/api/graph", props.heartbeat);

  if (snapshot.loading || graph.loading) {
    return <StatePanel title="Building topology" body="Refreshing containers, networks, volumes, and graph edges." />;
  }

  if (snapshot.error || graph.error || !snapshot.data || !graph.data) {
    return <StatePanel title="Graph unavailable" body={snapshot.error ?? graph.error ?? "Unknown failure"} tone="error" />;
  }

  return (
    <div className="page-grid">
      <section className="hero-panel">
        <div className="panel-label">Topology Canvas</div>
        <div className="graph-grid">
          {graph.data.nodes.map((node) => (
            <GraphNodeCard key={node.id} node={node} />
          ))}
        </div>
        <div className="edge-list">
          {graph.data.edges.map((edge, index) => (
            <div className="edge-row" key={`${edge.source}-${edge.target}-${index}`}>
              <span>{edge.source.replace("container_", "").replace("network_", "").replace("volume_", "")}</span>
              <span>{edge.relationship}</span>
              <span>{edge.target.replace("container_", "").replace("network_", "").replace("volume_", "")}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="kpi-grid">
        <KpiCard label="Containers" value={snapshot.data.containers.length} detail="Live runtime inventory" />
        <KpiCard label="Images" value={snapshot.data.images.length} detail="Derived image groups" />
        <KpiCard label="Networks" value={snapshot.data.networks.length} detail="Bridge and internal zones" />
        <KpiCard label="Volumes" value={snapshot.data.volumes.length} detail="Persistent state" />
      </section>

      <section className="info-panel">
        <div className="panel-label">Dependencies</div>
        {snapshot.data.containers.map((container) => (
          <div className="list-row" key={container.id}>
            <div>
              <Link className="inline-link" to={`/containers/${container.name}`}>
                {container.name}
              </Link>
              <div className="subtle-copy">{container.role}</div>
            </div>
            <div className="pill-row">
              {container.dependsOn.map((dependency) => (
                <Link
                  className="pill"
                  key={dependency}
                  to={`/containers/${dependency.replace("container_", "")}`}
                >
                  {dependency.replace("container_", "")}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

function ContainersPage(props: { heartbeat: number }) {
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

function ContainerDetailPage(props: { heartbeat: number }) {
  const params = useParams();
  const detail = useApiResource<ContainerRecord>(`/api/containers/${params.name ?? ""}`, props.heartbeat);
  const logs = useApiResource<LogsResponse>(`/api/logs?service=${params.name ?? ""}`, props.heartbeat);

  if (detail.loading) {
    return <StatePanel title="Loading container detail" body="Resolving container relationships and logs." />;
  }

  if (detail.error || !detail.data) {
    return <StatePanel title="Container not found" body={detail.error ?? "Unknown failure"} tone="error" />;
  }

  const container = detail.data;

  return (
    <section className="stack">
      <div className="page-header">
        <div>
          <div className="panel-label">Service Detail</div>
          <h2>{container.name}</h2>
          <p className="subtle-copy">{container.role}</p>
        </div>
        <div className="pill-row">
          <Link className="ghost-button small" to="/containers">
            Back to containers
          </Link>
          <Link className="ghost-button small" to={`/logs?service=${container.name}`}>
            Full logs
          </Link>
        </div>
      </div>

      <div className="detail-grid">
        <InfoCard title="Image" value={container.image} />
        <InfoCard title="Status" value={container.status} />
        <InfoCard title="Ports" value={container.ports.join(", ") || "None"} />
      </div>

      <section className="info-panel">
        <div className="panel-label">Networks and dependencies</div>
        <div className="pill-row">
          {container.networks.map((networkId) => (
            <Link key={networkId} className="pill" to={`/networks?network=${networkId}`}>
              {networkId.replace("network_", "")}
            </Link>
          ))}
          {container.dependsOn.map((dependency) => (
            <Link key={dependency} className="pill" to={`/containers/${dependency.replace("container_", "")}`}>
              {dependency.replace("container_", "")}
            </Link>
          ))}
        </div>
      </section>

      <section className="log-panel">
        <div className="panel-label">Recent logs</div>
        {logs.loading ? (
          <div className="subtle-copy">Loading log tail...</div>
        ) : logs.data && logs.data.entries.length > 0 ? (
          logs.data.entries.slice(0, 8).map((entry) => (
            <div className="log-row" key={entry.id}>
              <span>{formatTime(entry.timestamp)}</span>
              <span>{entry.level}</span>
              <span>{entry.message}</span>
            </div>
          ))
        ) : (
          <EmptyPanel title="No recent logs" body="This container is not emitting log lines right now." />
        )}
      </section>
    </section>
  );
}

function ImagesPage(props: { heartbeat: number }) {
  const { searchParams } = useSearchParamState();
  const resource = useApiResource<{ images: ImageRecord[] }>("/api/images", props.heartbeat);
  const q = (searchParams.get("q") ?? "").toLowerCase();

  const images = useMemo(
    () =>
      resource.data?.images.filter(
        (image) =>
          q.length === 0 ||
          image.image.toLowerCase().includes(q) ||
          image.containers.some((container) => container.toLowerCase().includes(q)),
      ) ?? [],
    [q, resource.data],
  );

  if (resource.loading) {
    return <StatePanel title="Loading images" body="Grouping services by image lineage." />;
  }

  if (resource.error || !resource.data) {
    return <StatePanel title="Images unavailable" body={resource.error ?? "Unknown failure"} tone="error" />;
  }

  return (
    <section className="card-grid">
      {images.map((image) => (
        <article className="panel-card" key={image.image}>
          <div className="panel-label">Image</div>
          <h3>{image.image}</h3>
          <div className="pill-row">
            {image.containers.map((container) => (
              <Link key={container} className="pill" to={`/containers/${container}`}>
                {container}
              </Link>
            ))}
          </div>
        </article>
      ))}
    </section>
  );
}

function NetworksPage(props: { heartbeat: number }) {
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

function VolumesPage(props: { heartbeat: number }) {
  const { searchParams } = useSearchParamState();
  const resource = useApiResource<{ volumes: VolumeRecord[] }>("/api/volumes", props.heartbeat);
  const focus = searchParams.get("volume");

  if (resource.loading) {
    return <StatePanel title="Loading volumes" body="Mapping attached services and persistent state." />;
  }

  if (resource.error || !resource.data) {
    return <StatePanel title="Volumes unavailable" body={resource.error ?? "Unknown failure"} tone="error" />;
  }

  const volumes = focus
    ? resource.data.volumes.filter((volume) => volume.id === focus || volume.name === focus)
    : resource.data.volumes;

  return (
    <section className="card-grid">
      {volumes.length === 0 ? (
        <EmptyPanel title="No volumes match this focus." body="Try clearing the selected volume chip." />
      ) : (
        volumes.map((volume) => (
          <article className="panel-card" key={volume.id}>
            <div className="panel-label">Volume</div>
            <h3>{volume.name}</h3>
            <div className="pill-row">
              {volume.attachedTo.map((container) => (
                <Link key={container} className="pill" to={`/containers/${container}`}>
                  {container}
                </Link>
              ))}
            </div>
          </article>
        ))
      )}
    </section>
  );
}

function LogsPage(props: { heartbeat: number }) {
  const { searchParams, update } = useSearchParamState();
  const service = searchParams.get("service") ?? "";
  const q = searchParams.get("q") ?? "";
  const path = `/api/logs${service || q ? `?${new URLSearchParams({ ...(service ? { service } : {}), ...(q ? { q } : {}) }).toString()}` : ""}`;
  const logs = useApiResource<LogsResponse>(path, props.heartbeat);
  const containers = useApiResource<{ containers: ContainerRecord[] }>("/api/containers", props.heartbeat);

  if (logs.loading || containers.loading) {
    return <StatePanel title="Loading logs" body="Hydrating log stream and service filter options." />;
  }

  if (logs.error || containers.error || !logs.data || !containers.data) {
    return <StatePanel title="Logs unavailable" body={logs.error ?? containers.error ?? "Unknown failure"} tone="error" />;
  }

  return (
    <section className="stack">
      <div className="page-header">
        <div>
          <div className="panel-label">Log Stream</div>
          <h2>Recent output and service focus.</h2>
        </div>
        <select className="service-select" value={service} onChange={(event) => update({ service: event.target.value || null })}>
          <option value="">All services</option>
          {containers.data.containers.map((container) => (
            <option key={container.id} value={container.name}>
              {container.name}
            </option>
          ))}
        </select>
      </div>

      <section className="log-panel">
        {logs.data.entries.length === 0 ? (
          <EmptyPanel title="No logs found" body="Try another service or clear the current search." />
        ) : (
          logs.data.entries.map((entry) => (
            <div className="log-row" key={entry.id}>
              <span>{formatTime(entry.timestamp)}</span>
              <span>{entry.container}</span>
              <span>{entry.message}</span>
            </div>
          ))
        )}
      </section>
    </section>
  );
}

function GraphNodeCard(props: { node: GraphResponse["nodes"][number] }) {
  const destination =
    props.node.type === "container"
      ? `/containers/${props.node.label}`
      : props.node.type === "network"
        ? `/networks?network=${props.node.id}`
        : `/volumes?volume=${props.node.id}`;

  return (
    <Link className={`graph-node ${props.node.type}`} to={destination}>
      <span>{props.node.type}</span>
      <strong>{props.node.label}</strong>
    </Link>
  );
}

function KpiCard(props: { label: string; value: number; detail: string }) {
  return (
    <article className="kpi-card">
      <div className="panel-label">{props.label}</div>
      <strong>{props.value}</strong>
      <span>{props.detail}</span>
    </article>
  );
}

function InfoCard(props: { title: string; value: string }) {
  return (
    <article className="panel-card compact">
      <div className="panel-label">{props.title}</div>
      <strong>{props.value}</strong>
    </article>
  );
}

function StatePanel(props: { title: string; body: string; tone?: "error" }) {
  return (
    <section className={`state-panel ${props.tone === "error" ? "state-error" : ""}`}>
      <h2>{props.title}</h2>
      <p>{props.body}</p>
    </section>
  );
}

function EmptyPanel(props: { title: string; body: string }) {
  return (
    <div className="empty-panel">
      <strong>{props.title}</strong>
      <span>{props.body}</span>
    </div>
  );
}

function NotFoundPage() {
  return <StatePanel title="Route not found" body="This page is outside the current DockerMap surface." tone="error" />;
}

export function App() {
  return <AppShell />;
}
