#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_STATE_FILE="${TMPDIR:-/tmp}/dockermap-fixture-current.env"
STATE_FILE="${DOCKERMAP_FIXTURE_STATE_FILE:-$DEFAULT_STATE_FILE}"

usage() {
  cat <<'USAGE'
Usage: scripts/dockermap-fixture-down.sh [--state-file PATH]

Stops and removes the DockerMap sandbox fixture described by the state file.
The command is idempotent.
USAGE
}

while (($# > 0)); do
  case "$1" in
    --state-file)
      STATE_FILE="${2:?missing value for --state-file}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! -e "$STATE_FILE" ]]; then
  echo "[dockermap-fixture] no fixture state file found at $STATE_FILE"
  exit 0
fi

# shellcheck disable=SC1090
source "$STATE_FILE"

IFS=' ' read -r -a DOCKER_CMD <<< "${DOCKER_CMD_TEXT:-docker}"

kill_tree() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    return 0
  fi

  local children=()
  if command -v pgrep >/dev/null 2>&1; then
    while IFS= read -r child; do
      [[ -n "$child" ]] && children+=("$child")
    done < <(pgrep -P "$pid" 2>/dev/null || true)
  fi

  if ((${#children[@]} > 0)); then
    for child in "${children[@]}"; do
      kill_tree "$child"
    done
  fi

  kill "$pid" >/dev/null 2>&1 || true
}

wait_dead() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  for _ in {1..30}; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  kill -9 "$pid" >/dev/null 2>&1 || true
}

echo "[dockermap-fixture] stopping fixture-started DockerMap processes"
for pid in "${WEB_PID:-}" "${API_PID:-}" "${DAEMON_PID:-}"; do
  kill_tree "$pid"
done
for pid in "${WEB_PID:-}" "${API_PID:-}" "${DAEMON_PID:-}"; do
  wait_dead "$pid"
done

if [[ -n "${CONTROL_CONTAINER:-}" ]]; then
  echo "[dockermap-fixture] removing unlabeled control container $CONTROL_CONTAINER"
  "${DOCKER_CMD[@]}" rm -f "$CONTROL_CONTAINER" >/dev/null 2>&1 || true
fi

if [[ -n "${PROJECT_NAME:-}" && -n "${PROJECT_DIR:-}" && -f "$PROJECT_DIR/compose.yaml" ]]; then
  echo "[dockermap-fixture] removing Compose project $PROJECT_NAME"
  "${DOCKER_CMD[@]}" compose -p "$PROJECT_NAME" -f "$PROJECT_DIR/compose.yaml" down --volumes --remove-orphans >/dev/null 2>&1 || true
fi

if [[ -n "${LABEL_EXPR:-}" ]]; then
  leaked_containers="$("${DOCKER_CMD[@]}" ps -a --filter "label=$LABEL_EXPR" --format '{{.Names}}' 2>/dev/null || true)"
  leaked_networks="$("${DOCKER_CMD[@]}" network ls --filter "label=$LABEL_EXPR" --format '{{.Name}}' 2>/dev/null || true)"
  leaked_volumes="$("${DOCKER_CMD[@]}" volume ls --filter "label=$LABEL_EXPR" --format '{{.Name}}' 2>/dev/null || true)"
  if [[ -n "$leaked_containers$leaked_networks$leaked_volumes" ]]; then
    echo "[dockermap-fixture] warning: fixture-labeled Docker resources remain" >&2
    [[ -n "$leaked_containers" ]] && printf 'containers:\n%s\n' "$leaked_containers" >&2
    [[ -n "$leaked_networks" ]] && printf 'networks:\n%s\n' "$leaked_networks" >&2
    [[ -n "$leaked_volumes" ]] && printf 'volumes:\n%s\n' "$leaked_volumes" >&2
  fi
fi

if [[ -n "${FIXTURE_DIR:-}" ]]; then
  echo "[dockermap-fixture] removing fixture root $FIXTURE_DIR"
  rm -rf "$FIXTURE_DIR"
fi

rm -f "$STATE_FILE"
echo "[dockermap-fixture] removed fixture state $STATE_FILE"
