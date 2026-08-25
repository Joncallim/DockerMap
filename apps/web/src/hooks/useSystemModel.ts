import { useMemo, useRef } from "react";
import type { DockerSnapshot, RuntimeMap } from "@dockermap/contracts";
import { buildModel, type SystemModel } from "../lib/model";
import type { EvidenceMode, ModelProvenance } from "../lib/evidence";
import { modelProvenanceForMode } from "../lib/evidence";
import { useApiResource } from "./useApiResource";

export interface SystemModelState {
  model: SystemModel | null;
  /**
   * Where the currently held model's bytes came from: the demo payload
   * service or the daemon. Published ALONGSIDE the model — a split
   * snapshot/runtime provenance or generation pair publishes NEITHER, and a
   * retained model keeps the provenance it was actually fetched with (§9).
   */
  modelProvenance: ModelProvenance | null;
  loading: boolean;
  error: string | null;
}

/** Fetches the Docker snapshot + runtime map and composes them into the domain model. */
export function useSystemModel(refreshTick: number, evidenceMode: EvidenceMode | null): SystemModelState {
  const requestedProvenance = modelProvenanceForMode(evidenceMode);
  const snapshot = useApiResource<DockerSnapshot>("/api/snapshot", refreshTick, requestedProvenance);
  const runtimeMap = useApiResource<RuntimeMap>("/api/runtime/map", refreshTick, requestedProvenance);

  // The two requests settle independently each refresh, so one can land while
  // the other still carries the previous generation. buildModel must only run
  // on a SAME-GENERATION pair (one NEW + one OLD resource would publish a
  // mismatched model); otherwise the previous model is kept until the pair
  // realigns. Retained-after-failure data keeps its original generation, so a
  // failed resource can never pair with a fresh peer either. The same guard
  // applies to provenance: a demoMode flip re-fetches both resources, and
  // until BOTH land with matching provenance, no new pair is published — the
  // retained model keeps the provenance it was actually fetched with.
  const lastModel = useRef<SystemModel | null>(null);
  const lastProvenance = useRef<ModelProvenance | null>(null);
  const model = useMemo(() => {
    if (!snapshot.data || !runtimeMap.data) return lastModel.current;
    if (snapshot.generation !== runtimeMap.generation) return lastModel.current;
    if (snapshot.provenance !== runtimeMap.provenance) return lastModel.current;
    const built = buildModel(snapshot.data, runtimeMap.data);
    lastModel.current = built;
    lastProvenance.current = snapshot.provenance;
    return built;
  }, [snapshot.data, snapshot.generation, snapshot.provenance, runtimeMap.data, runtimeMap.generation, runtimeMap.provenance]);

  const modelProvenance = useMemo(() => {
    if (!snapshot.data || !runtimeMap.data) return null;
    if (snapshot.generation !== runtimeMap.generation) return lastProvenance.current;
    if (snapshot.provenance !== runtimeMap.provenance) return lastProvenance.current;
    return snapshot.provenance;
  }, [snapshot.data, snapshot.generation, snapshot.provenance, runtimeMap.data, runtimeMap.generation, runtimeMap.provenance]);

  return {
    model,
    modelProvenance,
    loading: snapshot.loading || runtimeMap.loading,
    error: snapshot.error ?? runtimeMap.error
  };
}
