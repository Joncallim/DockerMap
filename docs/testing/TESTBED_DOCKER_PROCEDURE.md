# DockerMap Testbed Docker Procedure

Use this procedure when you need to run DockerMap against an isolated Docker
testbed and record a full manual test pass. The testbed is read-only from
DockerMap's point of view: the fixture scripts create and remove Docker
resources, but DockerMap itself must only inspect them.

## What The Testbed Starts

`scripts/dockermap-fixture-up.sh` creates one temporary fixture under `/tmp` and
writes a state file that teardown uses later.

The fixture includes:

- a labeled Docker Compose project with `api`, `worker`, `caddy-proxy`,
  `dnsmasq-dns`, `tailscale-node`, and `headscale-control` containers;
- two labeled Docker networks, `front` and `back`;
- two labeled Docker volumes, `fixture-cache` and `fixture-logs`;
- bind mounts for `api-data` and `worker-data`;
- an unlabeled BusyBox control container that must not appear in DockerMap;
- a generated npm project tree under the fixture project root;
- temporary fixed-output command stubs for `tailscale`, `headscale`,
  `systemctl`, `pm2`, `tmux`, and `crontab`;
- DockerMap daemon, API, and web processes on random loopback ports.

The daemon receives `DOCKERMAP_DOCKER_LABEL_FILTER`, so DockerMap should only see
the fixture-labeled Docker resources.

## Prerequisites

Run from the repository root:

```bash
cd /path/to/DockerMap
```

If you already have the repository open in a shell, stay in that repository
root and run the commands from there.

Confirm required tools are available:

```bash
node --version
npm --version
cargo --version
(docker version && docker compose version) || \
  (sudo -n docker version && sudo -n docker compose version)
curl --version
```

Install JavaScript dependencies if `node_modules` is missing or stale:

```bash
npm ci
```

The fixture script builds the Rust daemon itself with:

```bash
cargo build --manifest-path crates/Cargo.toml -p dockermap-daemon
```

If Docker requires sudo on the host, the script can use `sudo -n docker` only
when passwordless sudo is already configured.

## Start The Testbed

Use the default state file:

```bash
scripts/dockermap-fixture-up.sh --verify
```

Use a custom state file when running more than one fixture or when you want an
explicit path in your notes:

```bash
scripts/dockermap-fixture-up.sh --verify --state-file /tmp/dockermap-testbed.env
```

Expected successful ending:

```text
[dockermap-fixture] ready
  Web:     http://127.0.0.1:<web-port>
  API:     http://127.0.0.1:<api-port>
  Daemon:  http://127.0.0.1:<daemon-port>
  State:   /tmp/dockermap-fixture-current.env
  Logs:    /tmp/dockermap-fixture.<suffix>/logs
```

The `--verify` flag performs the first smoke check automatically. It confirms
that fixture containers, networks, volumes, runtime providers, Compose/runtime
mount correlations, and dry-run edit planning are visible through DockerMap.

## Load Fixture Variables

For the default state file:

```bash
STATE_FILE="${TMPDIR:-/tmp}/dockermap-fixture-current.env"
set -a
source "$STATE_FILE"
set +a
IFS=' ' read -r -a DOCKER_CMD <<< "${DOCKER_CMD_TEXT:-docker}"
```

For a custom state file:

```bash
STATE_FILE="/tmp/dockermap-testbed.env"
set -a
source "$STATE_FILE"
set +a
IFS=' ' read -r -a DOCKER_CMD <<< "${DOCKER_CMD_TEXT:-docker}"
```

Confirm the recorded URLs:

```bash
printf 'WEB_URL=%s\nAPI_URL=%s\nDAEMON_URL=%s\nSTATE=%s\nLOGS=%s\n' \
  "$WEB_URL" "$API_URL" "$DAEMON_URL" "$STATE_FILE" "$FIXTURE_DIR/logs"
```

The default state file is `${TMPDIR:-/tmp}/dockermap-fixture-current.env`.

## Docker Resource Checks

List the fixture containers:

```bash
"${DOCKER_CMD[@]}" ps --filter "label=$LABEL_EXPR" \
  --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
```

Expected:

- one container name containing `${PROJECT_NAME}-api-1`;
- one container name containing `${PROJECT_NAME}-worker-1`;
- one container name containing `${PROJECT_NAME}-caddy-proxy-1`;
- one container name containing `${PROJECT_NAME}-dnsmasq-dns-1`;
- one container name containing `${PROJECT_NAME}-tailscale-node-1`;
- one container name containing `${PROJECT_NAME}-headscale-control-1`.

Confirm the unlabeled control container exists outside the label filter:

```bash
"${DOCKER_CMD[@]}" ps --filter "name=$CONTROL_CONTAINER" \
  --format 'table {{.Names}}\t{{.Status}}'
```

List fixture networks and volumes:

```bash
"${DOCKER_CMD[@]}" network ls --filter "label=$LABEL_EXPR"
"${DOCKER_CMD[@]}" volume ls --filter "label=$LABEL_EXPR"
```

Expected networks:

- `${PROJECT_NAME}_front`
- `${PROJECT_NAME}_back`

Expected volumes:

- `${PROJECT_NAME}_fixture-cache`
- `${PROJECT_NAME}_fixture-logs`

## Health Checks

Check DockerMap daemon and API health:

```bash
curl -fsS "$DAEMON_URL/daemon/health"
curl -fsS "$API_URL/api/health"
```

Open the web UI:

```bash
open "$WEB_URL"
```

If `open` is unavailable, paste `$WEB_URL` into a browser.

## API Test Procedure

Save API responses for inspection:

```bash
mkdir -p /tmp/dockermap-testbed-results
curl -fsS "$API_URL/api/snapshot" \
  -o /tmp/dockermap-testbed-results/snapshot.json
curl -fsS "$API_URL/api/runtime/map" \
  -o /tmp/dockermap-testbed-results/runtime-map.json
curl -fsS "$API_URL/api/compose/scan?file=compose.yaml" \
  -o /tmp/dockermap-testbed-results/compose-scan.json
curl -fsS "$API_URL/api/compose/edit-plan?file=compose.yaml&service=api&mount=0&source=./api-data" \
  -o /tmp/dockermap-testbed-results/edit-plan.json
```

Validate the snapshot:

```bash
node - <<'NODE'
const fs = require("node:fs");
const snapshot = JSON.parse(fs.readFileSync("/tmp/dockermap-testbed-results/snapshot.json", "utf8"));
const names = snapshot.containers.map((container) => container.name);
const required = ["api", "worker", "caddy-proxy", "dnsmasq-dns", "tailscale-node", "headscale-control"];
for (const suffix of required) {
  if (!names.some((name) => name.includes(suffix))) {
    throw new Error(`missing fixture container containing ${suffix}`);
  }
}
if (names.includes(process.env.CONTROL_CONTAINER)) {
  throw new Error("unlabeled control container leaked into DockerMap snapshot");
}
console.log("snapshot container filter passed");
NODE
```

Validate runtime providers:

```bash
node - <<'NODE'
const fs = require("node:fs");
const runtime = JSON.parse(fs.readFileSync("/tmp/dockermap-testbed-results/runtime-map.json", "utf8"));
const providers = new Set(runtime.nodes.map((node) => node.provider));
const required = ["docker", "reverse_proxy", "local_dns", "tailscale", "headscale", "npm", "tmux", "systemd", "pm2", "scheduled_job"];
for (const provider of required) {
  if (!providers.has(provider)) {
    throw new Error(`missing runtime provider ${provider}`);
  }
}
console.log("runtime provider check passed");
NODE
```

Validate Compose scan and edit planning:

```bash
node - <<'NODE'
const fs = require("node:fs");
const scan = JSON.parse(fs.readFileSync("/tmp/dockermap-testbed-results/compose-scan.json", "utf8"));
const edit = JSON.parse(fs.readFileSync("/tmp/dockermap-testbed-results/edit-plan.json", "utf8"));
if (!Array.isArray(scan.correlations) || scan.correlations.length === 0) {
  throw new Error("compose scan did not include runtime correlations");
}
if (edit.willWrite !== false) {
  throw new Error("compose edit plan must remain dry-run only");
}
console.log("compose scan and dry-run edit checks passed");
NODE
```

## Web UI Test Procedure

Use the `Web` URL printed by the fixture script.

1. Dashboard
   - Confirm the page loads without a fatal error panel.
   - Confirm container, image, network, and volume summary cards are populated.
   - Confirm the service map preview includes fixture Docker resources.

2. Containers
   - Confirm the fixture `api`, `worker`, `caddy-proxy`, `dnsmasq-dns`,
     `tailscale-node`, and `headscale-control` containers are visible.
   - Confirm the unlabeled control container is not visible.
   - Open the fixture API container detail page if the UI links it.

3. Images
   - Confirm `busybox:1.36.1` is visible.
   - Confirm the image is associated with running fixture containers.

4. Networks
   - Confirm `${PROJECT_NAME}_front` and `${PROJECT_NAME}_back` are visible.
   - Confirm the API container is attached to both front and back.
   - Confirm the worker container is attached to back.

5. Volumes
   - Confirm `${PROJECT_NAME}_fixture-cache` and
     `${PROJECT_NAME}_fixture-logs` are visible.

6. Logs
   - Confirm logs load for the fixture containers.
   - Search or filter for `dockermap-fixture-worker` if log search is available.

7. Compose
   - Confirm `compose.yaml` appears as the scanned Compose file.
   - Confirm bind mounts for `./api-data` and `./worker-data` are visible.
   - Confirm named volumes `fixture-cache` and `fixture-logs` are visible.
   - Confirm any edit-plan UI remains a preview and does not apply changes.

8. Runtime map
   - Confirm Docker, reverse proxy marker, local DNS marker, Tailscale,
     Headscale, npm, tmux, systemd, PM2, and scheduled-job signals are present
     either in the UI or through `/api/runtime/map`.

## Automated Test Commands

Run the focused live-Docker Playwright test on a Docker-capable host:

```bash
npm run test:live-docker
```

Run GUI smoke tests against the normal mocked harness:

```bash
npm run test:e2e
```

Run API security tests after touching API, auth, CORS, daemon proxying, query
limits, or error redaction:

```bash
npm run test:api
```

Run daemon provider and redaction fixture tests after touching Rust collectors,
runtime-map providers, Docker label filters, or redaction:

```bash
npm run test:rust:daemon
```

Run the full local gate before merge:

```bash
npm run check
```

## Expected Pass Criteria

The testbed pass is acceptable when:

- the fixture starts with `--verify` and prints Web, API, Daemon, State, and Logs
  paths;
- only labeled fixture Docker resources appear in DockerMap responses;
- the unlabeled control container exists in Docker but not in `/api/snapshot`;
- `/api/health` and `/daemon/health` return success;
- `/api/snapshot` shows the fixture containers, networks, volumes, mounts, and
  images;
- `/api/runtime/map` includes fixture Docker and provider-stub nodes;
- `/api/compose/scan?file=compose.yaml` returns Compose/runtime correlations;
- `/api/compose/edit-plan?...` returns `willWrite: false`;
- the web UI renders Dashboard, Containers, Images, Networks, Volumes, Logs, and
  Compose views without fatal errors;
- `npm run test:live-docker` passes on a Docker-capable host when live evidence
  is required.

## Failure Capture

If a step fails, capture:

```bash
"${DOCKER_CMD[@]}" ps -a --filter "label=$LABEL_EXPR"
"${DOCKER_CMD[@]}" network ls --filter "label=$LABEL_EXPR"
"${DOCKER_CMD[@]}" volume ls --filter "label=$LABEL_EXPR"
tail -200 "$FIXTURE_DIR/logs/daemon.log"
tail -200 "$FIXTURE_DIR/logs/api.log"
tail -200 "$FIXTURE_DIR/logs/web.log"
```

Also save the API response that failed, the command used, and the exact error
message. Do not paste secrets or raw host-specific credentials into issue
comments.

## Teardown

Use the state file printed by setup.

Default state file:

```bash
scripts/dockermap-fixture-down.sh
```

Custom state file:

```bash
scripts/dockermap-fixture-down.sh --state-file /tmp/dockermap-testbed.env
```

Confirm no fixture-labeled resources remain:

```bash
"${DOCKER_CMD[@]}" ps -a --filter "label=$LABEL_EXPR"
"${DOCKER_CMD[@]}" network ls --filter "label=$LABEL_EXPR"
"${DOCKER_CMD[@]}" volume ls --filter "label=$LABEL_EXPR"
```

The teardown script removes DockerMap processes, the unlabeled control
container, the Compose project, fixture volumes, and the temporary fixture root.
It does not remove Docker base images pulled by Docker.
