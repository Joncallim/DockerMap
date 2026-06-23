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
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      auth: { ...DEFAULT_SETTINGS.auth, ...parsed.auth }
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
