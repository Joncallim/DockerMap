import { hashString, needsAttention, type Service, type SystemModel } from "./model";

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
export const STUB_CHANGES_NOTICE = "Sample timeline — change collectors not yet wired";

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
  serviceName: string;
  kind: "deploy" | "image_update" | "restart" | "config" | "failure" | "recovery";
  summary: string;
  detail?: string;
  at: number;
  estimated: true;
}

const CHANGE_TEMPLATES: Record<
  ChangeEvent["kind"],
  (service: Service) => { summary: string; detail?: string }
> = {
  image_update: (s) => ({
    summary: `${s.name} image updated`,
    detail: `${s.imageRepo}:${s.imageTag} pulled and redeployed`
  }),
  deploy: (s) => ({ summary: `${s.name} redeployed`, detail: `Recreated from compose definition` }),
  restart: (s) => ({ summary: `${s.name} restarted`, detail: `Process exited and was restarted` }),
  config: (s) => ({ summary: `${s.name} configuration changed`, detail: `Environment or mount updated` }),
  failure: (s) => ({ summary: `${s.name} became unavailable`, detail: `Health checks failed` }),
  recovery: (s) => ({ summary: `${s.name} recovered`, detail: `Health checks passing again` })
};

export function changeFeed(model: SystemModel): ChangeEvent[] {
  const now = Date.now();
  const events: ChangeEvent[] = [];
  for (const service of model.services) {
    const seed = hashString(service.id + "change");
    if (service.updateAvailable) {
      events.push(makeEvent(service, "image_update", now - Math.round(seed * 1000 * 60 * 90)));
    }
    if (needsAttention(service.state)) {
      events.push(makeEvent(service, "failure", now - Math.round(seed * 1000 * 60 * 25)));
    } else if (seed > 0.6) {
      events.push(makeEvent(service, "restart", now - Math.round(seed * 1000 * 60 * 60 * 6)));
    }
  }
  return events.sort((a, b) => b.at - a.at).slice(0, 24);
}

function makeEvent(service: Service, kind: ChangeEvent["kind"], at: number): ChangeEvent {
  const tpl = CHANGE_TEMPLATES[kind](service);
  return {
    id: `${service.id}:${kind}:${at}`,
    serviceId: service.id,
    serviceName: service.name,
    kind,
    summary: tpl.summary,
    detail: tpl.detail,
    at,
    estimated: true
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

export function causalChain(model: SystemModel): CausalStep[] | null {
  const root = model.services.find((s) => s.state === "offline");
  if (!root) return null;
  const affected = model.services.filter((s) => s.dependsOn.includes(root.id));
  const steps: CausalStep[] = [
    { serviceName: root.name, text: `${root.name} went offline`, tone: "fail" }
  ];
  for (const svc of affected.slice(0, 3)) {
    steps.push({
      serviceName: svc.name,
      text: `${svc.name} lost its ${root.kind === "database" ? "database" : "upstream"} connection`,
      tone: "neutral"
    });
  }
  return steps;
}
