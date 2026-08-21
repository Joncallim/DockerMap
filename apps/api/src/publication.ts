import type { LogEntry, LogsResponse } from "@dockermap/contracts";

const REDACTED_VALUE = "[redacted]";

/** Normalize every hostile provider string at the browser-facing boundary. */
export function publishDisplayText(value: string): string {
  const redacted = isSensitiveText(value) ? REDACTED_VALUE : value;
  return Array.from(redacted)
    .map((character) => (isUnsafeDisplayCharacter(character) ? "\uFFFD" : character))
    .join("");
}

/**
 * Clone arbitrary JSON-shaped daemon data through the shared publication
 * boundary. This intentionally processes property names too: provider-owned
 * label/environment maps must not escape through a dynamic object key.
 */
export function publishApiPayload<T>(value: T): T {
  if (typeof value === "string") {
    return publishDisplayText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => publishApiPayload(item)) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        publishDisplayText(key),
        publishApiPayload(item)
      ])
    ) as T;
  }
  return value;
}

/**
 * Shared log response publisher for both daemon passthrough and Node mock
 * paths. Entries are sanitized before query matching or cursor arithmetic so
 * neither source can expose or paginate according to raw secret text.
 */
export function publishLogsResponse(
  service: string | null,
  entries: LogEntry[],
  query: string | null,
  cursor: string | null,
  limit: number
): LogsResponse {
  const publishedService = service === null ? null : publishDisplayText(service);
  const filter = query?.toLowerCase() ?? null;
  const safeEntries = entries.map((entry) => publishApiPayload(entry));
  let filtered = safeEntries
    .filter((entry) => publishedService === null || entry.container === publishedService)
    .filter((entry) => filter === null || entry.message.toLowerCase().includes(filter));

  // Stable newest-first order keeps same-millisecond cursor offsets deterministic.
  filtered = [...filtered].sort((left, right) => right.timestamp - left.timestamp);
  if (cursor !== null) {
    const [millisPart, offsetPart = "0"] = cursor.split(":", 2);
    const millis = Number(millisPart);
    const offset = Number(offsetPart);
    let sameTimestampSeen = 0;
    filtered = filtered.filter((entry) => {
      if (entry.timestamp < millis) return true;
      if (entry.timestamp > millis) return false;
      const keep = sameTimestampSeen >= offset;
      sameTimestampSeen += 1;
      return keep;
    });
  }

  const boundedLimit = Math.max(1, Math.min(500, limit));
  const hasMore = filtered.length > boundedLimit;
  const page = filtered.slice(0, boundedLimit);
  const boundary = page.at(-1);
  const nextCursor =
    hasMore && boundary
      ? (() => {
          const firstAtBoundary = page.findIndex((entry) => entry.timestamp === boundary.timestamp);
          const [cursorMillisPart = "", offsetPart = "0"] = (cursor ?? "").split(":", 2);
          const previouslyEmitted = Number(cursorMillisPart) === boundary.timestamp ? Number(offsetPart) : 0;
          return `${boundary.timestamp}:${previouslyEmitted + page.length - firstAtBoundary}`;
        })()
      : null;

  return { service: publishedService, entries: page, nextCursor };
}

function isUnsafeDisplayCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2069) ||
    code === 0xfeff ||
    (code >= 0xfdd0 && code <= 0xfdef) ||
    (code & 0xffff) === 0xfffe ||
    (code & 0xffff) === 0xffff
  );
}

function isSensitiveText(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes("dockermap_test_fake_") ||
    containsUrlUserinfo(value) ||
    [
      "token=",
      "token:",
      "auth_token=",
      "auth_token:",
      "_authtoken=",
      "_authtoken:",
      "_auth=",
      "_auth:",
      "api_key=",
      "api_key:",
      "api-key=",
      "api-key:",
      "apikey=",
      "apikey:",
      "x-api-key=",
      "x-api-key:",
      "secret_key=",
      "secret_key:",
      "secret-key=",
      "secret-key:",
      "secret_access_key=",
      "secret_access_key:",
      "secret-access-key=",
      "secret-access-key:",
      "aws_secret_access_key=",
      "aws_secret_access_key:",
      "authorization=",
      "authorization:",
      "password=",
      "password:",
      "passwd=",
      "passwd:",
      "secret=",
      "secret:",
      "client_secret=",
      "client_secret:",
      "private_key=",
      "private_key:",
      "credential=",
      "credential:",
      "access_token=",
      "access_token:",
      "refresh_token=",
      "refresh_token:"
    ].some((needle) => lower.includes(needle)) ||
    value
      .split(/\s+/)
      .some((token) =>
        ["--token", "--auth", "--api-key", "--authorization", "--password", "--secret", "--client-secret", "--private-key"].some(
          (flag) => token.toLowerCase() === flag || token.toLowerCase().startsWith(`${flag}=`)
        )
      ) ||
    lower.trimStart().startsWith("bearer ") ||
    lower.includes("authorization=bearer") ||
    lower.includes("authorization=basic")
  );
}

function containsUrlUserinfo(value: string): boolean {
  const scheme = value.indexOf("://");
  if (scheme < 0) return false;
  const authority = value.slice(scheme + 3).split(/[/?#]/, 1)[0] ?? "";
  return authority.includes("@");
}
