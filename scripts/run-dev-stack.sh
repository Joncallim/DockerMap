#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

cleanup() {
  local pids
  mapfile -t pids < <(jobs -pr || true)
  if ((${#pids[@]} > 0)); then
    kill "${pids[@]}" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

echo "[dockermap] starting rust daemon on http://127.0.0.1:4100"
cargo run -p dockermap-daemon --manifest-path crates/Cargo.toml &

echo "[dockermap] starting node api on http://127.0.0.1:4000"
npm run dev:api &

echo "[dockermap] starting react web on http://127.0.0.1:3233"
npm run dev:web -- --host 127.0.0.1 &

wait
