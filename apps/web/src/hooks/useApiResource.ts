import { useEffect, useState } from "react";
import { fetchJson } from "../utils/api";

export type ResourceState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
};

export function useApiResource<T>(path: string, refreshTick = 0): ResourceState<T> {
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
