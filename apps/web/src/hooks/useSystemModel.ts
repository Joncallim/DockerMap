import { useMemo, useRef } from "react";
import type { DockerSnapshot, FindingsResponse, RuntimeMap } from "@dockermap/contracts";
import { buildModel, type SystemModel } from "../lib/model";
import { projectRuntimeMap } from "../lib/atlas/project";
import type { AtlasEnvelope } from "../lib/atlas/types";
import type { EvidenceMode, ModelProvenance } from "../lib/evidence";
import { modelProvenanceForMode } from "../lib/evidence";
import { useApiResource } from "./useApiResource";

export interface SystemModelState {
  model: SystemModel | null;
  /**
   * Atlas is projected at the same publication boundary as `model`.  Consumers
   * never receive the raw RuntimeMap that produced it, which prevents a route
   * from accidentally joining a new topology publication to an old model.
   */
  atlas: AtlasEnvelope | null;
  /** Matching revision/provenance Findings only; otherwise omitted fail-closed. */
  findings: FindingsResponse | null;
  /**
   * Where the currently held model's bytes came from: demo payload, daemon
   * mock, or daemon live-Docker. Published ALONGSIDE the model — a split
   * snapshot/runtime provenance or generation pair publishes NEITHER, and a
   * retained model keeps the provenance it was actually fetched with (§9).
   */
  modelProvenance: ModelProvenance | null;
  loading: boolean;
  error: string | null;
}

/** Fetches the Docker snapshot + runtime map and composes them into the domain model. */
export function useSystemModel(refreshTick: number, evidenceMode: EvidenceMode | null, includeFindings = false): SystemModelState {
  const requestedProvenance = modelProvenanceForMode(evidenceMode);
  const snapshot = useApiResource<DockerSnapshot>("/api/snapshot", refreshTick, requestedProvenance);
  const runtimeMap = useApiResource<RuntimeMap>("/api/runtime/map", refreshTick, requestedProvenance);
  // Findings are an optional overlay. AppShell enables this resource so the
  // same publisher—not a screen—can accept it only alongside the exact model
  // publication it attests. The default keeps existing hook consumers focused
  // on the two-resource atomic model contract.
  const findingsResource = useApiResource<FindingsResponse>("/api/findings", refreshTick, requestedProvenance, includeFindings);

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
  const lastAtlas = useRef<AtlasEnvelope | null>(null);
  const lastProvenance = useRef<ModelProvenance | null>(null);
  const model = useMemo(() => {
    if (!snapshot.data || !runtimeMap.data) return lastModel.current;
    if (snapshot.generation !== runtimeMap.generation) return lastModel.current;
    if (snapshot.provenance !== runtimeMap.provenance) return lastModel.current;
    // A timestamp is only an observation marker.  The daemon's opaque,
    // monotonic model revision is the coherence authority: never combine
    // missing, empty, or cross-publication values into browser state.
    if (!sameNonEmptyModelRevision(snapshot.data.modelRevision, runtimeMap.data.modelRevision)) return lastModel.current;
    const built = buildModel(snapshot.data, runtimeMap.data);
    lastModel.current = built;
    lastProvenance.current = snapshot.provenance;
    return built;
  }, [snapshot.data, snapshot.generation, snapshot.provenance, runtimeMap.data, runtimeMap.generation, runtimeMap.provenance]);

  // `model`'s memo above is deliberately evaluated before this value. A
  // Findings overlay is accepted only if it shares the model pair's fetch
  // generation, stamped provenance, and exact non-empty revision. A delayed,
  // stale, mock, or un-stamped response therefore produces the base Atlas
  // rather than false attention.
  const atlas = useMemo(() => {
    if (!snapshot.data || !runtimeMap.data) return lastAtlas.current;
    if (snapshot.generation !== runtimeMap.generation || snapshot.provenance !== runtimeMap.provenance) return lastAtlas.current;
    if (!sameNonEmptyModelRevision(snapshot.data.modelRevision, runtimeMap.data.modelRevision)) return lastAtlas.current;
    const findings = includeFindings && snapshot.provenance === "live" && findingsResource.data &&
      findingsResource.generation === snapshot.generation &&
      findingsResource.provenance === snapshot.provenance &&
      sameNonEmptyModelRevision(findingsResource.data.modelRevision, runtimeMap.data.modelRevision)
      ? findingsResource.data
      : undefined;
    const projected = projectRuntimeMap(runtimeMap.data, findings ? { findings } : undefined);
    lastAtlas.current = projected;
    return projected;
  }, [snapshot.data, snapshot.generation, snapshot.provenance, runtimeMap.data, runtimeMap.generation, runtimeMap.provenance, findingsResource.data, findingsResource.generation, findingsResource.provenance, includeFindings]);

  const atlasRevision = atlas?.sourceRevision;
  const findings = atlasRevision === model?.modelRevision &&
    includeFindings && snapshot.provenance === "live" && findingsResource.data &&
    findingsResource.generation === snapshot.generation &&
    findingsResource.provenance === snapshot.provenance &&
    sameNonEmptyModelRevision(findingsResource.data.modelRevision, atlasRevision)
    ? findingsResource.data
    : null;

  const modelProvenance = useMemo(() => {
    if (!snapshot.data || !runtimeMap.data) return null;
    if (snapshot.generation !== runtimeMap.generation) return lastProvenance.current;
    if (snapshot.provenance !== runtimeMap.provenance) return lastProvenance.current;
    if (!sameNonEmptyModelRevision(snapshot.data.modelRevision, runtimeMap.data.modelRevision)) return lastProvenance.current;
    return snapshot.provenance;
  }, [snapshot.data, snapshot.generation, snapshot.provenance, runtimeMap.data, runtimeMap.generation, runtimeMap.provenance]);

  return {
    model,
    atlas,
    findings,
    modelProvenance,
    loading: snapshot.loading || runtimeMap.loading,
    error: snapshot.error ?? runtimeMap.error
  };
}

function sameNonEmptyModelRevision(snapshotRevision: string | undefined, runtimeRevision: string | undefined): boolean {
  return typeof snapshotRevision === "string"
    && snapshotRevision.length > 0
    && snapshotRevision === runtimeRevision;
}
