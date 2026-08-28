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
  /**
   * True when the answer was refused because the model's source authority is
   * unresolved (mode/provenance do not form an exact pair). The UI renders a
   * DEDICATED source-authority status for this — it must not be presented as
   * "Not collected" (the collector-unavailable claim kind), because the data
   * may well be collected; only its source is unverifiable (#85 A7).
   */
  authorityUnresolved?: boolean;
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
      evidence: "unavailable",
      authorityUnresolved: true
    };
  }

  const named = findService(model, lower);

  if (/unhealthy|broken|down|attention|wrong/.test(lower) && !named) {
    return unhealthyAnswer(model, q, authority);
  }
  if (/depend|rely|use[ds]?\b|consumer|using|declares?\s+start\s+order/.test(lower) && named) {
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
  // Direct declaration question: only services that DECLARE start order
  // directly after this one. computeImpact().downstream is TRANSITIVE
  // reachability (A→B→C makes C downstream of A), so it cannot answer "who
  // declares start order after X" — a transitive chain is not a direct
  // declaration (#85 A4).
  const names = service.dependents.map((id) => model.byId.get(id)?.name ?? id);
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
    headline: `${names.length} service${names.length === 1 ? "" : "s"} ${names.length === 1 ? "declares" : "declare"} start order after ${identityText(service.name, UNAVAILABLE_SERVICE)}`,
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
  // evidence, not an observed unhealthy cause (#75 E). Even with all healthy
  // upstreams, Compose start-order is NOT runtime causality evidence, so the
  // failure cause can never be localized to this service (#85 A5): the honest
  // statements are "no upstream problem observed" (cause remains unknown) or
  // "upstream evidence incomplete" (cause not established).
  const upstreams = service.dependsOn
    .map((id) => model.byId.get(id))
    .filter((dep): dep is Service => dep !== undefined);
  const unhealthyUpstreams = upstreams.filter((dep) => needsAttention(dep.state));
  const incompleteUpstreams = upstreams.filter((dep) => dep.state === "unknown" || dep.state === "updating");
  const body = [`${identityText(service.name, UNAVAILABLE_SERVICE)} is currently ${service.state} (${identityText(service.status, UNAVAILABLE_SERVICE_STATUS)}).`];
  if (unhealthyUpstreams.length > 0) {
    body.push("Inferred cause — an upstream dependency is also unhealthy (heuristic, not measured):");
    for (const dep of unhealthyUpstreams) body.push(`• ${identityText(dep.name, UNAVAILABLE_SERVICE)} is ${dep.state}`);
  } else if (incompleteUpstreams.length > 0) {
    body.push("Inferred — upstream evidence is incomplete: one or more declared upstreams have unknown or transitioning state, so the cause is not established.");
    for (const dep of incompleteUpstreams) body.push(`• ${identityText(dep.name, UNAVAILABLE_SERVICE)} is ${dep.state}`);
  } else {
    body.push("Inferred — no declared upstream is currently unhealthy, but the cause is not established: Compose start order is not runtime causality evidence, and this service's failure may be local or may be upstream.");
  }
  return { question: q, headline: `Why ${identityText(service.name, UNAVAILABLE_SERVICE)} is ${service.state}`, body, references: [service.name, ...unhealthyUpstreams.map((d) => d.name)], evidence: evidenceFor("inferred", authority) };
}

/**
 * Parsed container port: the daemon serializes Docker ports as
 * `public:private/proto` when public_port > 0 (published) and as
 * `private/proto` when the port is only exposed/unpublished (#85 A6).
 * `published` is the host-facing public side; `exposed` is the container's
 * private side. A private-only string ("8080/tcp") is EXPOSED, never
 * published — claiming "publishes port 8080" for it would be a false
 * host-publication statement.
 */
function parsePort(port: string): { published: number | null; exposed: number | null } {
  const body = port.split("/", 1)[0] ?? port;
  if (body === "") return { published: null, exposed: null };
  const parts = body.split(":", 2);
  if (parts.length === 2 && parts[0] !== "") {
    const publicSide = Number(parts[0]);
    const privateSide = Number(parts[1]);
    return {
      published: Number.isFinite(publicSide) && publicSide > 0 ? publicSide : null,
      exposed: Number.isFinite(privateSide) ? privateSide : null
    };
  }
  const privateSide = Number(parts[0]);
  return { published: null, exposed: Number.isFinite(privateSide) ? privateSide : null };
}

/**
 * One shared grammar for dispatch AND extraction (#85 A8): "port 443",
 * "listening on 443", "exposes 8080", or a bare number in a port context.
 * Returns the queried port number or null when the query names no port.
 */
function extractPortNumber(lower: string): number | null {
  const matches = [
    lower.match(/port\s*(\d+)/),
    lower.match(/listening on\s*(\d+)/),
    lower.match(/(?:exposes?|exposing)\s*(\d+)/),
    lower.match(/(?:using|for)\s*port\s*(\d+)/)
  ];
  for (const match of matches) {
    if (match) return Number(match[1]);
  }
  return null;
}

function portAnswer(model: SystemModel, q: string, lower: string, authority: Authority): CopilotAnswer {
  const port = extractPortNumber(lower);
  // A service "publishes" the port only when the host-facing public side
  // matches; an exposed (private-only) port matches the exposure query but
  // is never described as published.
  const publishedHits = model.services.filter((s) =>
    s.ports.some((p) => parsePort(p).published === port)
  );
  const exposedHits = model.services.filter((s) =>
    s.ports.some((p) => parsePort(p).exposed === port)
  );
  // Exposure-oriented wording ("what exposes 80?", "what is listening on
  // 443?") asks about the CONTAINER-side port. A `80:8080/tcp` service
  // exposes 8080 — answering an "exposes 80" query with its published side
  // would be wrong (#89 P2). Restrict such queries to the exposed side.
  const exposureWording = /expose|exposing|listening on/.test(lower);
  if (port === null) {
    return {
      question: q,
      headline: "Ports in the snapshot",
      body: model.services.flatMap((s) => s.ports.filter((p) => p !== "").map((p) => `${identityText(s.name, UNAVAILABLE_SERVICE)} → ${p}`)),
      references: model.services.map((s) => s.name),
      evidence: evidenceFor("derived", authority)
    };
  }
  if (exposureWording) {
    if (exposedHits.length === 0) {
      return { question: q, headline: `No service exposes port ${port}`, body: [`No service exposes port ${port}.`], references: [], evidence: evidenceFor("derived", authority) };
    }
    const lines: string[] = [];
    for (const s of exposedHits) {
      const parts = s.ports.filter((p) => parsePort(p).exposed === port);
      lines.push(`• ${identityText(s.name, UNAVAILABLE_SERVICE)} exposes port ${port} (${parts.join(", ")})`);
    }
    return {
      question: q,
      headline: `Port ${port}`,
      body: lines,
      references: [...new Set(exposedHits.map((s) => s.name))],
      evidence: evidenceFor("derived", authority)
    };
  }
  if (publishedHits.length === 0 && exposedHits.length === 0) {
    return { question: q, headline: `No service publishes port ${port}`, body: [`No service publishes port ${port}.`], references: [], evidence: evidenceFor("derived", authority) };
  }
  const lines: string[] = [];
  for (const s of publishedHits) {
    const parts = s.ports.filter((p) => parsePort(p).published === port);
    lines.push(`• ${identityText(s.name, UNAVAILABLE_SERVICE)} publishes port ${port} (${parts.join(", ")})`);
  }
  for (const s of exposedHits) {
    if (publishedHits.includes(s)) continue;
    const parts = s.ports.filter((p) => parsePort(p).exposed === port);
    lines.push(`• ${identityText(s.name, UNAVAILABLE_SERVICE)} exposes port ${port} (${parts.join(", ")})`);
  }
  return {
    question: q,
    headline: `Port ${port}`,
    body: lines,
    references: [...new Set([...publishedHits, ...exposedHits].map((s) => s.name))],
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
      `Declares start order after ${service.dependsOn.length} service${service.dependsOn.length === 1 ? "" : "s"}; ${service.dependents.length} declare start order after it.`,
      publishedPorts.length ? `Ports: ${publishedPorts.join(", ")}` : "No published ports."
    ],
    references: [service.name],
    evidence: evidenceFor("derived", authority)
  };
}
