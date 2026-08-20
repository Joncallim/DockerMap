import { useEffect, useState } from "react";
import { fetchJson } from "../utils/api";
import { useSettings } from "./useSettings";

export type ResourceState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
};

export function useApiResource<T>(path: string, refreshTick = 0): ResourceState<T> {
  const { settings } = useSettings();
  const [state, setState] = useState<ResourceState<T>>({
    data: null,
    error: null,
    loading: true
  });

  useEffect(() => {
    // Abort on unmount/path change: a slow response can never clobber newer
    // state, and the underlying fetch is actually cancelled instead of just
    // having its result discarded.
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: null }));

    fetchJson<T>(path, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) {
          setState({ data, error: null, loading: false });
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setState({
            data: null,
            error: error instanceof Error ? error.message : "Unknown request failure",
            loading: false
          });
        }
      });

    return () => controller.abort();
  }, [path, refreshTick, settings.demoMode]);

  return state;
}
