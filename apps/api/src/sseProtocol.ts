import type { NodeEnvelopeSchemaId, RustResponseSchemaId } from "@dockermap/contracts";

/**
 * The browser-facing SSE protocol has exactly two named JSON events.  This is
 * deliberately a declaration, rather than a second copy of either payload
 * schema: snapshots are Rust-owned daemon bytes and errors are Node-owned API
 * envelopes.
 */
export const SSE_EVENT_PAYLOAD_SCHEMAS = {
  snapshot: { authority: "rust", schema: "HealthResponse" },
  error: { authority: "node", schema: "ApiError" }
} as const satisfies Record<string, {
  authority: "rust" | "node";
  schema: RustResponseSchemaId | NodeEnvelopeSchemaId;
}>;

export const SSE_CONTENT_TYPE = "text/event-stream";
export const SSE_HEARTBEAT_COMMENT = "ping";
export type SseEventName = keyof typeof SSE_EVENT_PAYLOAD_SCHEMAS;
export type SseEventPayloadSchema = (typeof SSE_EVENT_PAYLOAD_SCHEMAS)[SseEventName];
/** Event wire names are derived from, and cannot diverge from, mapping keys. */
export const SSE_EVENT = Object.fromEntries(
  Object.keys(SSE_EVENT_PAYLOAD_SCHEMAS).map((event) => [event, event])
) as { readonly [Event in SseEventName]: Event };

const EXPECTED_SSE_EVENT_PAYLOAD_SCHEMAS = {
  snapshot: { authority: "rust", schema: "HealthResponse" },
  error: { authority: "node", schema: "ApiError" }
} as const satisfies typeof SSE_EVENT_PAYLOAD_SCHEMAS;

export function assertSseEventSchemaCoverage(
  mappings: Readonly<Record<string, SseEventPayloadSchema | undefined>> = SSE_EVENT_PAYLOAD_SCHEMAS
) {
  const actualEvents = Object.keys(mappings).sort();
  const expectedEvents = Object.keys(EXPECTED_SSE_EVENT_PAYLOAD_SCHEMAS).sort();
  if (actualEvents.length !== expectedEvents.length || actualEvents.some((event, index) => event !== expectedEvents[index])) {
    throw new Error(`SSE event schema mapping has unexpected event names: ${actualEvents.join(", ")}`);
  }
  for (const event of Object.keys(EXPECTED_SSE_EVENT_PAYLOAD_SCHEMAS) as SseEventName[]) {
    const actual = mappings[event];
    const expected = EXPECTED_SSE_EVENT_PAYLOAD_SCHEMAS[event];
    if (!actual || actual.authority !== expected.authority || actual.schema !== expected.schema) {
      throw new Error(`SSE event schema mapping drift: ${event} must be ${expected.authority}:${expected.schema}`);
    }
  }
}

export function ssePayloadSchemaRef(contract: SseEventPayloadSchema) {
  return `#/components/schemas/${contract.schema}`;
}

/** Serialize a named event from the declared event-name set. */
export function formatSseEvent(event: SseEventName, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Keepalive comments are protocol control data, never a JSON event. */
export function formatSseHeartbeat() {
  return `: ${SSE_HEARTBEAT_COMMENT}\n\n`;
}

export type ParsedSseFrame =
  | Readonly<{ kind: "event"; event: SseEventName; data: unknown }>
  | Readonly<{ kind: "comment"; comment: string }>;

/** Parse complete protocol frames for deterministic wire-contract tests. */
export function parseSseFrames(wire: string): readonly ParsedSseFrame[] {
  return wire.split("\n\n").filter(Boolean).map((frame) => {
    if (frame.startsWith(":")) return { kind: "comment", comment: frame.slice(1).trimStart() };
    const fields = frame.split("\n");
    const eventLine = fields.find((line) => line.startsWith("event: "));
    const dataLine = fields.find((line) => line.startsWith("data: "));
    if (!eventLine || !dataLine || fields.length !== 2) throw new Error(`Invalid DockerMap SSE frame: ${frame}`);
    const event = eventLine.slice("event: ".length);
    if (!(event in SSE_EVENT_PAYLOAD_SCHEMAS)) throw new Error(`Unknown DockerMap SSE event: ${event}`);
    return { kind: "event", event: event as SseEventName, data: JSON.parse(dataLine.slice("data: ".length)) };
  });
}
