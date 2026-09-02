import type { Finding, TemporalEvidenceRef } from "@dockermap/contracts";

const TEMPORAL_RULE = "docker.repeated_container_died_events";
const TEMPORAL_SUMMARY = "A Docker container had three observed die events within five minutes.";
const TEMPORAL_RECOMMENDATION = "Review the container's recent configuration and logs to determine whether the repeated exits are expected.";
const CONTAINER_ID = /^docker_container_[0-9a-f]{64}$/;
const EVENT_ID = /^docker_event_[0-9a-f]{64}$/;
const TEMPORAL_WINDOW_MS = 300_000;

/**
 * The temporal advisory is a closed, historical observation. Keep this
 * second browser boundary structural even though the API already validates
 * the response: this renderer must not turn malformed stream material into a
 * current-service conclusion or a link.
 */
export function isCoherentRepeatedContainerDiedFinding(value: unknown): value is Finding {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id", "ruleId", "severity", "summary", "recommendation", "subjectRef", "targetRef", "evidenceRefs", "temporalEvidenceRefs"
  ])) return false;

  if (value.ruleId !== TEMPORAL_RULE
    || value.severity !== "advisory"
    || value.summary !== TEMPORAL_SUMMARY
    || value.recommendation !== TEMPORAL_RECOMMENDATION
    || typeof value.id !== "string"
    || typeof value.subjectRef !== "string"
    || !CONTAINER_ID.test(value.subjectRef)
    || value.targetRef !== "docker_event_stream"
    || !Array.isArray(value.evidenceRefs)
    || value.evidenceRefs.length !== 0
    || !Array.isArray(value.temporalEvidenceRefs)
    || value.temporalEvidenceRefs.length !== 3) return false;

  if (value.id !== expectedRepeatedContainerDiedFindingId(value.subjectRef)) return false;

  const eventIds = new Set<string>();
  for (const reference of value.temporalEvidenceRefs) {
    if (!isCoherentTemporalEvidence(reference) || eventIds.has(reference.eventId)) return false;
    eventIds.add(reference.eventId);
  }

  const references = value.temporalEvidenceRefs;
  for (let index = 1; index < references.length; index += 1) {
    const prior = references[index - 1]!;
    const current = references[index]!;
    if (current.sourceOccurredAtMs < prior.sourceOccurredAtMs
      || (current.sourceOccurredAtMs === prior.sourceOccurredAtMs && current.eventId <= prior.eventId)) return false;
  }

  return references[2]!.sourceOccurredAtMs - references[0]!.sourceOccurredAtMs <= TEMPORAL_WINDOW_MS;
}

function isCoherentTemporalEvidence(value: unknown): value is TemporalEvidenceRef {
  return isRecord(value)
    && hasExactKeys(value, ["eventId", "source", "kind", "sourceOccurredAtMs", "anchorModelRevision", "anchorObservationRevision"])
    && typeof value.eventId === "string"
    && EVENT_ID.test(value.eventId)
    && value.source === "docker_event_stream"
    && value.kind === "container_died"
    && isTimestamp(value.sourceOccurredAtMs)
    && isRevision(value.anchorModelRevision)
    && isRevision(value.anchorObservationRevision);
}

// This is deliberately the same collision-resistant component used by core
// and the API boundary. The browser cannot accept an opaque ID merely because
// it looks plausible: a forged digest tail must not become a rendered card.
export function expectedRepeatedContainerDiedFindingId(subjectRef: string): string {
  return `finding_docker_repeated_container_died_events_${collisionResistantIdComponent(subjectRef)}`;
}

function collisionResistantIdComponent(value: string): string {
  let slug = "";
  let emittedSeparator = false;
  for (const character of value) {
    if (/^[A-Za-z0-9_.-]$/.test(character)) {
      slug += character;
      emittedSeparator = false;
    } else if (!emittedSeparator) {
      slug += "-";
      emittedSeparator = true;
    }
  }
  const trimmed = slug.replace(/^-+|-+$/g, "");
  const readable = trimmed.length === 0 ? "identity" : Array.from(trimmed).slice(0, 48).join("");
  return `${readable}--${sha256Hex(value)}`;
}

function sha256Hex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const length = BigInt(bitLength);
  for (let index = 0; index < 8; index += 1) {
    padded[padded.length - 1 - index] = Number((length >> BigInt(index * 8)) & 0xffn);
  }

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  const constants = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);
  const words = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const byteOffset = offset + index * 4;
      words[index] = (padded[byteOffset]! << 24) | (padded[byteOffset + 1]! << 16) | (padded[byteOffset + 2]! << 8) | padded[byteOffset + 3]!;
    }
    for (let index = 16; index < 64; index += 1) {
      const sigma0 = rotateRight(words[index - 15]!, 7) ^ rotateRight(words[index - 15]!, 18) ^ (words[index - 15]! >>> 3);
      const sigma1 = rotateRight(words[index - 2]!, 17) ^ rotateRight(words[index - 2]!, 19) ^ (words[index - 2]! >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const temp1 = (h! + sigma1 + choice + constants[index]! + words[index]!) >>> 0;
      const sigma0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temp2 = (sigma0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d! + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0]! + a!) >>> 0;
    hash[1] = (hash[1]! + b!) >>> 0;
    hash[2] = (hash[2]! + c!) >>> 0;
    hash[3] = (hash[3]! + d!) >>> 0;
    hash[4] = (hash[4]! + e!) >>> 0;
    hash[5] = (hash[5]! + f!) >>> 0;
    hash[6] = (hash[6]! + g!) >>> 0;
    hash[7] = (hash[7]! + h!) >>> 0;
  }

  return Array.from(hash, (word) => word.toString(16).padStart(8, "0")).join("");
}

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRevision(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Array.from(value).length <= 64;
}
