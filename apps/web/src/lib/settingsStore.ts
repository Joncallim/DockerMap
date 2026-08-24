export type ThemePreference = "system" | "light" | "dark";
export type Density = "comfortable" | "compact";
export type AuthProviderPreset = "authelia" | "authentik" | "oauth2-proxy" | "custom";

export interface AuthSettings {
  /** Purely informational: whether to show sign-in/out links and identity status in the UI. */
  showStatus: boolean;
  provider: AuthProviderPreset;
  loginUrl: string;
  logoutUrl: string;
}

export interface Settings {
  theme: ThemePreference;
  density: Density;
  refreshIntervalMs: number;
  defaultRoute: string;
  demoMode: boolean;
  auth: AuthSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  density: "comfortable",
  refreshIntervalMs: 2_000,
  defaultRoute: "/",
  demoMode: false,
  auth: {
    showStatus: false,
    provider: "authelia",
    loginUrl: "",
    logoutUrl: ""
  }
};

const STORAGE_KEY = "dockermap.settings.v1";

function load(): Settings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed: unknown = JSON.parse(raw);
    // demoMode is load-bearing for evidence classification (resolveEvidenceMode
    // trusts it as a real boolean): reject non-object payloads and any persisted
    // value that is not a boolean — fall back to defaults, never coerce (G-01).
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return DEFAULT_SETTINGS;
    }
    const candidate = parsed as Partial<Settings>;
    if (typeof candidate.demoMode !== "boolean") {
      return DEFAULT_SETTINGS;
    }
    return {
      ...DEFAULT_SETTINGS,
      ...candidate,
      auth: { ...DEFAULT_SETTINGS.auth, ...candidate.auth }
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

let state: Settings = load();
const listeners = new Set<() => void>();

function persist() {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function emit() {
  listeners.forEach((listener) => listener());
}

export function getSettings(): Settings {
  return state;
}

export function updateSettings(patch: Partial<Omit<Settings, "auth">> & { auth?: Partial<AuthSettings> }) {
  state = {
    ...state,
    ...patch,
    auth: patch.auth ? { ...state.auth, ...patch.auth } : state.auth
  };
  persist();
  emit();
}

export function resetSettings() {
  state = DEFAULT_SETTINGS;
  persist();
  emit();
}

export function subscribeSettings(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isDemoMode(): boolean {
  return state.demoMode;
}
