import { useEffect, useRef, useState } from "react";
import { fetchJson } from "../utils/api";
import { useSettings } from "./useSettings";
import type { ModelProvenance } from "../lib/evidence";

export type ResourceState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  /**
   * Generation of the DATA currently held: the fetch-attempt id that produced
   * it (the counter increments once per refreshTick fetch). Retained data
   * keeps its ORIGINAL generation, so consumers can require a same-generation
   * pair before rebuilding the model (atomic refresh — see useSystemModel).
   */
  generation: number;
  /**
   * Actual source of retained bytes: demo payload, daemon mock, daemon live,
   * or null while heartbeat authority is unresolved. Retained data keeps its ORIGINAL
   * provenance, so after a demoMode flip the still-live bytes are never
   * relabelled as demo bytes until a demo fetch actually lands (§9).
   */
  provenance: ModelProvenance | null;
};

/**
 * Fetches `path` on mount and whenever `refreshTick` changes. A TRANSIENT
 * refresh failure retains the LAST successful data (error is set, `data` is
 * kept) so screens can keep rendering a stale-but-usable model; only the
 * FIRST load failure (no prior data) clears `data` and surfaces the error
 * state. Data carries the generation of the fetch attempt that produced it.
 */
export function useApiResource<T>(
  path: string,
  refreshTick = 0,
  requestedProvenance?: ModelProvenance | null
): ResourceState<T> {
  const { settings } = useSettings();
  const [state, setState] = useState<ResourceState<T>>({
    data: null,
    error: null,
    loading: true,
    generation: 0,
    provenance: null
  });
  // Monotonic fetch-attempt counter, incremented once per refreshTick fetch.
  // Success stamps the data with the attempt; a failed refresh leaves the
  // retained data stamped with the generation it was ACTUALLY fetched at, so
  // a stale/fresh pair never looks like the same generation.
  const attemptRef = useRef(0);

  useEffect(() => {
    const isModelResource = requestedProvenance !== undefined;
    // Capture at request start.  The source semantics are properties of the
    // bytes requested, not of a later settings render while a response is in
    // flight; this also makes the demo/live transition invariant explicit.
    const demoModeAtRequest = settings.demoMode;
    const fallbackProvenance = demoModeAtRequest ? "demo" : "live";
    // `requestedProvenance` records the authority the caller was trying to
    // fetch under, not authority for the bytes returned.  Outside Demo Mode a
    // model response MUST attest its own source.  In particular, do not turn
    // an omitted or malformed `source` into the requested live authority:
    // malformed/stale bytes are usable for rendering, but their provenance is
    // unresolved and Copilot must refuse host claims from them (#165).

    // Abort on unmount/path change: a slow response can never clobber newer
    // state, and the underlying fetch is actually cancelled instead of just
    // having its result discarded.
    const controller = new AbortController();
    attemptRef.current += 1;
    const attempt = attemptRef.current;
    // Stamped at FETCH time: the demo short-circuit at utils/api.ts:30 keys
    // off settings.demoMode, while live/mock are distinguished by the heartbeat
    // mode passed by useSystemModel. Never re-derived after the fact.
    setState((current) => ({ ...current, loading: true, error: null }));

    fetchJson<T>(path, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) {
          // ACTUAL source beats the requested one: the API stamps every
          // model-bearing response with the source of the bytes it served
          // ("docker" from the daemon route layer, "mock" from its own
          // route-local fallback). A route-local fallback can therefore never
          // be mislabelled "live" because the client REQUESTED live (#85 A3).
          // Do not accept a prototype-provided source: this is untrusted JSON
          // shaped data at the authority boundary, and an inherited value must
          // not manufacture Docker authority.
          const stamped = typeof data === "object" && data !== null && Object.hasOwn(data, "source")
            ? (data as { source?: unknown }).source
            : undefined;
          // Demo Mode is a local deterministic transport short-circuit, so
          // its bytes are sample data regardless of any field embedded in a
          // fixture.  Every non-demo response instead needs an exact, own
          // `docker` or `mock` stamp.  There is intentionally no fallback to
          // requestedProvenance here: it is a request intent, not evidence.
          const actualProvenance: ModelProvenance | null = demoModeAtRequest
            ? "demo"
            : stamped === "docker" ? "live"
              : stamped === "mock" ? "mock"
                // Only snapshot/runtime pass requestedProvenance.  Preserve
                // the legacy non-model resource state for callers such as
                // auth, logs and diagnostics; their provenance does not
                // authorize the combined model.
                : isModelResource ? null : fallbackProvenance;
          setState({ data, error: null, loading: false, generation: attempt, provenance: actualProvenance });
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setState((current) => ({
            // Retain the last successful data across a transient refresh
            // failure; only the FIRST load (no prior data) clears the model.
            data: current.data,
            error: error instanceof Error ? error.message : "Unknown request failure",
            loading: false,
            generation: current.generation,
            provenance: current.provenance
          }));
        }
      });

    return () => controller.abort();
  }, [path, refreshTick, settings.demoMode, requestedProvenance]);

  return state;
}
