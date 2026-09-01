import type express from "express";
import { HttpError } from "./daemonClient.js";

/**
 * Browser query authority for the finite logs and Compose surfaces.  This is
 * intentionally not a general validation language: these fields are the only
 * query inputs the browser API accepts and the only ones OpenAPI documents.
 */
type StringQueryContract = Readonly<{
  kind: "string";
  name: string;
  required?: boolean;
  maxLength: number;
  minLength?: number;
  pattern?: string;
}>;

type IntegerQueryContract = Readonly<{
  kind: "integer";
  name: string;
  required?: boolean;
  minimum: number;
  maximum: number;
}>;

type RepeatedStringQueryContract = Readonly<{
  kind: "repeated-string";
  name: string;
  maxItems: number;
  minLength: number;
  maxLength: number;
  pattern: string;
}>;

export type BrowserQueryContract = StringQueryContract | IntegerQueryContract | RepeatedStringQueryContract;
type BrowserQueryContractSet = Readonly<Record<string, BrowserQueryContract>>;

export const LOGS_QUERY_CONTRACT = {
  service: { kind: "string", name: "service", maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*$" },
  q: { kind: "string", name: "q", maxLength: 256 },
  cursor: { kind: "string", name: "cursor", maxLength: 32, pattern: "^\\d+(:\\d+)?$" },
  limit: { kind: "integer", name: "limit", minimum: 1, maximum: 500 }
} as const satisfies BrowserQueryContractSet;

export const COMPOSE_SCAN_QUERY_CONTRACT = {
  file: { kind: "repeated-string", name: "file", maxItems: 8, minLength: 1, maxLength: 512, pattern: "\\S" }
} as const satisfies BrowserQueryContractSet;

export const COMPOSE_EDIT_PLAN_QUERY_CONTRACT = {
  file: { kind: "string", name: "file", required: true, minLength: 1, maxLength: 512, pattern: "\\S" },
  service: { kind: "string", name: "service", required: true, minLength: 1, maxLength: 128, pattern: "\\S" },
  mount: { kind: "string", name: "mount", required: true, maxLength: 16, pattern: "^\\d+$" },
  source: { kind: "string", name: "source", maxLength: 512 },
  target: { kind: "string", name: "target", maxLength: 512 }
} as const satisfies BrowserQueryContractSet;

/** The route mapping is finite so adding documented query metadata cannot be silently unmapped. */
export const BROWSER_ROUTE_QUERY_CONTRACTS = {
  logs: LOGS_QUERY_CONTRACT,
  "compose-scan": COMPOSE_SCAN_QUERY_CONTRACT,
  "compose-graph": COMPOSE_SCAN_QUERY_CONTRACT,
  "compose-edit-plan": COMPOSE_EDIT_PLAN_QUERY_CONTRACT
} as const;

export type BrowserQueryRouteId = keyof typeof BROWSER_ROUTE_QUERY_CONTRACTS;

export function assertBrowserQueryContractCoverage(
  mappings: Partial<Record<BrowserQueryRouteId, BrowserQueryContractSet>> = BROWSER_ROUTE_QUERY_CONTRACTS
) {
  for (const routeId of Object.keys(BROWSER_ROUTE_QUERY_CONTRACTS) as BrowserQueryRouteId[]) {
    const declared = BROWSER_ROUTE_QUERY_CONTRACTS[routeId];
    const mapped = mappings[routeId];
    if (!mapped) throw new Error(`Browser query route is missing a contract mapping: ${routeId}`);
    if (mapped !== declared) throw new Error(`Browser query route must use its canonical contract: ${routeId}`);
  }
  for (const routeId of Object.keys(mappings)) {
    if (!Object.hasOwn(BROWSER_ROUTE_QUERY_CONTRACTS, routeId)) throw new Error(`Browser query route has no declared contract: ${routeId}`);
  }
}

export type OpenApiQueryParameter = Readonly<{
  name: string;
  in: "query";
  required?: boolean;
  style?: "form";
  explode?: boolean;
  schema: Readonly<Record<string, unknown>>;
}>;

export function openApiQueryParameters(contract: BrowserQueryContractSet): readonly OpenApiQueryParameter[] {
  return Object.values(contract).map((parameter) => {
    if (parameter.kind === "integer") {
      return { name: parameter.name, in: "query", ...(parameter.required ? { required: true } : {}), schema: { type: "integer", minimum: parameter.minimum, maximum: parameter.maximum } };
    }
    if (parameter.kind === "repeated-string") {
      return {
        name: parameter.name,
        in: "query",
        style: "form",
        explode: true,
        schema: { type: "array", maxItems: parameter.maxItems, items: { type: "string", minLength: parameter.minLength, maxLength: parameter.maxLength, pattern: parameter.pattern } }
      };
    }
    return {
      name: parameter.name,
      in: "query",
      ...(parameter.required ? { required: true } : {}),
      schema: {
        type: "string",
        ...(parameter.minLength ? { minLength: parameter.minLength } : {}),
        maxLength: parameter.maxLength,
        ...(parameter.pattern ? { pattern: parameter.pattern } : {})
      }
    };
  });
}

/** Reject silently ignored browser input before any daemon request is made. */
export function assertOnlyDeclaredQueryKeys(query: express.Request["query"], contract: BrowserQueryContractSet) {
  for (const name of Object.keys(query)) {
    if (!Object.hasOwn(contract, name)) invalidQuery(`Query parameter ${name} is not supported`);
  }
}

/**
 * Express's query parser intentionally substitutes replacement characters for
 * malformed percent-encoded UTF-8. That is useful for generic web forms, but
 * not for this bounded proxy: the daemon must receive exactly validated input.
 */
export function assertStrictRequestQueryEncoding(
  req: Pick<express.Request, "originalUrl">,
  contract: BrowserQueryContractSet,
) {
  const query = req.originalUrl.indexOf("?");
  if (query === -1) return;
  const raw = req.originalUrl.slice(query + 1);
  try {
    // `+` is form-url-encoding space, while decodeURIComponent validates both
    // percent triplets and their UTF-8 byte sequences without changing valid
    // Unicode supplied directly in the URL.
    decodeURIComponent(raw.replaceAll("+", " "));
  } catch {
    invalidQuery("Request query encoding is invalid");
  }
  const seen = new Set<string>();
  for (const pair of raw.split("&")) {
    const separator = pair.indexOf("=");
    const encodedName = separator === -1 ? pair : pair.slice(0, separator);
    let name: string;
    try {
      name = decodeURIComponent(encodedName.replaceAll("+", " "));
    } catch {
      invalidQuery("Request query encoding is invalid");
    }
    const parameter = contract[name];
    if (!parameter) invalidQuery(`Query parameter ${name} is not supported`);
    if (parameter.kind !== "repeated-string" && seen.has(name)) {
      invalidQuery(`Query parameter ${name} must not be repeated`);
    }
    seen.add(name);
  }
}

function invalidQuery(message: string): never {
  throw new HttpError(400, { code: "invalid_query", message });
}

export function readQueryString(value: unknown, contract: StringQueryContract): string {
  if (value === undefined) {
    if (contract.required) invalidQuery(`Query parameter ${contract.name} is required`);
    return "";
  }
  if (typeof value !== "string") invalidQuery(`Query parameter ${contract.name} must be a string`);
  const trimmed = value.trim();
  if (!trimmed && contract.required) invalidQuery(`Query parameter ${contract.name} is required`);
  if (trimmed.length > contract.maxLength || trimmed.includes("\0")) {
    invalidQuery(`Query parameter ${contract.name} must be ${contract.maxLength} characters or fewer`);
  }
  if (trimmed && contract.minLength && trimmed.length < contract.minLength) invalidQuery(`Query parameter ${contract.name} is required`);
  if (trimmed && contract.pattern && !(new RegExp(contract.pattern).test(trimmed))) {
    if (contract.name === "service") invalidQuery("Query parameter service must be a Docker container name");
    if (contract.name === "cursor") invalidQuery("Query parameter cursor must be `millis` or `millis:offset`");
    if (contract.name === "mount") invalidQuery("Query parameter mount must be a zero-based integer");
    invalidQuery(`Query parameter ${contract.name} is invalid`);
  }
  return trimmed;
}

export function readQueryInteger(value: unknown, contract: IntegerQueryContract): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) invalidQuery(`Query parameter ${contract.name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < contract.minimum || parsed > contract.maximum) {
    invalidQuery(`Query parameter ${contract.name} must be between ${contract.minimum} and ${contract.maximum}`);
  }
  return parsed;
}

export function readRepeatedQueryStrings(value: express.Request["query"][string], contract: RepeatedStringQueryContract): string[] {
  const values = value === undefined ? [] : Array.isArray(value) ? value : [value];
  if (values.length > contract.maxItems) {
    throw new HttpError(400, { code: "too_many_compose_files", message: `Compose scan accepts at most ${contract.maxItems} files` });
  }
  return values.map((value) => {
    if (typeof value !== "string" || !value.trim()) {
      throw new HttpError(400, { code: "invalid_compose_file", message: "Compose scan file query values must be non-empty strings" });
    }
    const normalized = value.trim();
    if (normalized.length > contract.maxLength || normalized.includes("\0") || !(new RegExp(contract.pattern).test(normalized))) {
      throw new HttpError(400, { code: "invalid_compose_file", message: `Compose scan file query values must be ${contract.maxLength} characters or fewer` });
    }
    return normalized;
  });
}
