#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PIDS=()

kill_tree() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    return 0
  fi

  local children=()
  local child
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

cleanup() {
  local exit_code=$?
  local pid
  trap - EXIT INT TERM

  if ((${#PIDS[@]} > 0)); then
    echo
    echo "[dockermap] stopping dev stack"
    for pid in "${PIDS[@]}"; do
      kill_tree "$pid"
    done
    for pid in "${PIDS[@]}"; do
      wait "$pid" >/dev/null 2>&1 || true
    done
  fi

  exit "$exit_code"
}

trap cleanup EXIT INT TERM

start_background() {
  "$@" &
  PIDS+=("$!")
}

echo "[dockermap] starting rust daemon on http://127.0.0.1:4100"
start_background env CARGO_INCREMENTAL="${CARGO_INCREMENTAL:-0}" cargo run -p dockermap-daemon --manifest-path crates/Cargo.toml

echo "[dockermap] starting node api on http://127.0.0.1:4000"
start_background npm run dev:api

echo "[dockermap] starting react web on http://127.0.0.1:3233"
start_background npm --workspace @dockermap/web run dev -- --host 127.0.0.1 --port 3233 --strictPort

wait
