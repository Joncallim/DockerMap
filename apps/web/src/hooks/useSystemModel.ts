import { useMemo, useRef } from "react";
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

  // The two requests settle independently each refresh, so one can land while
  // the other still carries the previous generation. buildModel must only run
  // on a SAME-GENERATION pair (one NEW + one OLD resource would publish a
  // mismatched model); otherwise the previous model is kept until the pair
  // realigns. Retained-after-failure data keeps its original generation, so a
  // failed resource can never pair with a fresh peer either.
  const lastModel = useRef<SystemModel | null>(null);
  const model = useMemo(() => {
    if (!snapshot.data || !runtimeMap.data) return lastModel.current;
    if (snapshot.generation !== runtimeMap.generation) return lastModel.current;
    const built = buildModel(snapshot.data, runtimeMap.data);
    lastModel.current = built;
    return built;
  }, [snapshot.data, snapshot.generation, runtimeMap.data, runtimeMap.generation]);

  return {
    model,
    loading: snapshot.loading || runtimeMap.loading,
    error: snapshot.error ?? runtimeMap.error
  };
}
