import { hashString, needsAttention, type Service, type SystemModel } from "./model";
import { identityText, UNAVAILABLE_SERVICE } from "./identity";
import { claimAuthority, demoSample, type Claim, type EvidenceMode, type ModelProvenance } from "./evidence";
import { CAUSAL_CHAIN_CLAIM, CHANGE_HISTORY_CLAIM } from "./history";

/**
 * ──────────────────────────────────────────────────────────────────────────
 * STUBBED DATA — clearly labelled.
 *
 * The DockerMap daemon does not yet expose per-service resource samples or a
 * change/event history. The product design needs them, so we derive stable,
 * plausible values from the real topology. Every surface that renders this
 * data marks it as estimated (see the `STUB_NOTICE` copy) so it is never
 * mistaken for live telemetry. Replace these with real collectors later.
 * ──────────────────────────────────────────────────────────────────────────
 */

export const STUB_NOTICE = "Estimated — live resource collectors not yet wired";

export interface ResourceSample {
  cpuPercent: number;
  memoryPercent: number;
  memoryMb: number;
  networkKbps: number;
  /** Short pseudo-history for sparklines (0..1 normalised). */
  cpuSeries: number[];
  estimated: true;
}

export function resourceFor(service: Service): ResourceSample {
  const base = hashString(service.id);
  const load = service.state === "offline" ? 0 : 0.12 + base * 0.7;
  const memSeed = hashString(service.id + "mem");
  const memoryMb = Math.round(48 + memSeed * (service.kind === "database" ? 900 : 360));
  const series = Array.from({ length: 24 }, (_, i) => {
    const wobble = hashString(`${service.id}:${i}`);
    return service.state === "offline" ? 0 : Math.max(0, Math.min(1, load * 0.7 + wobble * 0.5 - 0.1));
  });
  return {
    cpuPercent: Math.round(load * 100),
    memoryPercent: Math.round((20 + memSeed * 70) * (service.state === "offline" ? 0 : 1)),
    memoryMb,
    networkKbps: Math.round((service.state === "offline" ? 0 : 1) * (10 + hashString(service.id + "net") * 4000)),
    cpuSeries: series,
    estimated: true
  };
}

export interface ChangeEvent {
  id: string;
  serviceId: string | null;
  /**
   * Display identity for the event summary — already normalized through the
   * shared identity helper, so an empty service name renders the explicit
   * "Unavailable service name" fallback instead of a malformed summary.
   */
  serviceName: string;
  /**
   * Collision-safe route target: the service name only when it is non-empty
   * and uniquely resolvable (absent from the collision-safe byName index).
   * Null for empty/collided identities — renderers must render plain
   * non-routable text and never emit a /services/ link in that case.
   */
  routeName: string | null;
  kind: "deploy" | "restart" | "config" | "failure" | "recovery";
  summary: string;
  detail?: string;
  at: number;
}

/**
 * TOTAL by type (G7/U7): a `Record` over the FULL `ChangeEvent["kind"]`
 * union, so a generator-less kind is impossible — adding a kind to the union
 * without a template here is a compile error, and `makeEvent` can never index
 * an undefined template. (The `deploy`/`config`/`recovery` templates exist
 * but `changeFeed` deliberately emits only `failure`/`restart` today. The
 * synthetic feed is available only under an allow-listed sample
 * mode/provenance pair — see `maySynthesizeHistory`.)
 */
const CHANGE_TEMPLATES: Record<
  ChangeEvent["kind"],
  (service: Service) => { summary: string; detail?: string }
> = {
  deploy: (s) => ({ summary: `${identityText(s.name, UNAVAILABLE_SERVICE)} redeployed`, detail: `Recreated from compose definition` }),
  restart: (s) => ({ summary: `${identityText(s.name, UNAVAILABLE_SERVICE)} restarted`, detail: `Process exited and was restarted` }),
  config: (s) => ({ summary: `${identityText(s.name, UNAVAILABLE_SERVICE)} configuration changed`, detail: `Environment or mount updated` }),
  failure: (s) => ({ summary: `${identityText(s.name, UNAVAILABLE_SERVICE)} became unavailable`, detail: `Health checks failed` }),
  recovery: (s) => ({ summary: `${identityText(s.name, UNAVAILABLE_SERVICE)} recovered`, detail: `Health checks passing again` })
};

/**
 * §9 Option A gate — positive allow-listing, shared by both generators and
 * run BEFORE any model iteration or clock read. Authority is necessary but
 * not sufficient: a sample tag requires the model's bytes to actually match
 * the declared mode (demo bytes under demo mode; daemon bytes under mock
 * mode). Every mismatch, unknown value, and null takes the unavailable arm —
 * a retained live model under demo authority must never be relabelled as a
 * freshly selected demo sample (DM-06/G-24).
 */
function maySynthesizeHistory(mode: EvidenceMode | null, modelProvenance: ModelProvenance | null): boolean {
  if (claimAuthority(mode) !== "sample") return false;
  return (
    (mode === "demo" && modelProvenance === "demo") ||
    (mode === "mock" && modelProvenance === "daemon")
  );
}

export function changeFeed(
  model: SystemModel,
  mode: EvidenceMode | null,
  modelProvenance: ModelProvenance | null
): Claim<ChangeEvent[]> {
  if (!maySynthesizeHistory(mode, modelProvenance)) return CHANGE_HISTORY_CLAIM;
  const now = Date.now();
  const events: ChangeEvent[] = [];
  for (const service of model.services) {
    const seed = hashString(service.id + "change");
    // Collision-safe route target: only a non-empty name that resolves
    // uniquely through byName may become a /services/ link.
    const routeName = model.byName.has(service.name) ? service.name : null;
    if (needsAttention(service.state)) {
      events.push(makeEvent(service, "failure", now - Math.round(seed * 1000 * 60 * 25), routeName));
    } else if (seed > 0.6) {
      events.push(makeEvent(service, "restart", now - Math.round(seed * 1000 * 60 * 60 * 6), routeName));
    }
  }
  return demoSample(events.sort((a, b) => b.at - a.at).slice(0, 24));
}

function makeEvent(service: Service, kind: ChangeEvent["kind"], at: number, routeName: string | null): ChangeEvent {
  const tpl = CHANGE_TEMPLATES[kind](service);
  return {
    id: `${service.id}:${kind}:${at}`,
    serviceId: service.id,
    serviceName: identityText(service.name, UNAVAILABLE_SERVICE),
    routeName,
    kind,
    summary: tpl.summary,
    detail: tpl.detail,
    at
  };
}

/**
 * A causal chain demonstrates event-driven storytelling: what happened, why,
 * and what it affected. Built only when there is a service in trouble.
 */
export interface CausalStep {
  serviceName: string;
  text: string;
  tone: "fail" | "neutral" | "ok";
}

export function causalChain(
  model: SystemModel,
  mode: EvidenceMode | null,
  modelProvenance: ModelProvenance | null
): Claim<CausalStep[]> {
  if (!maySynthesizeHistory(mode, modelProvenance)) return CAUSAL_CHAIN_CLAIM;
  const root = model.services.find((s) => s.state === "offline");
  if (!root) return demoSample([]);
  const affected = model.services.filter((s) => s.dependsOn.includes(root.id));
  const rootName = identityText(root.name, UNAVAILABLE_SERVICE);
  const steps: CausalStep[] = [
    { serviceName: rootName, text: `${rootName} went offline`, tone: "fail" }
  ];
  for (const svc of affected.slice(0, 3)) {
    const name = identityText(svc.name, UNAVAILABLE_SERVICE);
    steps.push({
      serviceName: name,
      text: `${name} lost its ${root.kind === "database" ? "database" : "upstream"} connection`,
      tone: "neutral"
    });
  }
  return demoSample(steps);
}
