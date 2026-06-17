import { useEffect, useState } from "react";
import { Link, NavLink, Route, Routes, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useDaemonHeartbeat } from "../hooks/useDaemonHeartbeat";
import { formatTime } from "../utils/format";
import DashboardPage from "../pages/DashboardPage";
import ContainersPage from "../pages/ContainersPage";
import ContainerDetailPage from "../pages/ContainerDetailPage";
import ImagesPage from "../pages/ImagesPage";
import NetworksPage from "../pages/NetworksPage";
import VolumesPage from "../pages/VolumesPage";
import LogsPage from "../pages/LogsPage";
import NotFoundPage from "../pages/NotFoundPage";

const navigation = [
  { path: "/", label: "Dashboard" },
  { path: "/containers", label: "Containers" },
  { path: "/images", label: "Images" },
  { path: "/networks", label: "Networks" },
  { path: "/volumes", label: "Volumes" },
  { path: "/logs", label: "Logs" }
] as const;

export default function AppShell() {
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
