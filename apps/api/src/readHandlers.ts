import type express from "express";
import type {
  ApiError,
  ComposeEditPlan,
  ComposeGraph,
  ComposeScan,
  ContainerRecord,
  DiagnosticsEntry,
  DiagnosticsReport,
  DockerSnapshot,
  FindingsResponse,
  GraphResponse,
  HealthResponse,
  ImageRecord,
  LogsResponse,
  NetworkRecord,
  RuntimeMap,
  StatusResponse,
  VolumeRecord,
} from "@dockermap/contracts";
import { HttpError } from "./daemonClient.js";
import { OPENAPI_DOCUMENT } from "./openapi.js";
import { publishApiPayload } from "./publication.js";
import { PRODUCT_VERSION } from "./generated/productVersion.js";
import {
  COMPOSE_EDIT_PLAN_QUERY_CONTRACT,
  COMPOSE_SCAN_QUERY_CONTRACT,
  LOGS_QUERY_CONTRACT,
  assertStrictRequestQueryEncoding,
  assertOnlyDeclaredQueryKeys,
  readQueryInteger,
  readQueryString,
  readRepeatedQueryStrings
} from "./requestContracts.js";

export type FetchDaemon = <T>(path: string) => Promise<T>;
export type SendError = (res: express.Response, error: unknown) => void;

export type ReadHandlerDependencies = Readonly<{
  fetchDaemon: FetchDaemon;
  sendError: SendError;
  port: number;
}>;

const maxContainerNameLength = 128;
const maxComposeFileLength = 512;

// The bare /api/v1 (with or without trailing slash) answers with a small
// version descriptor instead of 404ing. Versioned aliases for every other
// route are listed and registered by the route manifest.
export const VERSION_DESCRIPTOR = {
  service: "dockermap",
  apiVersion: "v1",
  version: PRODUCT_VERSION
} as const;

export { OPENAPI_DOCUMENT } from "./openapi.js";

export function buildLogsPath(query: express.Request["query"]) {
  assertOnlyDeclaredQueryKeys(query, LOGS_QUERY_CONTRACT);
  const params = new URLSearchParams();
  const service = readQueryString(query.service, LOGS_QUERY_CONTRACT.service);
  const q = readQueryString(query.q, LOGS_QUERY_CONTRACT.q);
  const cursor = readQueryString(query.cursor, LOGS_QUERY_CONTRACT.cursor);
  const limit = readQueryInteger(query.limit, LOGS_QUERY_CONTRACT.limit);
  if (service) params.set("service", service);
  if (q) params.set("q", q);
  if (cursor) params.set("cursor", cursor);
  if (limit !== undefined) params.set("limit", String(limit));
  const suffix = params.toString();
  return suffix ? `/daemon/logs?${suffix}` : "/daemon/logs";
}

export function buildComposeScanPath(query: express.Request["query"]) {
  assertOnlyDeclaredQueryKeys(query, COMPOSE_SCAN_QUERY_CONTRACT);
  const params = new URLSearchParams();
  const normalizedFiles = readRepeatedQueryStrings(query.file, COMPOSE_SCAN_QUERY_CONTRACT.file);
  for (const file of normalizedFiles) params.append("file", file);
  const suffix = params.toString();
  return suffix ? `/daemon/compose/scan?${suffix}` : "/daemon/compose/scan";
}

export function buildComposeEditPlanPath(query: express.Request["query"]) {
  assertOnlyDeclaredQueryKeys(query, COMPOSE_EDIT_PLAN_QUERY_CONTRACT);
  const params = new URLSearchParams();
  const file = readQueryString(query.file, COMPOSE_EDIT_PLAN_QUERY_CONTRACT.file);
  const service = readQueryString(query.service, COMPOSE_EDIT_PLAN_QUERY_CONTRACT.service);
  const mount = readQueryString(query.mount, COMPOSE_EDIT_PLAN_QUERY_CONTRACT.mount);
  const source = readQueryString(query.source, COMPOSE_EDIT_PLAN_QUERY_CONTRACT.source);
  const target = readQueryString(query.target, COMPOSE_EDIT_PLAN_QUERY_CONTRACT.target);
  params.set("file", file);
  params.set("service", service);
  params.set("mount", mount);
  if (source) params.set("source", source);
  if (target) params.set("target", target);
  return `/daemon/compose/edit-plan?${params.toString()}`;
}

export function readOptionalQueryString(value: unknown, name: string, maxLength: number) {
  if (value === undefined) return "";
  if (typeof value !== "string") {
    throw new HttpError(400, { code: "invalid_query", message: `Query parameter ${name} must be a string` });
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength || trimmed.includes("\0")) {
    throw new HttpError(400, { code: "invalid_query", message: `Query parameter ${name} must be ${maxLength} characters or fewer` });
  }
  return trimmed;
}

export function readRequiredQueryString(value: unknown, name: string, maxLength: number) {
  const parsed = readOptionalQueryString(value, name, maxLength);
  if (!parsed) throw new HttpError(400, { code: "invalid_query", message: `Query parameter ${name} is required` });
  return parsed;
}

export function readOptionalQueryInt(value: unknown, name: string, min: number, max: number) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new HttpError(400, { code: "invalid_query", message: `Query parameter ${name} must be an integer` });
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, { code: "invalid_query", message: `Query parameter ${name} must be between ${min} and ${max}` });
  }
  return parsed;
}

/** Docker's free-form status can carry a health marker that overrides `Up`. */
export function containerStatusKind(status: string): "running" | "offline" | "attention" {
  const lower = status.toLowerCase();
  const healthMatch = lower.match(/\((?:health:\s*)?([a-z]+)\)/);
  if (healthMatch) {
    const marker = healthMatch[1];
    if (marker === "unhealthy" || marker === "degraded" || marker === "starting" || marker === "started" || marker === "updating") return "attention";
    if (marker === "healthy") return "running";
  }
  const key = lower.split(/[\s(]/)[0];
  if (key === "up" || key === "running") return "running";
  if (key === "exited" || key === "dead") return "offline";
  return "attention";
}

export function createReadHandlers({ fetchDaemon, sendError, port }: ReadHandlerDependencies) {
  const respond = <T>(path: string): express.RequestHandler => async (_req, res) => {
    try { res.json(await fetchDaemon<T>(path)); } catch (error) { sendError(res, error); }
  };
  return {
    apiVersion: (_req, res) => { res.json(VERSION_DESCRIPTOR); },
    health: async (_req, res) => {
      try { const health = await fetchDaemon<HealthResponse>("/daemon/health"); res.json({ status: "ok", daemon: health }); } catch (error) { sendError(res, error); }
    },
    apiHealth: async (_req, res) => {
      try { const health = await fetchDaemon<HealthResponse>("/daemon/health"); res.json({ node: { status: "ok", port }, daemon: health, dockerReachable: health.dockerReachable }); } catch (error) { sendError(res, error); }
    },
    status: async (_req, res) => {
      try {
        const [health, snapshot] = await Promise.all([fetchDaemon<HealthResponse>("/daemon/health"), fetchDaemon<DockerSnapshot>("/daemon/snapshot")]);
        // Health and inventory can independently fall back to mock data. Do
        // not attach live mode to sample counts when those source stamps differ.
        const snapshotSource = snapshot.source ?? health.mode;
        const coherent = snapshotSource === health.mode;
        const containers = snapshot.containers.length;
        const containersRunning = snapshot.containers.filter((container) => containerStatusKind(container.status) === "running").length;
        const offline = snapshot.containers.filter((container) => containerStatusKind(container.status) === "offline").length;
        const attention = snapshot.containers.filter((container) => containerStatusKind(container.status) === "attention").length;
        const healthy = containers - offline - attention;
        res.json({ service: "dockermap", status: !health.dockerReachable ? health.mode === "mock" ? "degraded" : "offline" : attention + offline > 0 ? "degraded" : coherent ? "ok" : "degraded", mode: coherent ? health.mode : "mixed", sourceCoherent: coherent, snapshotSource, dockerReachable: health.dockerReachable, containers, containersRunning, networks: snapshot.networks.length, volumes: snapshot.volumes.length, images: snapshot.images.length, healthy, attention, offline, version: PRODUCT_VERSION } satisfies StatusResponse);
      } catch (error) { sendError(res, error); }
    },
    openapi: (_req, res) => { res.json(OPENAPI_DOCUMENT); },
    snapshot: respond<DockerSnapshot>("/daemon/snapshot"),
    graph: respond<GraphResponse>("/daemon/graph"),
    runtimeMap: respond<RuntimeMap>("/daemon/runtime/map"),
    findings: respond<FindingsResponse>("/daemon/findings"),
    diagnostics: async (_req, res) => {
      try {
        const entries: DiagnosticsEntry[] = [];
        const [scanResult, runtimeResult] = await Promise.allSettled([fetchDaemon<ComposeScan>("/daemon/compose/scan"), fetchDaemon<RuntimeMap>("/daemon/runtime/map")]);
        if (scanResult.status === "fulfilled") for (const diagnostic of scanResult.value.diagnostics) entries.push({ id: diagnostic.id, source: "compose", severity: diagnostic.severity, message: diagnostic.message, file: diagnostic.origin.file, service: diagnostic.origin.service ?? null });
        else entries.push({ id: null, source: "api", severity: "warning", message: `Compose diagnostics unavailable: ${scanResult.reason instanceof Error ? scanResult.reason.message : "request failed"}`, file: null, service: null });
        if (runtimeResult.status === "fulfilled") for (const diagnostic of runtimeResult.value.diagnostics) entries.push({ id: diagnostic.provider, source: "runtime", severity: diagnostic.severity, message: diagnostic.message, file: null, service: null });
        else entries.push({ id: null, source: "api", severity: "warning", message: `Runtime diagnostics unavailable: ${runtimeResult.reason instanceof Error ? runtimeResult.reason.message : "request failed"}`, file: null, service: null });
        res.json(publishApiPayload({ generatedAt: Date.now(), entries } satisfies DiagnosticsReport));
      } catch (error) { sendError(res, error); }
    },
    containers: respond<{ containers: ContainerRecord[] }>("/daemon/containers"),
    container: async (req, res) => { try { const name = readRequiredQueryString(req.params.name, "name", maxContainerNameLength); res.json(await fetchDaemon<ContainerRecord>(`/daemon/containers/${encodeURIComponent(name)}`)); } catch (error) { sendError(res, error); } },
    images: respond<{ images: ImageRecord[] }>("/daemon/images"),
    networks: respond<{ networks: NetworkRecord[] }>("/daemon/networks"),
    volumes: respond<{ volumes: VolumeRecord[] }>("/daemon/volumes"),
    logs: async (req, res) => { try { assertStrictRequestQueryEncoding(req, LOGS_QUERY_CONTRACT); res.json(await fetchDaemon<LogsResponse>(buildLogsPath(req.query))); } catch (error) { sendError(res, error); } },
    composeScan: async (req, res) => { try { assertStrictRequestQueryEncoding(req, COMPOSE_SCAN_QUERY_CONTRACT); res.json(await fetchDaemon<ComposeScan>(buildComposeScanPath(req.query))); } catch (error) { sendError(res, error); } },
    composeGraph: async (req, res) => { try { assertStrictRequestQueryEncoding(req, COMPOSE_SCAN_QUERY_CONTRACT); res.json(await fetchDaemon<ComposeGraph>(buildComposeScanPath(req.query).replace("/scan", "/graph"))); } catch (error) { sendError(res, error); } },
    composeEditPlan: async (req, res) => { try { assertStrictRequestQueryEncoding(req, COMPOSE_EDIT_PLAN_QUERY_CONTRACT); res.json(await fetchDaemon<ComposeEditPlan>(buildComposeEditPlanPath(req.query))); } catch (error) { sendError(res, error); } },
  } satisfies Record<string, express.RequestHandler>;
}
