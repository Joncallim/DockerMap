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
fi

require_auth_json "/api/health"

require_auth_json "/api/snapshot"
require_auth_json "/api/runtime/map"
require_auth_json "/api/compose/scan"
check_sse "/api/events/stream"

echo "[dockermap] smoke checks passed"
