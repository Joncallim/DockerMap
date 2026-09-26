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
import type { DockerSnapshot, RuntimeMap } from "@dockermap/contracts";
import { summarize, type SystemModel } from "../model";

/** One accepted coherent model: opaque timings only. */
export interface ModelAcceptanceEvent {
  /** Monotonic sequence number within this page. */
  seq: number;
  /** `performance.now()` at the instant the coherent model was accepted. */
  at: number;
  /** The opaque daemon model revision token the accepted model belongs to. */
  revision: string;
  /** The exact snapshot/runtime-map pair consumed by useSystemModel. */
  snapshotRevision: string;
  runtimeMapRevision: string;
}

/** Benchmark-only diagnostic payload; it is drained by the capture harness. */
export interface ModelLayerDiagnostic {
 snapshot_revision: string;
 runtime_map_revision: string;
 snapshot_offline_count: number;
 runtime_map_relevant_state: { revision: string; offline_or_not_running_service_count: number; offline_or_not_running_container_count: number };
 coherent_pair_accepted: { accepted: boolean; snapshot_revision: string; runtime_map_revision: string };
 derived_model_offline_value: number;
 story_offline_value_pre_render: number;
 rendered_home_offline_value: number | null;
 fixture_generation: number | null;
 monotonic_timestamp: number;
}

declare global {
interface Window {
    /** Benchmark build only. Absent from the production bundle. */
    __dockermapBenchAcceptanceSink?: ModelAcceptanceEvent[];
    /** Benchmark build only: artificial presentation delay in ms (0/absent = off). */
    __dockermapBenchRenderDelayMs?: number;
/** Revision-targeted delay used by the ordinary benchmark capture. */
__dockermapBenchRenderDelayTarget?: string;
/** One-shot seam-isolation delay, armed before the next coherent acceptance. */
__dockermapBenchDelayAfterNextAcceptance?: boolean;
 /** Benchmark build only. Drained synchronously by the capture harness. */
 __dockermapBenchLayerSink?: ModelLayerDiagnostic[];
 /** Benchmark build only. Set by the harness before it advances a fixture. */
 __dockermapBenchFixtureGeneration?: number;
  }
}

const sink: ModelAcceptanceEvent[] = [];
const layerSink: ModelLayerDiagnostic[] = [];
let sequence = 0;
let lastAcceptedPair: string | null = null;

/**
 * The acceptance seam. Called from the real model publication path in
 * `useSystemModel` at the moment `buildModel()` output becomes the model the UI
 * uses — NOT from a DOM mutation, and NOT from a copied benchmark implementation.
 *
 * Duplicate calls for the same revision (a re-render recomputing the memo) are
 * ignored, so one accepted revision produces exactly one event.
 */
export function recordModelAcceptance(snapshotRevision: string | null, runtimeMapRevision: string | null): void {
  if (!__DOCKERMAP_BENCH_ACCEPTANCE__) return;
  if (!snapshotRevision || snapshotRevision !== runtimeMapRevision) return;
  const pair = `${snapshotRevision}\u0000${runtimeMapRevision}`;
  if (pair === lastAcceptedPair) return;
  lastAcceptedPair = pair;
  sequence += 1;
  sink.push({ seq: sequence, at: performance.now(), revision: snapshotRevision, snapshotRevision, runtimeMapRevision });
  // Bounded: the sink keeps only a recent window on a long-lived page.
  if (sink.length > 256) sink.splice(0, 128);
  window.__dockermapBenchAcceptanceSink = sink;
}

/** Records the actual inputs and model value at the coherent-publication seam. */
export function recordModelLayers(snapshot: DockerSnapshot, runtimeMap: RuntimeMap, model: SystemModel): void {
 if (!__DOCKERMAP_BENCH_ACCEPTANCE__) return;
 const runtimeStates = runtimeMap.nodes.filter((node) => /offline|stopped|dead|down|exited|not.running/i.test(`${node.status ?? ""} ${node.service?.status ?? ""}`));
 const diagnostic: ModelLayerDiagnostic = {
 snapshot_revision: snapshot.modelRevision,
 runtime_map_revision: runtimeMap.modelRevision,
 snapshot_offline_count: snapshot.containers.filter((container) => /offline|stopped|dead|down|exited|not.running/i.test(container.status)).length,
 runtime_map_relevant_state: {
 revision: runtimeMap.modelRevision,
 offline_or_not_running_service_count: runtimeStates.filter((node) => node.service !== undefined && node.service !== null).length,
 offline_or_not_running_container_count: runtimeStates.filter((node) => node.type === "container").length
 },
 coherent_pair_accepted: { accepted: snapshot.modelRevision === runtimeMap.modelRevision, snapshot_revision: snapshot.modelRevision, runtime_map_revision: runtimeMap.modelRevision },
 derived_model_offline_value: summarize(model).offline,
 story_offline_value_pre_render: summarize(model).offline,
 rendered_home_offline_value: null,
 fixture_generation: window.__dockermapBenchFixtureGeneration ?? null,
 monotonic_timestamp: performance.now()
 };
 layerSink.push(diagnostic);
 if (layerSink.length > 256) layerSink.splice(0, 128);
 window.__dockermapBenchLayerSink = layerSink;
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
return useDelayedPublication(value, revision, window.__dockermapBenchRenderDelayTarget ?? null, window.__dockermapBenchDelayAfterNextAcceptance === true);
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
 // This runs in the commit containing Home. Read its displayed metric instead
 // of deriving a value from the revision or fixture generation.
 const metric = [...document.querySelectorAll(".metric")].find((element) =>
 element.querySelector(".metric-label")?.textContent?.trim() === "Offline"
 );
 const displayed = metric?.querySelector(".metric-value")?.textContent?.trim();
 const latest = layerSink[layerSink.length - 1];
 if (latest && latest.snapshot_revision === revision && displayed !== undefined && displayed !== "") {
 const parsed = Number(displayed);
 latest.rendered_home_offline_value = Number.isFinite(parsed) ? parsed : null;
 }
}, [revision]);
  return null;
}

function useDelayedPublication<T>(value: T, revision: string | null, delayTarget: string | null, delayAfterNextAcceptance: boolean): T {
const deliveredRevision = useRef(revision);
const isNextAcceptance = delayAfterNextAcceptance && Boolean(revision) && revision !== deliveredRevision.current;
const delayMs = revision === delayTarget || isNextAcceptance ? armedDelayMs() : 0;
const latest = useRef(value);
latest.current = value;
const [delivered, setDelivered] = useState(value);
useEffect(() => {
if (delayMs <= 0) return undefined;
// This flag is consumed only after recordModelAcceptance() ran in the same
// render. It deliberately identifies no daemon publication or trigger.
if (isNextAcceptance) window.__dockermapBenchDelayAfterNextAcceptance = false;
const timer = window.setTimeout(() => {
deliveredRevision.current = revision;
setDelivered(latest.current);
}, delayMs);
return () => window.clearTimeout(timer);
}, [revision, delayMs, isNextAcceptance]);
return delayMs > 0 ? delivered : value;
}

function armedDelayMs(): number {
  if (typeof window === "undefined") return 0;
  const raw = Number(window.__dockermapBenchRenderDelayMs ?? 0);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}
