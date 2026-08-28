/**
 * Browser-API startup configuration validation.
 *
 * These functions are dependency-light on purpose: auth, routing, and daemon
 * transport consume validated values but must not loosen their startup policy.
 */

export function readPort(value: string | undefined, fallback: number) {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid PORT value: ${value}`);
  }
  return port;
}

export function readBoundedNumber(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function readDaemonBaseUrl(value: string) {
  const parsed = new URL(value);
  const allowRemoteDaemon = process.env.DOCKERMAP_ALLOW_REMOTE_DAEMON === "true";
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("DOCKERMAP_DAEMON_URL must use http or https");
  }

  if (!allowRemoteDaemon && !loopbackHosts.has(parsed.hostname)) {
    throw new Error("DOCKERMAP_DAEMON_URL must be loopback unless DOCKERMAP_ALLOW_REMOTE_DAEMON=true");
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

export function readAllowedOrigins(value: string) {
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => {
      if (origin === "*") {
        throw new Error("DOCKERMAP_ALLOWED_ORIGINS must list explicit origins; wildcard is not allowed");
      }

      const parsed = new URL(origin);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error(`DOCKERMAP_ALLOWED_ORIGINS contains unsupported origin: ${origin}`);
      }
      if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
        throw new Error(`DOCKERMAP_ALLOWED_ORIGINS must contain origins only, not paths: ${origin}`);
      }

      return parsed.origin;
    });
}

export function readHeaderName(value: string | undefined, fallback: string) {
  const name = (value ?? fallback).trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new Error(`Invalid forward-auth header name: ${value}`);
  }
  return name;
}

export function readCookieName(value: string | undefined, fallback: string) {
  const name = (value ?? fallback).trim();
  if (!/^[a-zA-Z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
    throw new Error(`Invalid auth cookie name: ${value}`);
  }
  return name;
}

export function readApiToken(value: string | undefined) {
  if (value === undefined) {
    return null;
  }

  const token = value.trim();
  if (!token) {
    throw new Error("DOCKERMAP_API_TOKEN must not be empty when set");
  }
  return token;
}

export function readDaemonToken(value: string | undefined, fallback: string | null) {
  if (value === undefined) {
    return fallback;
  }

  const token = value.trim();
  if (!token) {
    throw new Error("DOCKERMAP_DAEMON_TOKEN must not be empty when set");
  }
  return token;
}
