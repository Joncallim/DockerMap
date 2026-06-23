import { isDemoMode } from "../lib/settingsStore";
import { getDemoResponse } from "../lib/demoData";

export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4000";

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export async function fetchJson<T>(path: string): Promise<T> {
  if (isDemoMode()) {
    return getDemoResponse<T>(path);
  }

  const response = await fetch(apiUrl(path));
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}`);
  }
  return (await response.json()) as T;
}
