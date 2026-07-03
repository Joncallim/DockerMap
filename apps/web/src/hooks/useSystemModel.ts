import { useMemo } from "react";
import type { DockerSnapshot, RuntimeMap } from "@dockermap/contracts";
import { buildModel, type SystemModel } from "../lib/model";
import { useApiResource } from "./useApiResource";

export interface SystemModelState {
  model: SystemModel | null;
  loading: boolean;
  error: string | null;
}

/** Fetches the Docker snapshot + runtime map and composes them into the domain model. */
export function useSystemModel(refreshTick = 0): SystemModelState {
  const snapshot = useApiResource<DockerSnapshot>("/api/snapshot", refreshTick);
  const runtimeMap = useApiResource<RuntimeMap>("/api/runtime/map", refreshTick);

  const model = useMemo(() => {
    if (!snapshot.data || !runtimeMap.data) return null;
    return buildModel(snapshot.data, runtimeMap.data);
  }, [snapshot.data, runtimeMap.data]);

  return {
    model,
    loading: snapshot.loading || runtimeMap.loading,
    error: snapshot.error ?? runtimeMap.error
  };
}
