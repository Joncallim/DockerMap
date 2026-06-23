import { useEffect, useState } from "react";
import type { AuthWhoamiResponse } from "@dockermap/contracts";
import { useSettings } from "../hooks/useSettings";
import type { AuthProviderPreset, Density, ThemePreference } from "../lib/settingsStore";
import { fetchJson } from "../utils/api";
import { Panel, Tag } from "../components/primitives";
import Icon from "../components/Icon";

const ROUTE_OPTIONS: { value: string; label: string }[] = [
  { value: "/", label: "Home" },
  { value: "/map", label: "Service Map" },
  { value: "/changes", label: "Changes" },
  { value: "/copilot", label: "Copilot" },
  { value: "/networking", label: "Networking" },
  { value: "/storage", label: "Storage" },
  { value: "/images", label: "Images" },
  { value: "/logs", label: "Logs" },
  { value: "/compose", label: "Compose" }
];

const AUTH_PRESETS: Record<AuthProviderPreset, { label: string; hint: string }> = {
  authelia: {
    label: "Authelia",
    hint: "Authelia is deployed in front of DockerMap as a forward-auth proxy and sets Remote-User / Remote-Groups / Remote-Email headers."
  },
  authentik: {
    label: "Authentik",
    hint: "Authentik's forward-auth (proxy) outpost sets X-authentik-username / X-authentik-groups / X-authentik-email headers."
  },
  "oauth2-proxy": {
    label: "oauth2-proxy",
    hint: "oauth2-proxy sets X-Forwarded-User / X-Forwarded-Groups / X-Forwarded-Email headers after authenticating against any OIDC provider."
  },
  custom: {
    label: "Custom / other",
    hint: "Any reverse proxy that authenticates the request and forwards a trusted identity header works."
  }
};

const HEADER_ENV_BY_PRESET: Record<AuthProviderPreset, { user: string; groups: string; email: string }> = {
  authelia: { user: "Remote-User", groups: "Remote-Groups", email: "Remote-Email" },
  authentik: { user: "X-authentik-username", groups: "X-authentik-groups", email: "X-authentik-email" },
  "oauth2-proxy": { user: "X-Forwarded-User", groups: "X-Forwarded-Groups", email: "X-Forwarded-Email" },
  custom: { user: "X-Remote-User", groups: "X-Remote-Groups", email: "X-Remote-Email" }
};

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`switch${checked ? " is-on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  );
}

function FieldRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="field-row">
      <div className="field-label">
        <span>{label}</span>
        {hint && <span className="field-hint">{hint}</span>}
      </div>
      <div className="field-control">{children}</div>
    </div>
  );
}

export default function Settings() {
  const { settings, updateSettings, resetSettings } = useSettings();
  const [whoami, setWhoami] = useState<AuthWhoamiResponse | null>(null);
  const [whoamiError, setWhoamiError] = useState<string | null>(null);

  useEffect(() => {
    if (settings.demoMode) {
      setWhoami(null);
      setWhoamiError(null);
      return;
    }
    fetchJson<AuthWhoamiResponse>("/api/auth/whoami")
      .then(setWhoami)
      .catch((error) => setWhoamiError(error instanceof Error ? error.message : "Unable to reach API"));
  }, [settings.demoMode]);

  const preset = HEADER_ENV_BY_PRESET[settings.auth.provider];

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <div className="eyebrow">Preferences</div>
          <h1 className="screen-title">Settings</h1>
        </div>
        <button type="button" className="ghost-link" onClick={resetSettings}>
          <Icon name="refresh" size={14} /> Reset to defaults
        </button>
      </header>

      <div className="stack">
        <Panel title="Appearance" icon="layers" hint="Stored locally in this browser">
          <FieldRow label="Theme" hint="Follow your OS, or force light/dark">
            <select
              className="service-select"
              value={settings.theme}
              onChange={(e) => updateSettings({ theme: e.target.value as ThemePreference })}
            >
              <option value="system">System</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </FieldRow>
          <FieldRow label="Density" hint="Compact reduces padding for smaller screens">
            <select
              className="service-select"
              value={settings.density}
              onChange={(e) => updateSettings({ density: e.target.value as Density })}
            >
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </select>
          </FieldRow>
          <FieldRow label="Default landing page" hint="Screen shown when DockerMap opens">
            <select
              className="service-select"
              value={settings.defaultRoute}
              onChange={(e) => updateSettings({ defaultRoute: e.target.value })}
            >
              {ROUTE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </FieldRow>
        </Panel>

        <Panel title="Refresh" icon="refresh">
          <FieldRow
            label="Auto-refresh interval"
            hint="Controls Demo Mode's simulated refresh cadence. Live-mode refresh is set by the daemon (DOCKERMAP_SSE_INTERVAL_MS)."
          >
            <select
              className="service-select"
              value={settings.refreshIntervalMs}
              onChange={(e) => updateSettings({ refreshIntervalMs: Number(e.target.value) })}
            >
              <option value={1000}>1s</option>
              <option value={2000}>2s</option>
              <option value={5000}>5s</option>
              <option value={10000}>10s</option>
              <option value={30000}>30s</option>
            </select>
          </FieldRow>
        </Panel>

        <Panel
          title="Demo mode"
          icon="spark"
          hint="No Docker host required"
          actions={<Toggle checked={settings.demoMode} onChange={(value) => updateSettings({ demoMode: value })} label="Demo mode" />}
        >
          <p className="muted-line">
            When enabled, every screen renders a bundled sample infrastructure (containers, networks, volumes, logs, Compose
            drift) entirely in the browser — no daemon, API, or Docker socket is contacted. Useful for exploring DockerMap
            without a running Docker host.
          </p>
          {settings.demoMode && (
            <div className="tag-wrap" style={{ marginTop: "var(--s3)" }}>
              <Tag tone="accent" icon="spark">
                Demo mode active
              </Tag>
            </div>
          )}
        </Panel>

        <Panel title="Authentication" icon="shield" hint="Forward-auth / reverse-proxy SSO">
          <p className="muted-line">
            DockerMap doesn't implement its own login. Instead, put it behind a reverse proxy that authenticates the request
            (Authelia, Authentik, oauth2-proxy, Tailscale, …) and forwards the verified identity in trusted headers — DockerMap
            reads those headers and never sees credentials.
          </p>

          <FieldRow label="Show sign-in status" hint="Display identity and sign-in/out links in the top bar">
            <Toggle
              checked={settings.auth.showStatus}
              onChange={(value) => updateSettings({ auth: { showStatus: value } })}
              label="Show sign-in status"
            />
          </FieldRow>

          <FieldRow label="Provider preset" hint="Prefills the header names this proxy typically sends">
            <select
              className="service-select"
              value={settings.auth.provider}
              onChange={(e) => updateSettings({ auth: { provider: e.target.value as AuthProviderPreset } })}
            >
              {Object.entries(AUTH_PRESETS).map(([value, info]) => (
                <option key={value} value={value}>
                  {info.label}
                </option>
              ))}
            </select>
          </FieldRow>
          <p className="muted-line">{AUTH_PRESETS[settings.auth.provider].hint}</p>

          <FieldRow label="Sign-in URL" hint="Link shown to start a session with your proxy's login portal">
            <input
              className="service-select"
              type="url"
              placeholder="https://auth.example.com/"
              value={settings.auth.loginUrl}
              onChange={(e) => updateSettings({ auth: { loginUrl: e.target.value } })}
            />
          </FieldRow>
          <FieldRow label="Sign-out URL" hint="Link shown to end the proxy session">
            <input
              className="service-select"
              type="url"
              placeholder="https://auth.example.com/logout"
              value={settings.auth.logoutUrl}
              onChange={(e) => updateSettings({ auth: { logoutUrl: e.target.value } })}
            />
          </FieldRow>

          <div className="settings-snippet">
            <div className="field-label">
              <span>API environment variables</span>
              <span className="field-hint">Set these on the @dockermap/api process and restart it to enforce this provider.</span>
            </div>
            <pre className="mono settings-pre">
{`DOCKERMAP_AUTH_REQUIRED=true
DOCKERMAP_AUTH_USER_HEADER=${preset.user}
DOCKERMAP_AUTH_GROUPS_HEADER=${preset.groups}
DOCKERMAP_AUTH_EMAIL_HEADER=${preset.email}`}
            </pre>
          </div>

          <div className="field-row">
            <div className="field-label">
              <span>Current session</span>
              <span className="field-hint">Read live from /api/auth/whoami</span>
            </div>
            <div className="field-control">
              {settings.demoMode ? (
                <span className="muted-line">Unavailable while Demo Mode is active.</span>
              ) : whoamiError ? (
                <span className="muted-line">{whoamiError}</span>
              ) : !whoami ? (
                <span className="muted-line">Checking…</span>
              ) : whoami.user ? (
                <Tag tone="accent" icon="check">
                  Signed in as {whoami.name ?? whoami.user}
                </Tag>
              ) : (
                <Tag tone={whoami.required ? "warn" : "muted"}>
                  {whoami.required ? "No identity header received" : "No reverse-proxy auth configured"}
                </Tag>
              )}
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
