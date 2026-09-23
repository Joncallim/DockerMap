/**
 * Benchmark-only instrumentation seam for the time-to-answer baseline (#335).
 *
 * This is REAL production application code, not a copy: `useSystemModel` calls
 * `recordModelAcceptance()` at the exact point where a freshly fetched
 * resource/revision pair becomes the coherent model the UI renders, and routes
 * that publication through `useDeliveredModel()`. Both are gated by the
 * compile-time constant `__DOCKERMAP_BENCH_ACCEPTANCE__`:
 *
 * - production (`apps/web/vite.config.ts`) defines it `false`, so the whole
 *   module collapses to `return value` / `return null` and every benchmark
 *   branch, event identifier and delay mechanism is eliminated from the shipped
 *   bundle (`tests/perf/productionIsolation.test.mjs` inspects the artifact);
 * - the benchmark-mode application build in `tests/perf` defines it `true`,
 *   which is how the capture observes the real acceptance seam and how the
 *   stage-6/7 independence control injects an artificial presentation delay
 *   *after* acceptance.
 *
 * The seam carries no product payload and no telemetry. It records an opaque
 * timing event plus the model revision token that was accepted, in an in-memory
 * sink on the page, and (benchmark build only) stamps that same opaque token on
 * the document root so the capture can prove the DOM content it times belongs to
 * the accepted revision's render. Nothing leaves the page; nothing is uploaded.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";

/** One accepted coherent model: opaque timings only. */
export interface ModelAcceptanceEvent {
  /** Monotonic sequence number within this page. */
  seq: number;
  /** `performance.now()` at the instant the coherent model was accepted. */
  at: number;
  /** The opaque daemon model revision token the accepted model belongs to. */
  revision: string;
}

declare global {
  interface Window {
    /** Benchmark build only. Absent from the production bundle. */
    __dockermapBenchAcceptanceSink?: ModelAcceptanceEvent[];
    /** Benchmark build only: artificial presentation delay in ms (0/absent = off). */
    __dockermapBenchRenderDelayMs?: number;
  }
}

const sink: ModelAcceptanceEvent[] = [];
let sequence = 0;
let lastAcceptedRevision: string | null = null;

/**
 * The acceptance seam. Called from the real model publication path in
 * `useSystemModel` at the moment `buildModel()` output becomes the model the UI
 * uses — NOT from a DOM mutation, and NOT from a copied benchmark implementation.
 *
 * Duplicate calls for the same revision (a re-render recomputing the memo) are
 * ignored, so one accepted revision produces exactly one event.
 */
export function recordModelAcceptance(revision: string | null): void {
  if (!__DOCKERMAP_BENCH_ACCEPTANCE__) return;
  if (!revision || revision === lastAcceptedRevision) return;
  lastAcceptedRevision = revision;
  sequence += 1;
  sink.push({ seq: sequence, at: performance.now(), revision });
  // Bounded: the sink keeps only a recent window on a long-lived page.
  if (sink.length > 256) sink.splice(0, 128);
  window.__dockermapBenchAcceptanceSink = sink;
}

/**
 * The publication seam. In the product build this is the identity function: no
 * state, no effects, no observable difference. In the benchmark build it is the
 * point where the artificial presentation delay control withholds a newly
 * accepted publication from the render tree.
 *
 * The delay is keyed on the accepted revision, never on the surrounding
 * publication object (which is recreated on every render) — keying on the object
 * would reschedule the timer on every render instead of once per publication.
 */
export function useDeliveredModel<T>(value: T, revision: string | null): T {
  if (!__DOCKERMAP_BENCH_ACCEPTANCE__) return value;
  return useDelayedPublication(value, revision);
}

/**
 * Benchmark-only: stamps the accepted revision token on the document root in the
 * same commit that renders the accepted model, so the capture can attribute a
 * DOM repaint to a revision instead of assuming it.
 */
export function ModelAcceptanceStamp({ revision }: { revision: string | null }): ReactElement | null {
  if (!__DOCKERMAP_BENCH_ACCEPTANCE__) return null;
  return <AcceptedRevisionStamp revision={revision} />;
}

function AcceptedRevisionStamp({ revision }: { revision: string | null }): null {
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (revision && revision.length > 0) root.dataset.dockermapAcceptedRevision = revision;
    else delete root.dataset.dockermapAcceptedRevision;
  }, [revision]);
  return null;
}

function useDelayedPublication<T>(value: T, revision: string | null): T {
  const delayMs = armedDelayMs();
  const latest = useRef(value);
  latest.current = value;
  const [delivered, setDelivered] = useState(value);
  useEffect(() => {
    if (delayMs <= 0) return undefined;
    const timer = window.setTimeout(() => setDelivered(latest.current), delayMs);
    return () => window.clearTimeout(timer);
  }, [revision, delayMs]);
  return delayMs > 0 ? delivered : value;
}

function armedDelayMs(): number {
  if (typeof window === "undefined") return 0;
  const raw = Number(window.__dockermapBenchRenderDelayMs ?? 0);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}
