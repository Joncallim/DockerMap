import { useEffect, useMemo, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import type { AuthWhoamiResponse } from "@dockermap/contracts";
import { useDaemonHeartbeat } from "../hooks/useDaemonHeartbeat";
import { useSystemModel } from "../hooks/useSystemModel";
import { useSettings } from "../hooks/useSettings";
import { useApiResource } from "../hooks/useApiResource";
import { apiUrl } from "../utils/api";
import { summarize } from "../lib/model";
import { formatClock } from "../lib/format";
import { AppContext } from "../context";
import Icon, { type IconName } from "./Icon";
import CommandPalette from "./CommandPalette";
import RouteFocusManager from "./RouteFocusManager";
import { StateDot, Tag } from "./primitives";
import { UNAVAILABLE_USER } from "../lib/identity";

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
}

const SPACES: { heading: string; items: NavItem[] }[] = [
  {
    heading: "Understand",
    items: [
      { to: "/", label: "Home", icon: "home", end: true },
      { to: "/map", label: "Service Map", icon: "map" },
      { to: "/runtime", label: "Runtime", icon: "layers" },
      { to: "/changes", label: "Changes", icon: "history" },
      { to: "/copilot", label: "Copilot", icon: "spark" }
    ]
  },
  {
    heading: "Operate",
    items: [
      { to: "/networking", label: "Networking", icon: "network" },
      { to: "/storage", label: "Storage", icon: "storage" },
      { to: "/images", label: "Images", icon: "image" },
      { to: "/logs", label: "Logs", icon: "logs" },
      { to: "/compose", label: "Compose", icon: "compose" }
    ]
  },
  {
    heading: "System",
    items: [
      { to: "/diagnostics", label: "Diagnostics", icon: "alert" },
      { to: "/settings", label: "Settings", icon: "settings" }
    ]
  }
];

function useThemeAndDensity() {
  const { settings } = useSettings();

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: light)");

    const apply = () => {
      const resolved = settings.theme === "system" ? (media.matches ? "light" : "dark") : settings.theme;
      root.dataset.theme = resolved;
    };

    apply();
    if (settings.theme === "system") {
      media.addEventListener("change", apply);
      return () => media.removeEventListener("change", apply);
    }
    return undefined;
  }, [settings.theme]);

  useEffect(() => {
    document.documentElement.dataset.density = settings.density;
  }, [settings.density]);
}

function AuthStatus({ onBearerSignOut }: { onBearerSignOut: () => void }) {
  const { settings } = useSettings();
  const whoami = useApiResource<AuthWhoamiResponse>("/api/auth/whoami");
  const user = whoami.data?.user;
  const bearerSession = whoami.data?.authenticated && !whoami.data.required;

  const signOut = async () => {
    const response = await fetch(apiUrl("/api/auth/session/logout"), { method: "POST", credentials: "include" });
    if (response.ok) onBearerSignOut();
  };

  return (
    <div className="auth-status">
      {bearerSession && (
        <button type="button" className="ghost-link bearer-sign-out" onClick={() => void signOut()}>
          Sign out
        </button>
      )}
      {settings.auth.showStatus && (user !== null && user !== undefined ? (
        <>
          <Tag tone="accent" icon="shield">
            {whoami.data?.name || user || UNAVAILABLE_USER}
          </Tag>
          {settings.auth.logoutUrl && (
            <a className="ghost-link" href={settings.auth.logoutUrl}>
              Sign out
            </a>
          )}
        </>
      ) : (
        !bearerSession && settings.auth.loginUrl && (
          <a className="ghost-link" href={settings.auth.loginUrl}>
            <Icon name="shield" size={14} /> Sign in
          </a>
        )
      ))}
    </div>
  );
}

export default function AppShell({ onBearerSignOut }: { onBearerSignOut: () => void }) {
  const { tick, health } = useDaemonHeartbeat();
  const { model, loading, error } = useSystemModel(tick);
  const { settings } = useSettings();
  const [commandOpen, setCommandOpen] = useState(false);
  const [clock, setClock] = useState(() => Date.now());

  useThemeAndDensity();

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const summary = useMemo(() => (model ? summarize(model) : null), [model]);
  const mode = settings.demoMode ? "Demo" : health?.mode === "docker" ? "Docker" : "Mock";
  const overall = !summary
    ? "unknown"
    : summary.offline > 0
      ? "offline"
      : summary.attention > 0
        ? "warning"
        : "healthy";

  const ctx = {
    model,
    loading,
    error,
    health,
    tick,
    openCommand: () => setCommandOpen(true)
  };

  return (
    <AppContext.Provider value={ctx}>
      <div className="shell" inert={commandOpen || undefined}>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        <aside className="rail" aria-label="Application navigation and status">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <Icon name="map" size={20} />
            </span>
            <div className="brand-text">
              <div className="brand-title">DockerMap</div>
              <div className="brand-sub">Infrastructure, understood</div>
            </div>
          </div>

          <nav className="nav nav-list" aria-label="Primary">
            {SPACES.map((space) => (
              <div className="nav-group" key={space.heading}>
                <div className="nav-heading">{space.heading}</div>
                {space.items.map((item) => (
                  <NavLink key={item.to} to={item.to} end={item.end} className="nav-item">
                    <Icon name={item.icon} size={17} />
                    <span>{item.label}</span>
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>

          <div className="rail-foot">
            <div className={`conn conn-${health?.dockerReachable ? "up" : "down"}`}>
              <StateDot state={health?.dockerReachable ? "healthy" : "offline"} pulse={health?.dockerReachable} />
              <span className="conn-mode">{mode} Engine</span>
            </div>
            <p className="conn-msg">{health?.message ?? "Connecting to daemon…"}</p>
          </div>
        </aside>

        <div className="frame">
          <header className="topbar">
            <button type="button" className="topbar-search" onClick={() => setCommandOpen(true)}>
              <Icon name="search" size={16} />
              <span>Search or ask…</span>
              <kbd>
                <Icon name="command" size={11} /> K
              </kbd>
            </button>
            <div className="topbar-status">
              {summary && (
                <div className={`sys-state s-${overall}`}>
                  <StateDot state={overall} pulse={overall === "healthy"} />
                  <span>
                    {summary.healthy}/{summary.total} healthy
                  </span>
                  {summary.attention > 0 && <span className="sys-attn">{summary.attention} need attention</span>}
                </div>
              )}
              {!settings.demoMode && <AuthStatus onBearerSignOut={onBearerSignOut} />}
              <span className="topbar-clock">{formatClock(clock)}</span>
            </div>
          </header>

          <main id="main-content" className="content" tabIndex={-1} aria-label="Main content">
            <Outlet />
          </main>
        </div>
        <RouteFocusManager />
      </div>

      <CommandPalette open={commandOpen} onClose={() => setCommandOpen(false)} model={model} />
    </AppContext.Provider>
  );
}
