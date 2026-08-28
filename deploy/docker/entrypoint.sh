#!/bin/sh
set -eu

daemon_pid=
gateway_pid=
api_pid=
nginx_pid=
shutting_down=

cleanup() {
  # Best-effort graceful shutdown of every child. The daemon handles SIGTERM
  # (see shutdown_signal in the daemon), node and nginx both exit on it too.
  kill "$gateway_pid" "$daemon_pid" "$api_pid" "$nginx_pid" >/dev/null 2>&1 || true
}

shutdown() {
  # Signal-initiated shutdown: remember it so the poll loop can exit 0 below
  # (a graceful docker stop should not look like a crash).
  shutting_down=1
  cleanup
}
trap shutdown TERM INT

mkdir -p "${DOCKERMAP_PROJECT_ROOT:-/opt/dockermap/project}"

echo "[dockermap] starting Docker Read Gateway"
/usr/local/bin/dockermap-docker-gateway &
gateway_pid=$!

echo "[dockermap] starting rust daemon on ${DOCKERMAP_DAEMON_HOST:-127.0.0.1}:${DOCKERMAP_DAEMON_PORT:-4100}"
/usr/local/bin/dockermap-daemon &
daemon_pid=$!

echo "[dockermap] starting node api on 127.0.0.1:${PORT:-4000}"
node /opt/dockermap/apps/api/dist/index.js &
api_pid=$!

echo "[dockermap] starting nginx on :3233"
nginx -g "daemon off;" &
nginx_pid=$!

# Stay in the foreground so signals reach the trap (an `exec`ed nginx would
# replace this shell and orphan the other two children). Exit as soon as any
# child terminates so the container stops instead of running half-dead.
# POSIX sh has no `wait -n`, so poll with kill -0.
while :; do
  for pid in "$gateway_pid" "$daemon_pid" "$api_pid" "$nginx_pid"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      cleanup
      # A child dying after a signal-initiated shutdown is the expected
      # teardown path — exit 0. Only an unexpected child death is a crash.
      if [ "$shutting_down" = 1 ]; then
        exit 0
      fi
      exit 1
    fi
  done
  sleep 1
done
