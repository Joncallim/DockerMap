#!/bin/bash

set -euo pipefail

BASE_URL="${DOCKERMAP_SMOKE_URL:-http://127.0.0.1:4000}"
TOKEN="${DOCKERMAP_API_TOKEN:-}"
TMP_BODY="$(mktemp -t dockermap-smoke-body.XXXXXX)"
TMP_STREAM="$(mktemp -t dockermap-smoke-stream.XXXXXX)"

cleanup() {
  rm -f "$TMP_BODY" "$TMP_STREAM"
}

trap cleanup EXIT

require_http_200() {
  local path="$1"
  local status
  shift
  status="$(curl -fsS -o "$TMP_BODY" -w "%{http_code}" "$@" "$BASE_URL$path" 2>/dev/null || true)"
  if [[ "$status" != "200" ]]; then
    echo "Expected 200 for $path, got $status" >&2
    cat "$TMP_BODY" >&2 || true
    exit 1
  fi
}

require_http_status() {
  local path="$1"
  local expected="$2"
  shift 2
  local status
  status="$(curl -sS -o "$TMP_BODY" -w "%{http_code}" "$@" "$BASE_URL$path" 2>/dev/null || true)"
  if [[ "$status" != "$expected" ]]; then
    echo "Expected $expected for $path, got $status" >&2
    cat "$TMP_BODY" >&2 || true
    exit 1
  fi
}

require_auth_json() {
  local path="$1"
  local -a args=()
  if [[ -n "$TOKEN" ]]; then
    args+=(-H "Authorization: Bearer ${TOKEN}")
  fi
  require_http_200 "$path" "${args[@]}"
}

check_history() {
  require_auth_json "/api/history"
  if ! node - "$TMP_BODY" <<'NODE'
const { readFileSync } = require("node:fs");

const value = JSON.parse(readFileSync(process.argv[2], "utf8"));
const rootKeys = ["baselineEstablished", "currentModelRevision", "events", "observedRevision", "source"];
const exactKeys = (candidate, expected) => candidate !== null
  && typeof candidate === "object"
  && !Array.isArray(candidate)
  && Object.keys(candidate).sort().join("\0") === [...expected].sort().join("\0");
const fail = () => process.exit(1);

if (!exactKeys(value, rootKeys) || !Array.isArray(value.events) || value.events.length > 64) fail();
if (value.source === "mock") {
  if (value.baselineEstablished !== false
    || value.currentModelRevision !== null
    || value.observedRevision !== null
    || value.events.length !== 0) fail();
  process.exit(0);
}
if (value.source !== "docker"
  || value.baselineEstablished !== true
  || typeof value.currentModelRevision !== "string" || value.currentModelRevision.length === 0
  || typeof value.observedRevision !== "string" || value.observedRevision.length === 0) fail();

const eventKeys = ["containerId", "currentStatus", "id", "kind", "observedAtMs", "previousStatus"];
const statuses = new Set(["running", "stopped", "other"]);
const ids = new Set();
let epoch = null;
let priorSequence = null;
let priorObservedAt = Number.POSITIVE_INFINITY;
for (const event of value.events) {
  if (!exactKeys(event, eventKeys)
    || typeof event.id !== "string"
    || typeof event.containerId !== "string"
    || !/^docker_container_[0-9a-f]{64}$/.test(event.containerId)
    || !Number.isSafeInteger(event.observedAtMs) || event.observedAtMs < 0
    || event.observedAtMs > priorObservedAt
    || ids.has(event.id)) fail();
  const match = /^([0-9a-f]{32})-([1-9][0-9]{0,19})$/.exec(event.id);
  if (!match) fail();
  const sequence = BigInt(match[2]);
  if (sequence > 18446744073709551615n
    || (epoch !== null && match[1] !== epoch)
    || (priorSequence !== null && sequence >= priorSequence)) fail();
  const previous = event.previousStatus;
  const current = event.currentStatus;
  const coherent = event.kind === "container_appeared"
    ? previous === null && statuses.has(current)
    : event.kind === "container_disappeared"
      ? statuses.has(previous) && current === null
      : event.kind === "container_status_changed"
        && statuses.has(previous) && statuses.has(current) && previous !== current;
  if (!coherent) fail();
  ids.add(event.id);
  epoch = match[1];
  priorSequence = sequence;
  priorObservedAt = event.observedAtMs;
}
NODE
  then
    echo "Expected /api/history to return the closed mock-or-live history contract" >&2
    exit 1
  fi
}

check_sse() {
  local path="$1"
  local -a args=(--no-buffer --max-time 10 -s)
  local curl_status
  if [[ -n "$TOKEN" ]]; then
    args+=(-H "Authorization: Bearer ${TOKEN}")
  fi

  set +e
  curl "${args[@]}" "$BASE_URL$path" >"$TMP_STREAM"
  curl_status="$?"
  set -e

  if [[ "$curl_status" != "0" && "$curl_status" != "28" ]]; then
    echo "Expected SSE stream for $path, curl exited with $curl_status" >&2
    cat "$TMP_STREAM" >&2 || true
    exit 1
  fi

  if ! grep -q '^event: snapshot$' "$TMP_STREAM"; then
    echo "Expected SSE snapshot event for $path" >&2
    cat "$TMP_STREAM" >&2 || true
    exit 1
  fi

  if ! grep -q '^data: ' "$TMP_STREAM"; then
    echo "Expected SSE data payload for $path" >&2
    cat "$TMP_STREAM" >&2 || true
    exit 1
  fi
}

echo "[dockermap] smoke target: $BASE_URL"

if [[ -n "$TOKEN" ]]; then
  echo "[dockermap] verifying browser API routes reject unauthenticated direct access"
  require_http_status "/api/health" "401"
  require_http_status "/api/snapshot" "401"
  require_http_status "/api/history" "401"
fi

require_auth_json "/api/health"

require_auth_json "/api/snapshot"
require_auth_json "/api/runtime/map"
require_auth_json "/api/compose/scan"
check_history
check_sse "/api/events/stream"

echo "[dockermap] smoke checks passed"
