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

export type SseEventName = keyof typeof SSE_EVENT_PAYLOAD_SCHEMAS;
export type SseEventPayloadSchema = (typeof SSE_EVENT_PAYLOAD_SCHEMAS)[SseEventName];

const EXPECTED_SSE_EVENT_PAYLOAD_SCHEMAS = {
  snapshot: { authority: "rust", schema: "HealthResponse" },
  error: { authority: "node", schema: "ApiError" }
} as const satisfies typeof SSE_EVENT_PAYLOAD_SCHEMAS;

export function assertSseEventSchemaCoverage(
  mappings: Record<SseEventName, SseEventPayloadSchema> = SSE_EVENT_PAYLOAD_SCHEMAS
) {
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
