import { isDemoMode } from "../lib/settingsStore";
import { getDemoResponse } from "../lib/demoData";

export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4000";

export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export interface FetchJsonOptions {
  /** Caller-owned signal (unmount, path change, …) that cancels the request. */
  signal?: AbortSignal;
  /** Defaults to DEFAULT_FETCH_TIMEOUT_MS so a wedged connection cannot hang the UI forever. */
  timeoutMs?: number;
}

export async function fetchJson<T>(path: string, options?: FetchJsonOptions): Promise<T> {
  if (isDemoMode()) {
    return getDemoResponse<T>(path);
  }

  // Every request gets its own AbortController: the optional caller signal
  // is forwarded to it, and a timeout aborts as a backstop.
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  );
  const forwardAbort = () => controller.abort();
  const callerSignal = options?.signal;
  if (callerSignal?.aborted) {
    controller.abort();
  } else {
    callerSignal?.addEventListener("abort", forwardAbort, { once: true });
  }

  try {
    const response = await fetch(apiUrl(path), { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${path} failed with ${response.status}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", forwardAbort);
  }
}
