import { useEffect, useState } from "react";
import { Link, NavLink, Route, Routes, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useDaemonHeartbeat } from "../hooks/useDaemonHeartbeat";
import { formatTime } from "../utils/format";
import Icon, { type IconName } from "./Icon";
import DashboardPage from "../pages/DashboardPage";
import ContainersPage from "../pages/ContainersPage";
import ContainerDetailPage from "../pages/ContainerDetailPage";
import ImagesPage from "../pages/ImagesPage";
import NetworksPage from "../pages/NetworksPage";
import VolumesPage from "../pages/VolumesPage";
import LogsPage from "../pages/LogsPage";
import ComposePage from "../pages/ComposePage";
import NotFoundPage from "../pages/NotFoundPage";

const navigation: { path: string; label: string; icon: IconName }[] = [
  { path: "/", label: "Dashboard", icon: "dashboard" },
  { path: "/containers", label: "Containers", icon: "container" },
  { path: "/images", label: "Images", icon: "image" },
  { path: "/networks", label: "Networks", icon: "network" },
  { path: "/volumes", label: "Volumes", icon: "volume" },
  { path: "/logs", label: "Logs", icon: "logs" },
  { path: "/compose", label: "Compose", icon: "compose" },
];

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
      const query = next.toString();
      navigate(query ? `${location.pathname}?${query}` : location.pathname, { replace: true });
    }, 250);

    return () => window.clearTimeout(timer);
  }, [draftQuery, location.pathname, navigate, searchParams]);

  const reachable = health?.dockerReachable;
  const mode = health?.mode === "docker" ? "Docker socket" : "Mock engine";

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <Icon name="orbit" size={22} />
          </span>
          <div className="brand-text">
            <div className="brand-title">DockerMap</div>
            <div className="brand-sub">Runtime Atlas</div>
          </div>
        </div>

        <div className={`host-card ${reachable ? "host-up" : "host-down"}`}>
          <div className="host-row">
            <span className={`dot ${reachable ? "dot-ok dot-pulse" : "dot-err"}`} aria-hidden="true" />
            <span className="host-mode">{mode}</span>
          </div>
          <div className="host-meta">{reachable ? "Socket reachable" : "Socket unreachable"}</div>
        </div>

        <nav className="nav" aria-label="Primary">
          {navigation.map((item) => (
            <NavLink key={item.path} to={item.path} end={item.path === "/"} className="nav-item">
              <Icon name={item.icon} size={18} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="rail-foot">
          <div className="eyebrow">Daemon</div>
          <div className={`daemon-state daemon-${health?.status ?? "connecting"}`}>
            <span className={`dot ${health?.status === "ok" ? "dot-ok" : "dot-warn"}`} aria-hidden="true" />
            {health?.status ?? "connecting"}
          </div>
          <p className="rail-foot-msg">{health?.message ?? "Waiting for daemon heartbeat."}</p>
          <div className="rail-foot-time">{health ? `Synced ${formatTime(health.lastUpdated)}` : "No live data yet"}</div>
        </div>
      </aside>

      <div className="surface">
        <header className="topbar">
          <label className="command">
            <Icon name="search" size={17} />
            <input
              value={draftQuery}
              onChange={(event) => setDraftQuery(event.target.value)}
              className="command-input"
              placeholder="Search services, images, networks, volumes, paths…"
              aria-label="Search the runtime"
            />
            <kbd>/</kbd>
          </label>
          <div className="topbar-actions">
            <span className={`live-chip ${reachable ? "live-on" : "live-off"}`}>
              <span className={`dot ${reachable ? "dot-ok dot-pulse" : "dot-err"}`} aria-hidden="true" />
              {reachable ? "Live" : "Offline"}
            </span>
            <Link className="btn btn-ghost" to="/logs">
              <Icon name="logs" size={16} />
              Logs
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
            <Route path="/compose" element={<ComposePage heartbeat={health?.lastUpdated ?? 0} />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </main>

        <nav className="mobile-nav" aria-label="Primary mobile">
          {navigation.map((item) => (
            <NavLink key={item.path} to={item.path} end={item.path === "/"} className="mobile-item">
              <Icon name={item.icon} size={20} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}
