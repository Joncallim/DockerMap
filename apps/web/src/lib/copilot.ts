import { computeImpact, type Service, type SystemModel } from "./model";
import { identityText, UNAVAILABLE_IMAGE, UNAVAILABLE_SERVICE, UNAVAILABLE_SERVICE_STATUS } from "./identity";
import { UPDATE_STATUS_CLAIM, UPDATE_STATUS_LABEL } from "./updates";
import { CHANGE_HISTORY_CLAIM, NOT_COLLECTED_LABEL } from "./history";
import { type EvidenceKind, type EvidenceMode, type ModelProvenance } from "./evidence";

/**
 * The Copilot interprets the topology. It does not control anything and it does
 * not call an external model — it reasons deterministically over the system
 * model so answers are instant, private, and verifiable. This is the
 * "Interpreter / Investigator / Educator / Architect" doctrine in code.
 *
 * Every answer carries one evidence kind (#61 vocabulary). Model bytes from a
 * demo/mock source make the whole answer "Sample data"; live bytes keep
 * per-claim kinds (observed state, derived declarations, inferred heuristics,
 * unavailable collectors). Heuristic reasoning is always labelled Inferred.
 */

export interface CopilotAnswer {
  question: string;
  headline: string;
  body: string[];
  /** Services the answer is about, for click-through. */
  references: string[];
  /** The strongest evidence kind the answer can claim (#61 vocabulary). */
  evidence: EvidenceKind;
}

export interface CopilotSuggestion {
  label: string;
  query: string;
}

export function suggestions(model: SystemModel): CopilotSuggestion[] {
  const out: CopilotSuggestion[] = [{ label: "Show unhealthy services", query: "show unhealthy services" }];
  const offline = model.services.find((s) => s.state === "offline" && model.byName.has(s.name));
  if (offline) out.push({ label: `Why is ${offline.name} offline?`, query: `why is ${offline.name} offline` });
  const db = model.services.find((s) => s.kind === "database" && model.byName.has(s.name));
  if (db) out.push({ label: `What depends on ${db.name}?`, query: `what depends on ${db.name}` });
  out.push({ label: "What changed recently?", query: "what changed recently" });
  out.push({ label: "Show everything using port 443", query: "show everything using port 443" });
  return out;
}

export function answer(model: SystemModel, raw: string, mode: EvidenceMode | null = null, provenance: ModelProvenance | null = null): CopilotAnswer {
  const q = raw.trim();
  const lower = q.toLowerCase();

  const named = findService(model, lower);

  if (/unhealthy|broken|down|attention|wrong/.test(lower) && !named) {
    return unhealthyAnswer(model, q, mode, provenance);
  }
  if (/depend|rely|use[ds]?\b|consumer|using/.test(lower) && named) {
    return dependentsAnswer(model, named, q, mode, provenance);
  }
  if (/why|offline|failing|unavailable|broke/.test(lower) && named) {
    return whyOfflineAnswer(model, named, q, mode, provenance);
  }
  if (/port\s*\d+|expose|listening/.test(lower)) {
    return portAnswer(model, q, lower, mode, provenance);
  }
  if (/chang|recent|deploy|updat/.test(lower)) {
    return changeAnswer(q, mode, provenance);
  }
  if (named) {
    return serviceOverviewAnswer(model, named, q, mode, provenance);
  }
  return {
    question: q,
    headline: "I can explain your topology",
    body: [
      "Try asking about a specific service, what depends on something, why a service is offline, or what changed recently.",
      "Everything I answer is computed from your service map."
    ],
    references: [],
    evidence: sampleOrLive("derived", mode, provenance)
  };
}

/**
 * The answer's evidence kind, keyed on the model's provenance stamp (§9):
 * only live-provenance bytes can support observed/derived/inferred claims.
 * Demo/mock bytes make the whole answer "Sample data"; a null stamp (no
 * established authority) also fails closed to "Sample data" rather than
 * claiming host truth for bytes whose source is unknown.
 */
function sampleOrLive(liveKind: EvidenceKind, mode: EvidenceMode | null, provenance: ModelProvenance | null): EvidenceKind {
  if (provenance === "live" && mode === "live") return liveKind;
  return "demo";
}

function findService(model: SystemModel, lower: string): Service | null {
  let best: Service | null = null;
  for (const service of model.services) {
    if (service.name !== "" && model.byName.has(service.name) && lower.includes(service.name.toLowerCase())) {
      if (!best || service.name.length > best.name.length) best = service;
    }
  }
  return best;
}

function unhealthyAnswer(model: SystemModel, q: string, mode: EvidenceMode | null, provenance: ModelProvenance | null): CopilotAnswer {
  const trouble = model.services.filter((s) => s.state !== "healthy" && s.state !== "unknown");
  if (trouble.length === 0) {
    return {
      question: q,
      headline: "Everything is healthy",
      body: ["All services are reporting a healthy state right now."],
      references: [],
      evidence: sampleOrLive("observed", mode, provenance)
    };
  }
  return {
    question: q,
    headline: `${trouble.length} service${trouble.length === 1 ? "" : "s"} need attention`,
    body: trouble.map((s) => `${identityText(s.name, UNAVAILABLE_SERVICE)} — ${s.state} (${identityText(s.status, UNAVAILABLE_SERVICE_STATUS)})`),
    references: trouble.map((s) => s.name),
    evidence: sampleOrLive("observed", mode, provenance)
  };
}

function dependentsAnswer(model: SystemModel, service: Service, q: string, mode: EvidenceMode | null, provenance: ModelProvenance | null): CopilotAnswer {
  const impact = computeImpact(model, service.id);
  const names = impact.downstream.map((id) => model.byId.get(id)?.name ?? id);
  if (names.length === 0) {
    return {
      question: q,
      headline: `Nothing declares start order after ${identityText(service.name, UNAVAILABLE_SERVICE)}`,
      body: [
        `No service declares that it starts after ${identityText(service.name, UNAVAILABLE_SERVICE)}.`,
        "This is based on recorded Compose start-order declarations only — it does not predict runtime failure impact."
      ],
      references: [service.name],
      evidence: sampleOrLive("derived", mode, provenance)
    };
  }
  return {
    question: q,
    headline: `${names.length} service${names.length === 1 ? "" : "s"} declare start order after ${identityText(service.name, UNAVAILABLE_SERVICE)}`,
    body: [
      `These services declare in their Compose definitions that they start after ${identityText(service.name, UNAVAILABLE_SERVICE)}:`,
      ...names.map((n) => `• ${identityText(n, UNAVAILABLE_SERVICE)}`)
    ],
    references: [service.name, ...names],
    evidence: sampleOrLive("derived", mode, provenance)
  };
}

function whyOfflineAnswer(model: SystemModel, service: Service, q: string, mode: EvidenceMode | null, provenance: ModelProvenance | null): CopilotAnswer {
  if (service.state === "healthy") {
    return {
      question: q,
      headline: `${identityText(service.name, UNAVAILABLE_SERVICE)} is healthy`,
      body: [`${identityText(service.name, UNAVAILABLE_SERVICE)} is running normally (${identityText(service.status, UNAVAILABLE_SERVICE_STATUS)}).`],
      references: [service.name],
      evidence: sampleOrLive("observed", mode, provenance)
    };
  }
  const brokenDeps = service.dependsOn
    .map((id) => model.byId.get(id))
    .filter((dep): dep is Service => dep !== undefined && dep.state !== "healthy");
  const body = [`${identityText(service.name, UNAVAILABLE_SERVICE)} is currently ${service.state} (${identityText(service.status, UNAVAILABLE_SERVICE_STATUS)}).`];
  if (brokenDeps.length > 0) {
    body.push("Inferred cause — an upstream dependency is also unhealthy (heuristic, not measured):");
    for (const dep of brokenDeps) body.push(`• ${identityText(dep.name, UNAVAILABLE_SERVICE)} is ${dep.state}`);
  } else {
    body.push("Inferred — none of its declared upstreams are unhealthy, so the cause is likely local to this service (heuristic, not measured).");
  }
  return { question: q, headline: `Why ${identityText(service.name, UNAVAILABLE_SERVICE)} is ${service.state}`, body, references: [service.name, ...brokenDeps.map((d) => d.name)], evidence: sampleOrLive("inferred", mode, provenance) };
}

function portAnswer(model: SystemModel, q: string, lower: string, mode: EvidenceMode | null, provenance: ModelProvenance | null): CopilotAnswer {
  const match = lower.match(/port\s*(\d+)|\b(\d{2,5})\b/);
  const port = match ? match[1] ?? match[2] : null;
  const hits = model.services.filter((s) =>
    s.ports.some((p) => (port ? p.includes(port) : true))
  );
  if (!port) {
    return {
      question: q,
      headline: "Published ports",
      body: hits.flatMap((s) => s.ports.filter((p) => p !== "").map((p) => `${identityText(s.name, UNAVAILABLE_SERVICE)} → ${p}`)),
      references: hits.map((s) => s.name),
      evidence: sampleOrLive("observed", mode, provenance)
    };
  }
  if (hits.length === 0) {
    return { question: q, headline: `Nothing uses port ${port}`, body: [`No service publishes port ${port}.`], references: [], evidence: sampleOrLive("observed", mode, provenance) };
  }
  return {
    question: q,
    headline: `Port ${port}`,
    body: hits.map((s) => `${identityText(s.name, UNAVAILABLE_SERVICE)} → ${s.ports.filter((p) => p !== "" && p.includes(port)).join(", ")}`),
    references: hits.map((s) => s.name),
    evidence: sampleOrLive("observed", mode, provenance)
  };
}

function changeAnswer(q: string, mode: EvidenceMode | null, provenance: ModelProvenance | null): CopilotAnswer {
  return {
    question: q,
    headline: "Recent and pending change",
    body: [
      `Update status: ${UPDATE_STATUS_LABEL} — ${UPDATE_STATUS_CLAIM.detail}.`,
      `Change history: ${NOT_COLLECTED_LABEL} — ${CHANGE_HISTORY_CLAIM.detail}.`
    ],
    references: [],
    evidence: "unavailable"
  };
}

function serviceOverviewAnswer(model: SystemModel, service: Service, q: string, mode: EvidenceMode | null, provenance: ModelProvenance | null): CopilotAnswer {
  const impact = computeImpact(model, service.id);
  const publishedPorts = service.ports.filter((p) => p !== "");
  return {
    question: q,
    headline: `${identityText(service.name, UNAVAILABLE_SERVICE)} overview`,
    body: [
      `State: ${service.state} (${identityText(service.status, UNAVAILABLE_SERVICE_STATUS)})`,
      `Image: ${identityText(service.imageRepo, UNAVAILABLE_IMAGE)}:${identityText(service.imageTag, UNAVAILABLE_IMAGE)}`,
      `Declares start order after ${service.dependsOn.length} service${service.dependsOn.length === 1 ? "" : "s"}; ${impact.downstream.length} declare start order after it.`,
      publishedPorts.length ? `Ports: ${publishedPorts.join(", ")}` : "No published ports."
    ],
    references: [service.name],
    evidence: sampleOrLive("derived", mode, provenance)
  };
}
