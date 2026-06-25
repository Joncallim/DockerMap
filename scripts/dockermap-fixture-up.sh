#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_STATE_FILE="${TMPDIR:-/tmp}/dockermap-fixture-current.env"
STATE_FILE="${DOCKERMAP_FIXTURE_STATE_FILE:-$DEFAULT_STATE_FILE}"
VERIFY=0

usage() {
  cat <<'USAGE'
Usage: scripts/dockermap-fixture-up.sh [--verify] [--state-file PATH]

Creates an isolated, labeled DockerMap fixture stack, starts DockerMap against it,
and writes a state file for scripts/dockermap-fixture-down.sh.
USAGE
}

while (($# > 0)); do
  case "$1" in
    --verify)
      VERIFY=1
      shift
      ;;
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

if [[ -e "$STATE_FILE" ]]; then
  echo "[dockermap-fixture] state file already exists: $STATE_FILE" >&2
  echo "[dockermap-fixture] run scripts/dockermap-fixture-down.sh --state-file \"$STATE_FILE\" first" >&2
  exit 2
fi

detect_docker() {
  if docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
    DOCKER_CMD=(docker)
    return
  fi
  if sudo -n docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
    DOCKER_CMD=(sudo -n docker)
    return
  fi
  echo "Docker is not reachable by the current user or sudo -n docker." >&2
  exit 2
}

free_port() {
  node -e 'const net=require("node:net"); const s=net.createServer(); s.listen(0,"127.0.0.1",()=>{console.log(s.address().port); s.close();});'
}

write_state() {
  {
    printf 'FIXTURE_DIR=%q\n' "$FIXTURE_DIR"
    printf 'PROJECT_DIR=%q\n' "$PROJECT_DIR"
    printf 'PROJECT_NAME=%q\n' "$PROJECT_NAME"
    printf 'RUN_ID=%q\n' "$RUN_ID"
    printf 'LABEL_EXPR=%q\n' "$LABEL_EXPR"
    printf 'CONTROL_CONTAINER=%q\n' "$CONTROL_CONTAINER"
    printf 'DOCKER_CMD_TEXT=%q\n' "${DOCKER_CMD[*]}"
    printf 'DAEMON_PID=%q\n' "${DAEMON_PID:-}"
    printf 'API_PID=%q\n' "${API_PID:-}"
    printf 'WEB_PID=%q\n' "${WEB_PID:-}"
    printf 'DAEMON_URL=%q\n' "$DAEMON_URL"
    printf 'API_URL=%q\n' "$API_URL"
    printf 'WEB_URL=%q\n' "$WEB_URL"
  } > "$STATE_FILE"
}

cleanup_on_error() {
  local exit_code=$?
  if [[ "$exit_code" -ne 0 ]]; then
    echo "[dockermap-fixture] setup failed; attempting cleanup" >&2
    "$ROOT_DIR/scripts/dockermap-fixture-down.sh" --state-file "$STATE_FILE" >/dev/null 2>&1 || true
  fi
  exit "$exit_code"
}
trap cleanup_on_error EXIT

curl_json() {
  local url="$1"
  local output="$2"
  curl -fsS "$url" -o "$output"
}

wait_for_url() {
  local url="$1"
  local label="$2"
  local output
  output="$(mktemp)"
  for _ in {1..120}; do
    if curl_json "$url" "$output" >/dev/null 2>&1; then
      rm -f "$output"
      return
    fi
    sleep 1
  done
  rm -f "$output"
  echo "Timed out waiting for $label at $url" >&2
  exit 1
}

detect_docker

RUN_ID="$(date +%s)-$$"
PROJECT_NAME="dockermap-fixture-${RUN_ID}"
LABEL_EXPR="com.dockermap.fixture=${RUN_ID}"
CONTROL_CONTAINER="dockermap-fixture-control-${RUN_ID}"
FIXTURE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dockermap-fixture.XXXXXX")"
PROJECT_DIR="$FIXTURE_DIR/project"
BIN_DIR="$FIXTURE_DIR/bin"
LOG_DIR="$FIXTURE_DIR/logs"
COMPOSE_FILE="$PROJECT_DIR/compose.yaml"

DAEMON_PORT="$(free_port)"
API_PORT="$(free_port)"
WEB_PORT="$(free_port)"
DAEMON_URL="http://127.0.0.1:${DAEMON_PORT}"
API_URL="http://127.0.0.1:${API_PORT}"
WEB_URL="http://127.0.0.1:${WEB_PORT}"

mkdir -p "$PROJECT_DIR/api-data" "$PROJECT_DIR/worker-data" "$PROJECT_DIR/services/node-agent" "$BIN_DIR" "$LOG_DIR"
printf 'dockermap fixture api data\n' > "$PROJECT_DIR/api-data/fixture.txt"
printf 'dockermap fixture worker data\n' > "$PROJECT_DIR/worker-data/fixture.txt"

write_state

cat > "$COMPOSE_FILE" <<YAML
name: ${PROJECT_NAME}
services:
  api:
    image: busybox:1.36.1
    command: sh -c "mkdir -p /www && echo dockermap-fixture-api > /www/index.html && httpd -f -p 8080"
    ports:
      - "127.0.0.1::8080"
    labels:
      com.dockermap.fixture: "${RUN_ID}"
      com.docker.compose.depends_on: "worker"
    volumes:
      - type: bind
        source: ./api-data
        target: /data
        read_only: true
      - type: volume
        source: fixture-cache
        target: /cache
    networks:
      - front
      - back

  worker:
    image: busybox:1.36.1
    command: sh -c "while true; do echo dockermap-fixture-worker; sleep 2; done"
    depends_on:
      - api
    labels:
      com.dockermap.fixture: "${RUN_ID}"
    volumes:
      - type: bind
        source: ./worker-data
        target: /worker-data
      - type: volume
        source: fixture-logs
        target: /logs
    networks:
      - back

  caddy-proxy:
    image: busybox:1.36.1
    command: sh -c "while true; do sleep 60; done"
    depends_on:
      - api
    labels:
      com.dockermap.fixture: "${RUN_ID}"
    networks:
      - front

  dnsmasq-dns:
    image: busybox:1.36.1
    command: sh -c "while true; do sleep 60; done"
    labels:
      com.dockermap.fixture: "${RUN_ID}"
    networks:
      - front

  tailscale-node:
    image: busybox:1.36.1
    command: sh -c "while true; do sleep 60; done"
    labels:
      com.dockermap.fixture: "${RUN_ID}"
    networks:
      - front

  headscale-control:
    image: busybox:1.36.1
    command: sh -c "while true; do sleep 60; done"
    labels:
      com.dockermap.fixture: "${RUN_ID}"
    networks:
      - back

networks:
  front:
    labels:
      com.dockermap.fixture: "${RUN_ID}"
  back:
    internal: true
    labels:
      com.dockermap.fixture: "${RUN_ID}"

volumes:
  fixture-cache:
    labels:
      com.dockermap.fixture: "${RUN_ID}"
  fixture-logs:
    labels:
      com.dockermap.fixture: "${RUN_ID}"
YAML

cat > "$PROJECT_DIR/package.json" <<JSON
{
  "name": "dockermap-fixture-root",
  "private": true,
  "packageManager": "npm@10.0.0",
  "scripts": {
    "start": "node services/node-agent/index.js"
  },
  "dependencies": {
    "openai": "^4.0.0",
    "express": "^4.18.0"
  },
  "devDependencies": {
    "tsx": "^4.0.0"
  }
}
JSON
printf '{"lockfileVersion":3,"packages":{}}\n' > "$PROJECT_DIR/package-lock.json"

cat > "$PROJECT_DIR/services/node-agent/package.json" <<JSON
{
  "name": "dockermap-fixture-agent",
  "private": true,
  "scripts": {
    "start": "node agent.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "langchain": "^0.3.0"
  }
}
JSON

cat > "$BIN_DIR/tailscale" <<JSON
#!/bin/sh
if [ "\$1 \$2" = "status --json" ]; then
  cat <<'EOF'
{
  "Self": {
    "DNSName": "dockermap-fixture.tailnet.test.",
    "HostName": "dockermap-fixture",
    "Online": true,
    "TailscaleIPs": ["100.64.0.10"]
  },
  "Peer": {
    "peer-1": {
      "DNSName": "dockermap-peer.tailnet.test.",
      "HostName": "dockermap-peer",
      "Online": true,
      "TailscaleIPs": ["100.64.0.11"]
    }
  }
}
EOF
  exit 0
fi
exit 1
JSON

cat > "$BIN_DIR/headscale" <<JSON
#!/bin/sh
if [ "\$1 \$2 \$3 \$4" = "nodes list --output json" ]; then
  cat <<'EOF'
[
  {
    "id": "fixture-node-1",
    "givenName": "dockermap-headscale-node",
    "online": true,
    "ipAddresses": ["100.65.0.20"],
    "user": "fixture"
  }
]
EOF
  exit 0
fi
exit 1
JSON

cat > "$BIN_DIR/systemctl" <<JSON
#!/bin/sh
case "\$1" in
  list-units)
    cat <<'EOF'
dockermap-fixture-api.service loaded active running DockerMap fixture API service
dockermap-fixture-worker.service loaded active running DockerMap fixture worker service
EOF
    exit 0
    ;;
  show)
    cat <<'EOF'
Id=dockermap-fixture-api.service
ActiveState=active
SubState=running
Description=DockerMap fixture API service
FragmentPath=/tmp/dockermap-fixture-api.service
LoadState=loaded
ExecStart={ path=/usr/bin/node ; argv[]=node server.js ; }
Requires=dockermap-fixture-worker.service
Wants=
PartOf=

Id=dockermap-fixture-worker.service
ActiveState=active
SubState=running
Description=DockerMap fixture worker service
FragmentPath=/tmp/dockermap-fixture-worker.service
LoadState=loaded
ExecStart={ path=/usr/bin/python ; argv[]=python worker.py ; }
Requires=
Wants=
PartOf=
EOF
    exit 0
    ;;
esac
exit 1
JSON

cat > "$BIN_DIR/pm2" <<JSON
#!/bin/sh
if [ "\$1" = "jlist" ]; then
  cat <<'EOF'
[
  {
    "pm_id": 42,
    "name": "dockermap-fixture-pm2",
    "pm2_env": {
      "name": "dockermap-fixture-pm2",
      "status": "online",
      "pm_cwd": "/tmp/dockermap-fixture",
      "pm_exec_path": "/tmp/dockermap-fixture/app.js",
      "restart_time": 0
    }
  }
]
EOF
  exit 0
fi
exit 1
JSON

cat > "$BIN_DIR/tmux" <<JSON
#!/bin/sh
if [ "\$1" = "list-sessions" ]; then
  printf '%s\t%s\t%s\t%s\n' "fixture-session-${RUN_ID}" "dockermap-fixture-agent" "0" "1"
  exit 0
fi
exit 1
JSON

cat > "$BIN_DIR/crontab" <<'JSON'
#!/bin/sh
if [ "$1" = "-l" ]; then
  echo "*/5 * * * * /usr/local/bin/dockermap-fixture-job --read-only"
  exit 0
fi
exit 1
JSON

chmod +x "$BIN_DIR/tailscale" "$BIN_DIR/headscale" "$BIN_DIR/systemctl" "$BIN_DIR/pm2" "$BIN_DIR/tmux" "$BIN_DIR/crontab"

echo "[dockermap-fixture] starting labeled Compose project $PROJECT_NAME"
"${DOCKER_CMD[@]}" compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" up -d

echo "[dockermap-fixture] starting unlabeled control container $CONTROL_CONTAINER"
"${DOCKER_CMD[@]}" run -d --name "$CONTROL_CONTAINER" busybox:1.36.1 sh -c 'while true; do sleep 60; done' >/dev/null

echo "[dockermap-fixture] building daemon binary"
cargo build --manifest-path "$ROOT_DIR/crates/Cargo.toml" -p dockermap-daemon >/dev/null

echo "[dockermap-fixture] starting Rust daemon on $DAEMON_URL"
PATH="$BIN_DIR:$PATH" \
  DOCKERMAP_DAEMON_HOST=127.0.0.1 \
  DOCKERMAP_DAEMON_PORT="$DAEMON_PORT" \
  DOCKERMAP_PROJECT_ROOT="$PROJECT_DIR" \
  DOCKERMAP_DOCKER_LABEL_FILTER="$LABEL_EXPR" \
  "$ROOT_DIR/crates/target/debug/dockermap-daemon" > "$LOG_DIR/daemon.log" 2>&1 &
DAEMON_PID=$!
write_state
wait_for_url "$DAEMON_URL/daemon/health" "daemon health"

echo "[dockermap-fixture] starting Node API on $API_URL"
PORT="$API_PORT" \
  DOCKERMAP_DAEMON_URL="$DAEMON_URL" \
  DOCKERMAP_ALLOWED_ORIGINS="$WEB_URL" \
  "$ROOT_DIR/node_modules/.bin/tsx" "$ROOT_DIR/apps/api/src/index.ts" > "$LOG_DIR/api.log" 2>&1 &
API_PID=$!
write_state
wait_for_url "$API_URL/api/health" "API health"

echo "[dockermap-fixture] starting web app on $WEB_URL"
VITE_API_BASE_URL="$API_URL" \
  npm --workspace @dockermap/web run dev -- --host 127.0.0.1 --port "$WEB_PORT" --strictPort > "$LOG_DIR/web.log" 2>&1 &
WEB_PID=$!
write_state
wait_for_url "$WEB_URL" "web app"

if [[ "$VERIFY" -eq 1 ]]; then
  echo "[dockermap-fixture] running fixture smoke checks"
  snapshot_file="$(mktemp)"
  runtime_file="$(mktemp)"
  scan_file="$(mktemp)"
  edit_file="$(mktemp)"
  curl_json "$API_URL/api/snapshot" "$snapshot_file"
  curl_json "$API_URL/api/runtime/map" "$runtime_file"
  curl_json "$API_URL/api/compose/scan?file=compose.yaml" "$scan_file"
  curl_json "$API_URL/api/compose/edit-plan?file=compose.yaml&service=api&mount=0&source=./api-data" "$edit_file"
  PROJECT_NAME="$PROJECT_NAME" CONTROL_CONTAINER="$CONTROL_CONTAINER" REQUIRE_NETWORK_PROVIDER="$([[ -f /proc/net/tcp ]] && echo 1 || echo 0)" \
    node - "$snapshot_file" "$runtime_file" "$scan_file" "$edit_file" <<'NODE'
const fs = require("node:fs");
const [snapshotPath, runtimePath, scanPath, editPath] = process.argv.slice(2);
const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
const scan = JSON.parse(fs.readFileSync(scanPath, "utf8"));
const edit = JSON.parse(fs.readFileSync(editPath, "utf8"));
const projectName = process.env.PROJECT_NAME;
const controlContainer = process.env.CONTROL_CONTAINER;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const containerNames = snapshot.containers.map((container) => container.name);
assert(containerNames.some((name) => name.includes(`${projectName}-api-1`)), "missing fixture api container");
assert(containerNames.some((name) => name.includes(`${projectName}-worker-1`)), "missing fixture worker container");
assert(!containerNames.includes(controlContainer), "unlabeled control container leaked into filtered snapshot");

const networkNames = snapshot.networks.map((network) => network.name);
assert(networkNames.includes(`${projectName}_front`), "missing fixture front network");
assert(networkNames.includes(`${projectName}_back`), "missing fixture back network");

const volumeNames = snapshot.volumes.map((volume) => volume.name);
assert(volumeNames.includes(`${projectName}_fixture-cache`), "missing fixture cache volume");
assert(volumeNames.includes(`${projectName}_fixture-logs`), "missing fixture logs volume");

const providers = new Set(runtime.nodes.map((node) => node.provider));
for (const provider of ["docker", "reverse_proxy", "local_dns", "tailscale", "headscale", "npm", "tmux", "systemd", "pm2", "scheduled_job"]) {
  assert(providers.has(provider), `missing runtime provider ${provider}`);
}
if (process.env.REQUIRE_NETWORK_PROVIDER === "1") {
  assert(providers.has("network"), "missing runtime network listener provider");
}

assert(scan.correlations.length > 0, "missing compose/runtime mount correlations");
if (process.platform === "linux") {
  assert(scan.correlations.some((correlation) => correlation.status === "matched"), "missing matched compose/runtime mount correlation");
}
assert(edit.willWrite === false, "compose edit plan must remain dry-run only");
NODE
  rm -f "$snapshot_file" "$runtime_file" "$scan_file" "$edit_file"
fi

trap - EXIT

echo "[dockermap-fixture] ready"
echo "  Web:     $WEB_URL"
echo "  API:     $API_URL"
echo "  Daemon:  $DAEMON_URL"
echo "  State:   $STATE_FILE"
echo "  Logs:    $LOG_DIR"
echo
echo "Tear down with:"
echo "  scripts/dockermap-fixture-down.sh --state-file \"$STATE_FILE\""
