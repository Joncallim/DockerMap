#!/bin/bash

set -euo pipefail

BASE_URL="${DOCKERMAP_SMOKE_URL:-http://127.0.0.1:4000}"
TOKEN="${DOCKERMAP_API_TOKEN:-}"

curl_json() {
  local path="$1"
  local status
  status="$(curl -fsS -o /tmp/dockermap-smoke.json -w "%{http_code}" "$BASE_URL$path")"
  if [[ "$status" != "200" ]]; then
    echo "Expected 200 for $path, got $status" >&2
    cat /tmp/dockermap-smoke.json >&2 || true
    exit 1
  fi
}

curl_auth_json() {
  local path="$1"
  local status
  local args=(-fsS -o /tmp/dockermap-smoke.json -w "%{http_code}")
  if [[ -n "$TOKEN" ]]; then
    args+=(-H "Authorization: Bearer $TOKEN")
  fi
  status="$(curl "${args[@]}" "$BASE_URL$path")"
  if [[ "$status" != "200" ]]; then
    echo "Expected 200 for $path, got $status" >&2
    cat /tmp/dockermap-smoke.json >&2 || true
    exit 1
  fi
}

echo "[dockermap] smoke target: $BASE_URL"
curl_json "/api/health"
curl_auth_json "/api/snapshot"
curl_auth_json "/api/runtime/map"
curl_auth_json "/api/compose/scan"

echo "[dockermap] smoke checks passed"
