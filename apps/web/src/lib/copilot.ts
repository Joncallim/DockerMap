import { computeImpact, type Service, type SystemModel } from "./model";

/**
 * The Copilot interprets the topology. It does not control anything and it does
 * not call an external model — it reasons deterministically over the system
 * model so answers are instant, private, and verifiable. This is the
 * "Interpreter / Investigator / Educator / Architect" doctrine in code.
 */

export interface CopilotAnswer {
  question: string;
  headline: string;
  body: string[];
  /** Services the answer is about, for click-through. */
  references: string[];
}

export interface CopilotSuggestion {
  label: string;
  query: string;
}

export function suggestions(model: SystemModel): CopilotSuggestion[] {
  const out: CopilotSuggestion[] = [{ label: "Show unhealthy services", query: "show unhealthy services" }];
  const offline = model.services.find((s) => s.state === "offline");
  if (offline) out.push({ label: `Why is ${offline.name} offline?`, query: `why is ${offline.name} offline` });
  const db = model.services.find((s) => s.kind === "database");
  if (db) out.push({ label: `What depends on ${db.name}?`, query: `what depends on ${db.name}` });
  out.push({ label: "What changed recently?", query: "what changed recently" });
  out.push({ label: "Show everything using port 443", query: "show everything using port 443" });
  return out;
}

export function answer(model: SystemModel, raw: string): CopilotAnswer {
  const q = raw.trim();
  const lower = q.toLowerCase();

  const named = findService(model, lower);

  if (/unhealthy|broken|down|attention|wrong/.test(lower) && !named) {
    return unhealthyAnswer(model, q);
  }
  if (/depend|rely|use[ds]?\b|consumer|using/.test(lower) && named) {
    return dependentsAnswer(model, named, q);
  }
  if (/why|offline|failing|unavailable|broke/.test(lower) && named) {
    return whyOfflineAnswer(model, named, q);
  }
  if (/port\s*\d+|expose|listening/.test(lower)) {
    return portAnswer(model, q, lower);
  }
  if (/chang|recent|deploy|updat/.test(lower)) {
    return changeAnswer(model, q);
  }
  if (named) {
    return serviceOverviewAnswer(model, named, q);
  }
  return {
    question: q,
    headline: "I can explain your topology",
    body: [
      "Try asking about a specific service, what depends on something, why a service is offline, or what changed recently.",
      "Everything I answer is computed from your live service map."
    ],
    references: []
  };
}

function findService(model: SystemModel, lower: string): Service | null {
  let best: Service | null = null;
  for (const service of model.services) {
    if (lower.includes(service.name.toLowerCase())) {
      if (!best || service.name.length > best.name.length) best = service;
    }
  }
  return best;
}

function unhealthyAnswer(model: SystemModel, q: string): CopilotAnswer {
  const trouble = model.services.filter((s) => s.state !== "healthy" && s.state !== "unknown");
  if (trouble.length === 0) {
    return {
      question: q,
      headline: "Everything is healthy",
      body: ["All services are reporting a healthy state right now."],
      references: []
    };
  }
  return {
    question: q,
    headline: `${trouble.length} service${trouble.length === 1 ? "" : "s"} need attention`,
    body: trouble.map((s) => `${s.name} — ${s.state} (${s.status})`),
    references: trouble.map((s) => s.name)
  };
}

function dependentsAnswer(model: SystemModel, service: Service, q: string): CopilotAnswer {
  const impact = computeImpact(model, service.id);
  const names = impact.downstream.map((id) => model.byId.get(id)?.name ?? id);
  if (names.length === 0) {
    return {
      question: q,
      headline: `Nothing depends on ${service.name}`,
      body: [`No other service relies on ${service.name}, so it can fail in isolation.`],
      references: [service.name]
    };
  }
  return {
    question: q,
    headline: `${names.length} service${names.length === 1 ? "" : "s"} depend on ${service.name}`,
    body: [
      `If ${service.name} fails, these are affected:`,
      ...names.map((n) => `• ${n}`)
    ],
    references: [service.name, ...names]
  };
}

function whyOfflineAnswer(model: SystemModel, service: Service, q: string): CopilotAnswer {
  if (service.state === "healthy") {
    return {
      question: q,
      headline: `${service.name} is healthy`,
      body: [`${service.name} is running normally (${service.status}).`],
      references: [service.name]
    };
  }
  const brokenDeps = service.dependsOn
    .map((id) => model.byId.get(id))
    .filter((dep): dep is Service => dep !== undefined && dep.state !== "healthy");
  const body = [`${service.name} is currently ${service.state} (${service.status}).`];
  if (brokenDeps.length > 0) {
    body.push("Likely cause — an upstream dependency is also unhealthy:");
    for (const dep of brokenDeps) body.push(`• ${dep.name} is ${dep.state}`);
  } else {
    body.push("None of its dependencies are unhealthy, so the issue is likely local to this service.");
  }
  return { question: q, headline: `Why ${service.name} is ${service.state}`, body, references: [service.name, ...brokenDeps.map((d) => d.name)] };
}

function portAnswer(model: SystemModel, q: string, lower: string): CopilotAnswer {
  const match = lower.match(/port\s*(\d+)|\b(\d{2,5})\b/);
  const port = match ? match[1] ?? match[2] : null;
  const hits = model.services.filter((s) =>
    s.ports.some((p) => (port ? p.includes(port) : true))
  );
  if (!port) {
    return {
      question: q,
      headline: "Published ports",
      body: hits.flatMap((s) => s.ports.map((p) => `${s.name} → ${p}`)),
      references: hits.map((s) => s.name)
    };
  }
  if (hits.length === 0) {
    return { question: q, headline: `Nothing uses port ${port}`, body: [`No service publishes port ${port}.`], references: [] };
  }
  return {
    question: q,
    headline: `Port ${port}`,
    body: hits.map((s) => `${s.name} → ${s.ports.filter((p) => p.includes(port)).join(", ")}`),
    references: hits.map((s) => s.name)
  };
}

function changeAnswer(model: SystemModel, q: string): CopilotAnswer {
  const updates = model.services.filter((s) => s.updateAvailable);
  const body: string[] = [];
  if (updates.length > 0) {
    body.push(`${updates.length} service${updates.length === 1 ? " has" : "s have"} an update available:`);
    for (const s of updates) body.push(`• ${s.name} (${s.imageRepo}:${s.imageTag})`);
  } else {
    body.push("No pending updates detected.");
  }
  return { question: q, headline: "Recent and pending change", body, references: updates.map((s) => s.name) };
}

function serviceOverviewAnswer(model: SystemModel, service: Service, q: string): CopilotAnswer {
  const impact = computeImpact(model, service.id);
  return {
    question: q,
    headline: `${service.name} overview`,
    body: [
      `State: ${service.state} (${service.status})`,
      `Image: ${service.imageRepo}:${service.imageTag}`,
      `Depends on ${service.dependsOn.length}, used by ${impact.downstream.length}.`,
      service.ports.length ? `Ports: ${service.ports.join(", ")}` : "No published ports."
    ],
    references: [service.name]
  };
}
