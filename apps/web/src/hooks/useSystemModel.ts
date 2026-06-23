import { useMemo } from "react";
import type { DockerSnapshot, GraphResponse } from "@dockermap/contracts";
import { buildModel, type SystemModel } from "../lib/model";
import { useApiResource } from "./useApiResource";

export interface SystemModelState {
  model: SystemModel | null;
  loading: boolean;
  error: string | null;
}

/** Fetches the snapshot + graph and composes them into the domain model. */
export function useSystemModel(refreshTick = 0): SystemModelState {
  const snapshot = useApiResource<DockerSnapshot>("/api/snapshot", refreshTick);
  const graph = useApiResource<GraphResponse>("/api/graph", refreshTick);

  const model = useMemo(() => {
    if (!snapshot.data || !graph.data) return null;
    return buildModel(snapshot.data, graph.data);
  }, [snapshot.data, graph.data]);

  return {
    model,
    loading: snapshot.loading || graph.loading,
    error: snapshot.error ?? graph.error
  };
}
