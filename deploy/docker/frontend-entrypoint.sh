#!/bin/sh
set -eu

node /opt/dockermap/apps/api/dist/index.js &
api_pid=$!
nginx -g 'daemon off;' &
nginx_pid=$!

cleanup() {
  kill "$api_pid" "$nginx_pid" >/dev/null 2>&1 || true
}
trap 'cleanup; exit 0' TERM INT

while :; do
  for pid in "$api_pid" "$nginx_pid"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      cleanup
      exit 1
    fi
  done
  sleep 1
done
