import type { ApiError } from "@dockermap/contracts";
import { publishApiPayload, publishDisplayText } from "./publication.js";
import { DaemonResponseValidationError, validateDaemonResponse } from "./daemonResponseValidation.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(body.message);
  }
}

export interface DaemonClientOptions {
  baseUrl: string;
  token: string | null;
  allowMockFallback: boolean;
  exposeErrorDetails: boolean;
  mockResponse: <T>(path: string) => T;
}

function isTransportFailure(error: unknown) {
  return error instanceof TypeError || (error instanceof DOMException && error.name === "AbortError");
}

/**
 * The sole API-to-daemon transport boundary. Callers supply an already
 * validated loopback daemon URL and a bounded mock fallback; this client adds
 * the daemon-only bearer token and never exposes transport failures by
 * default.
 */
export function createDaemonClient(options: DaemonClientOptions) {
  return async function fetchDaemon<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4_000);

    try {
      const headers = new Headers();
      if (options.token) {
        headers.set("authorization", `Bearer ${options.token}`);
      }
      const response = await fetch(`${options.baseUrl}${path}`, {
        method: "GET",
        headers,
        signal: controller.signal
      });

      if (!response.ok) {
        throw new HttpError(response.status, {
          code: `daemon_${response.status}`,
          message: `Daemon request failed for ${path}`,
          ...(options.exposeErrorDetails ? { details: "Daemon HTTP error details suppressed" } : {})
        });
      }

      // Validate before publication. `publishApiPayload` redacts display-hostile
      // values; it is not (and must not become) a permissive schema sanitizer.
      return publishApiPayload(validateDaemonResponse(path, await response.json()) as T);
    } catch (error) {
      // A configured daemon token being rejected is a boundary/configuration
      // failure, not an availability event. Never substitute mock data for
      // authentication or authorization denial.
      if (error instanceof DaemonResponseValidationError) {
        // This is an internal, closed diagnostic label. It is intentionally
        // not added to the browser error: a daemon response must never choose
        // its own validation detail or use it as an exfiltration channel.
        console.error(`[DockerMap] daemon response validation rejected schema=${error.schema} reason=${error.reason}`);
        throw new HttpError(502, {
          code: "daemon_invalid_response",
          message: "Daemon response did not match its declared contract"
        });
      }
      if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
        throw error;
      }

      // Existing source-stamped mock fallback intentionally covers daemon
      // server errors as well as transport loss; consumers receive `mock`,
      // never fabricated Docker provenance. Parsing failures are not a valid
      // daemon response and fail closed.
      if (options.allowMockFallback && (isTransportFailure(error) || error instanceof HttpError)) {
        return publishApiPayload(options.mockResponse<T>(path));
      }

      if (error instanceof HttpError) {
        throw error;
      }

      console.error(`Unable to reach DockerMap daemon at ${publishDisplayText(options.baseUrl)}`);
      throw new HttpError(502, {
        code: "daemon_unavailable",
        message: "Unable to reach DockerMap daemon",
        ...(options.exposeErrorDetails ? { details: "Daemon connection failed" } : {})
      });
    } finally {
      clearTimeout(timeout);
    }
  };
}
