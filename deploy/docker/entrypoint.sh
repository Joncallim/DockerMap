#!/bin/sh
set -eu

cleanup() {
  kill "$daemon_pid" "$api_pid" >/dev/null 2>&1 || true
}
trap cleanup TERM INT

mkdir -p "${DOCKERMAP_PROJECT_ROOT:-/opt/dockermap/project}"

echo "[dockermap] starting rust daemon on ${DOCKERMAP_DAEMON_HOST:-127.0.0.1}:${DOCKERMAP_DAEMON_PORT:-4100}"
/usr/local/bin/dockermap-daemon &
daemon_pid=$!

echo "[dockermap] starting node api on 127.0.0.1:${PORT:-4000}"
node /opt/dockermap/apps/api/dist/index.js &
api_pid=$!

echo "[dockermap] starting nginx on :3233"
exec nginx -g "daemon off;"
