import { computeImpact, needsAttention, type Service, type SystemModel } from "./model";
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
 * Every answer carries one evidence kind (#61 vocabulary). Claims derive from
 * the normalized model: filtering/counting services, traversing declarations,
 * and selecting observed records are DERIVED claims, never "observed".
 * Heuristic causal reasoning is labelled Inferred. Change collectors are
 * Unavailable. Only the source authority decides between host and sample:
 *
 *   live + live  -> host claims allowed (derived/inferred/unavailable kinds)
 *   demo + demo  -> sample claims (evidence kind "demo")
 *   mock + mock  -> sample claims (evidence kind "demo")
 *   anything else -> authority unresolved; NO substantive answer is produced
 *
 * mode/provenance are REQUIRED at the answer boundary so a caller can never
 * silently omit evidence authority (#75 A).
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
  if (db) out.push({ label: `What declares start order after ${db.name}?`, query: `what declares start order after ${db.name}` });
  out.push({ label: "What changed recently?", query: "what changed recently" });
  out.push({ label: "Show everything using port 443", query: "show everything using port 443" });
  return out;
}

/** Resolved source authority from the exact mode/provenance pair. */
type Authority = "host" | "sample" | "unresolved";

function authorityOf(mode: EvidenceMode | null, provenance: ModelProvenance | null): Authority {
  if (mode === "live" && provenance === "live") return "host";
  if ((mode === "demo" && provenance === "demo") || (mode === "mock" && provenance === "mock")) return "sample";
  return "unresolved";
}

/** The answer's evidence kind: host claims keep their kind; sample claims are "demo". */
function evidenceFor(liveKind: EvidenceKind, authority: Authority): EvidenceKind {
  return authority === "host" ? liveKind : "demo";
}

export function answer(model: SystemModel, raw: string, mode: EvidenceMode | null, provenance: ModelProvenance | null): CopilotAnswer {
  const q = raw.trim();
  const lower = q.toLowerCase();

  const authority = authorityOf(mode, provenance);
  if (authority === "unresolved") {
    return {
      question: q,
      headline: "Source not established",
      body: [
        "DockerMap cannot verify the source of this model, so it cannot answer from it.",
        "Wait until the live or sample authority is established and ask again."
      ],
      references: [],
      evidence: "unavailable"
    };
  }

  const named = findService(model, lower);

  if (/unhealthy|broken|down|attention|wrong/.test(lower) && !named) {
    return unhealthyAnswer(model, q, authority);
  }
  if (/depend|rely|use[ds]?\b|consumer|using/.test(lower) && named) {
    return dependentsAnswer(model, named, q, authority);
  }
  if (/why|offline|failing|unavailable|broke/.test(lower) && named) {
    return whyOfflineAnswer(model, named, q, authority);
  }
  if (/port\s*\d+|expose|listening/.test(lower)) {
    return portAnswer(model, q, lower, authority);
  }
  if (/chang|recent|deploy|updat/.test(lower)) {
    return changeAnswer(q, authority);
  }
  if (named) {
    return serviceOverviewAnswer(model, named, q, authority);
  }
  return {
    question: q,
    headline: "I can explain your topology",
    body: [
      "Try asking about a specific service, what declares start order after something, why a service is offline, or what changed recently.",
      "Everything I answer is computed from your service map."
    ],
    references: [],
    evidence: evidenceFor("derived", authority)
  };
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

function unhealthyAnswer(model: SystemModel, q: string, authority: Authority): CopilotAnswer {
  if (model.services.length === 0) {
    return {
      question: q,
      headline: "No services observed",
      body: ["No services are present in this snapshot."],
      references: [],
      evidence: evidenceFor("derived", authority)
    };
  }
  const attention = model.services.filter((s) => needsAttention(s.state));
  if (attention.length === 0) {
    // No attention-triggering service. "Nothing needs attention" is NOT
    // "everything is healthy": unknown/updating services are not healthy
    // evidence, so a blanket healthy claim would overstate the model (#75 D).
    const allHealthy = model.services.every((s) => s.state === "healthy");
    if (allHealthy) {
      return {
        question: q,
        headline: "Everything is healthy",
        body: ["All observed services are reporting a healthy state."],
        references: [],
        evidence: evidenceFor("derived", authority)
      };
    }
    const pending = model.services.filter((s) => s.state !== "healthy");
    return {
      question: q,
      headline: "Nothing currently needs attention",
      body: [
        `No service needs attention right now, but ${pending.length} service${pending.length === 1 ? "" : "s"} ${pending.length === 1 ? "is" : "are"} not confirmed healthy:`,
        ...pending.map((s) => `• ${identityText(s.name, UNAVAILABLE_SERVICE)} — ${s.state} (${identityText(s.status, UNAVAILABLE_SERVICE_STATUS)})`)
      ],
      references: pending.map((s) => s.name),
      evidence: evidenceFor("derived", authority)
    };
  }
  return {
    question: q,
    headline: `${attention.length} service${attention.length === 1 ? "" : "s"} need attention`,
    body: attention.map((s) => `${identityText(s.name, UNAVAILABLE_SERVICE)} — ${s.state} (${identityText(s.status, UNAVAILABLE_SERVICE_STATUS)})`),
    references: attention.map((s) => s.name),
    evidence: evidenceFor("derived", authority)
  };
}

function dependentsAnswer(model: SystemModel, service: Service, q: string, authority: Authority): CopilotAnswer {
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
      evidence: evidenceFor("derived", authority)
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
    evidence: evidenceFor("derived", authority)
  };
}

function whyOfflineAnswer(model: SystemModel, service: Service, q: string, authority: Authority): CopilotAnswer {
  if (service.state === "healthy") {
    return {
      question: q,
      headline: `${identityText(service.name, UNAVAILABLE_SERVICE)} is healthy`,
      body: [`${identityText(service.name, UNAVAILABLE_SERVICE)} is running normally (${identityText(service.status, UNAVAILABLE_SERVICE_STATUS)}).`],
      references: [service.name],
      evidence: evidenceFor("derived", authority)
    };
  }
  // Only attention-triggering upstream states (warning/degraded/offline) are
  // "unhealthy". Unknown/updating upstreams are missing/transitioning
  // evidence, not an observed unhealthy cause (#75 E).
  const unhealthyUpstreams = service.dependsOn
    .map((id) => model.byId.get(id))
    .filter((dep): dep is Service => dep !== undefined && needsAttention(dep.state));
  const body = [`${identityText(service.name, UNAVAILABLE_SERVICE)} is currently ${service.state} (${identityText(service.status, UNAVAILABLE_SERVICE_STATUS)}).`];
  if (unhealthyUpstreams.length > 0) {
    body.push("Inferred cause — an upstream dependency is also unhealthy (heuristic, not measured):");
    for (const dep of unhealthyUpstreams) body.push(`• ${identityText(dep.name, UNAVAILABLE_SERVICE)} is ${dep.state}`);
  } else {
    body.push("Inferred — none of its declared upstreams are unhealthy, so the cause is likely local to this service (heuristic, not measured).");
  }
  return { question: q, headline: `Why ${identityText(service.name, UNAVAILABLE_SERVICE)} is ${service.state}`, body, references: [service.name, ...unhealthyUpstreams.map((d) => d.name)], evidence: evidenceFor("inferred", authority) };
}

/** Numeric port of a container port string ("8080/tcp", "443:443", "8080"). */
function portNumber(port: string): number | null {
  const match = port.match(/^\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

function portAnswer(model: SystemModel, q: string, lower: string, authority: Authority): CopilotAnswer {
  const match = lower.match(/port\s*(\d+)/);
  const port = match ? Number(match[1]) : null;
  const hits = model.services.filter((s) => {
    const numbers = s.ports.map(portNumber).filter((n): n is number => n !== null);
    return port === null ? numbers.length > 0 : numbers.includes(port);
  });
  if (port === null) {
    return {
      question: q,
      headline: "Published ports",
      body: hits.flatMap((s) => s.ports.filter((p) => p !== "").map((p) => `${identityText(s.name, UNAVAILABLE_SERVICE)} → ${p}`)),
      references: hits.map((s) => s.name),
      evidence: evidenceFor("derived", authority)
    };
  }
  if (hits.length === 0) {
    return { question: q, headline: `No service publishes port ${port}`, body: [`No service publishes port ${port}.`], references: [], evidence: evidenceFor("derived", authority) };
  }
  return {
    question: q,
    headline: `Port ${port}`,
    body: hits.map((s) => `${identityText(s.name, UNAVAILABLE_SERVICE)} → ${s.ports.filter((p) => portNumber(p) === port).join(", ")}`),
    references: hits.map((s) => s.name),
    evidence: evidenceFor("derived", authority)
  };
}

function changeAnswer(q: string, authority: Authority): CopilotAnswer {
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

function serviceOverviewAnswer(model: SystemModel, service: Service, q: string, authority: Authority): CopilotAnswer {
  const impact = computeImpact(model, service.id);
  const publishedPorts = service.ports.filter((p) => p !== "");
  return {
    question: q,
    headline: `${identityText(service.name, UNAVAILABLE_SERVICE)} overview`,
    body: [
      `State: ${service.state} (${identityText(service.status, UNAVAILABLE_SERVICE_STATUS)})`,
      `Image: ${identityText(service.image, UNAVAILABLE_IMAGE)}`,
      `Declares start order after ${service.dependsOn.length} service${service.dependsOn.length === 1 ? "" : "s"}; ${impact.downstream.length} declare start order after it.`,
      publishedPorts.length ? `Ports: ${publishedPorts.join(", ")}` : "No published ports."
    ],
    references: [service.name],
    evidence: evidenceFor("derived", authority)
  };
}
