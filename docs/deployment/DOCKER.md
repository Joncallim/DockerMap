# Docker-only private-alpha deployment

This is the canonical clean-host procedure for the `v0.1.0-alpha.2` candidate.
It installs the split Compose profile, proves its authentication and Docker
authority boundaries, survives a real guest reboot, and then proves removal and
reinstallation. Run it in a disposable supported Linux VM against one exact
40-character source commit. A moving branch is not release evidence.

DockerMap remains read-only toward the host it observes. The installation and
removal commands below do change DockerMap's own containers, image, private
network, socket volume, checkout, and credential file.

## What this profile runs

- `dockermap`: nginx, the web bundle, and Node API; published only on
  `127.0.0.1:3233` by default.
- `collector`: the Rust daemon; reachable only on the internal Compose network.
- `docker-read-gateway`: the only component with the raw Docker socket. It
  exposes a fixed read allowlist over a private Unix socket.

The collector gets the filtered socket and a read-only project mount. The
frontend gets neither. Host process providers are unavailable because the
collector uses `DOCKERMAP_PID_NAMESPACE=restricted`.

## Clean-host prerequisites

The supported alpha procedure requires:

- an Ubuntu Server 26.04 LTS `x86_64` guest;
- Docker Engine with the Docker Compose plugin;
- Git, curl, OpenSSL, Python 3, and `sudo`;
- outbound network access while cloning and building.

Record the actual versions in the certification evidence. Enable Docker before
installing so DockerMap's `unless-stopped` restart policy can operate after a
guest reboot:

```bash
uname -a
docker version
docker compose version
git --version
sudo systemctl enable --now docker
```

## 1. Check out one exact candidate

Set `DOCKERMAP_REF` to the candidate's full commit SHA, not a branch or an
abbreviated SHA:

```bash
export DOCKERMAP_REF='<40-hex-candidate-sha>'
test "${#DOCKERMAP_REF}" = 40
test -z "$(printf '%s' "$DOCKERMAP_REF" | tr -d '0-9a-f')"
sudo git clone https://github.com/Joncallim/DockerMap.git /opt/dockermap-alpha2
sudo git -C /opt/dockermap-alpha2 checkout --detach "$DOCKERMAP_REF"
test "$(sudo git -C /opt/dockermap-alpha2 rev-parse HEAD)" = "$DOCKERMAP_REF"
```

All remaining commands assume:

```bash
cd /opt/dockermap-alpha2
```

## 2. Create protected credentials outside the checkout

The browser and daemon tokens are separate random credentials. This command
writes them without printing them. The Docker socket group is recorded so the
non-root gateway can open the host socket.

```bash
sudo install -d -m 0700 /etc/dockermap
sudo sh -c 'umask 077; printf "DOCKERMAP_API_TOKEN=%s\nDOCKERMAP_DAEMON_TOKEN=%s\nDOCKER_GID=%s\nDOCKERMAP_BIND_ADDRESS=127.0.0.1\nDOCKERMAP_FRONTEND_PORT=3233\nDOCKERMAP_INTERNAL_SUBNET=10.254.251.0/24\n" "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" "$(stat -c %g /var/run/docker.sock)" > /etc/dockermap/dockermap.env'
sudo test "$(stat -c %a /etc/dockermap/dockermap.env)" = 600
```

If `10.254.251.0/24` overlaps the guest's existing networks, replace it in the
protected file with one unused private `/24` before starting. Do not copy
`.env.example` as-is: it contains placeholders and native-profile settings.

Use the same fixed project name and env file for every lifecycle command:

```bash
sudo docker compose --env-file /etc/dockermap/dockermap.env \
  -p dockermap-alpha2 config --quiet
```

## 3. Build and install

```bash
sudo docker compose --env-file /etc/dockermap/dockermap.env \
  -p dockermap-alpha2 up --build -d
sudo docker compose --env-file /etc/dockermap/dockermap.env \
  -p dockermap-alpha2 ps
for attempt in $(seq 1 60); do
  HEALTHY_SERVICES=0
  for service in dockermap collector docker-read-gateway; do
    CONTAINER_ID="$(sudo docker compose --env-file /etc/dockermap/dockermap.env -p dockermap-alpha2 ps -q "$service")"
    test "$(sudo docker inspect "$CONTAINER_ID" --format '{{.State.Health.Status}}')" = healthy && HEALTHY_SERVICES=$((HEALTHY_SERVICES + 1))
  done
  test "$HEALTHY_SERVICES" = 3 && break
  sleep 2
done
test "$HEALTHY_SERVICES" = 3
unset HEALTHY_SERVICES CONTAINER_ID
```

Wait for the frontend to answer, then load its token without printing it and
run the repository smoke test:

```bash
export DOCKERMAP_API_TOKEN="$(sudo sed -n 's/^DOCKERMAP_API_TOKEN=//p' /etc/dockermap/dockermap.env)"
export DOCKERMAP_SMOKE_URL='http://127.0.0.1:3233'
for attempt in $(seq 1 60); do
  test "$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $DOCKERMAP_API_TOKEN" http://127.0.0.1:3233/api/health || true)" = 200 && break
  sleep 2
done
test "$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $DOCKERMAP_API_TOKEN" http://127.0.0.1:3233/api/health || true)" = 200
./scripts/smoke-deploy.sh
```

The smoke test checks anonymous denial, authenticated health, snapshot,
runtime, Compose scan, bounded observed history, and one SSE snapshot. Add the
findings boundary and private-daemon checks:

```bash
test "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3233/api/findings)" = 401
test "$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $DOCKERMAP_API_TOKEN" \
  http://127.0.0.1:3233/api/findings)" = 200
test -z "$(sudo docker compose --env-file /etc/dockermap/dockermap.env \
  -p dockermap-alpha2 port collector 4100)"
```

Prove that health and status report live Docker bytes and that snapshot history
refers to the same current publication revision. The bounded retry avoids
mistaking a refresh that lands between the two requests for incoherence:

```bash
python3 - <<'PY'
import json, os, time, urllib.request

headers = {"Authorization": f"Bearer {os.environ['DOCKERMAP_API_TOKEN']}"}
def get(path):
    request = urllib.request.Request(f"http://127.0.0.1:3233{path}", headers=headers)
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)

health = get("/api/health")
status = get("/api/status")
assert health["daemon"]["mode"] == "docker" and health["dockerReachable"] is True
assert status["mode"] == "docker" and status["sourceCoherent"] is True
assert status["snapshotSource"] == "docker" and status["dockerReachable"] is True
for attempt in range(10):
    snapshot = get("/api/snapshot")
    history = get("/api/history")
    assert snapshot["source"] == "docker" and snapshot["modelRevision"]
    assert history["source"] == "docker" and history["baselineEstablished"] is True
    assert history["observedRevision"] and len(history["events"]) <= 64
    if history["currentModelRevision"] == snapshot["modelRevision"]:
        break
    time.sleep(0.25)
else:
    raise AssertionError("snapshot/history publication revisions did not converge")
PY
```

Prove mount authority from Docker's effective container configuration, not just
from the Compose source:

```bash
FRONTEND_ID="$(sudo docker compose --env-file /etc/dockermap/dockermap.env -p dockermap-alpha2 ps -q dockermap)"
COLLECTOR_ID="$(sudo docker compose --env-file /etc/dockermap/dockermap.env -p dockermap-alpha2 ps -q collector)"
GATEWAY_ID="$(sudo docker compose --env-file /etc/dockermap/dockermap.env -p dockermap-alpha2 ps -q docker-read-gateway)"
sudo docker inspect "$FRONTEND_ID" "$COLLECTOR_ID" "$GATEWAY_ID" | python3 -c '
import json, sys
items = json.load(sys.stdin)
mounts = {item["Name"]: item.get("Mounts", []) for item in items}
frontend = next(value for key, value in mounts.items() if "dockermap-1" in key)
collector = next(value for key, value in mounts.items() if "collector" in key)
gateway = next(value for key, value in mounts.items() if "docker-read-gateway" in key)
raw = "/var/run/docker.sock"
assert not frontend
assert all(m.get("Source") != raw and m.get("Destination") != raw for m in collector)
assert {(m["Destination"], m["RW"]) for m in collector} == {
    ("/opt/dockermap/project", False), ("/run/dockermap", True)}
assert sum(m.get("Source") == raw and m.get("Destination") == raw and not m["RW"] for m in gateway) == 1
assert sum(m.get("Source") == raw for group in mounts.values() for m in group) == 1
'
unset FRONTEND_ID COLLECTOR_ID GATEWAY_ID
```

Do not print, paste, or retain the token in evidence. Unset it when the checks
finish:

```bash
unset DOCKERMAP_API_TOKEN DOCKERMAP_SMOKE_URL
```

## 4. Prove component restart recovery

```bash
sudo docker compose --env-file /etc/dockermap/dockermap.env \
  -p dockermap-alpha2 restart
sudo docker compose --env-file /etc/dockermap/dockermap.env \
  -p dockermap-alpha2 ps
for attempt in $(seq 1 60); do
  HEALTHY_SERVICES=0
  for service in dockermap collector docker-read-gateway; do
    CONTAINER_ID="$(sudo docker compose --env-file /etc/dockermap/dockermap.env -p dockermap-alpha2 ps -q "$service")"
    test "$(sudo docker inspect "$CONTAINER_ID" --format '{{.State.Health.Status}}')" = healthy && HEALTHY_SERVICES=$((HEALTHY_SERVICES + 1))
  done
  test "$HEALTHY_SERVICES" = 3 && break
  sleep 2
done
test "$HEALTHY_SERVICES" = 3
unset HEALTHY_SERVICES CONTAINER_ID
export DOCKERMAP_API_TOKEN="$(sudo sed -n 's/^DOCKERMAP_API_TOKEN=//p' /etc/dockermap/dockermap.env)"
export DOCKERMAP_SMOKE_URL='http://127.0.0.1:3233'
for attempt in $(seq 1 60); do
  test "$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $DOCKERMAP_API_TOKEN" http://127.0.0.1:3233/api/health || true)" = 200 && break
  sleep 2
done
./scripts/smoke-deploy.sh
unset DOCKERMAP_API_TOKEN DOCKERMAP_SMOKE_URL
```

A restart is useful recovery evidence, but it is not guest-reboot evidence.

## 5. Prove an actual guest reboot

Record the guest boot identity on persistent storage, reboot the disposable
guest, and reconnect. Never run this step on the hypervisor.

```bash
cat /proc/sys/kernel/random/boot_id | sudo tee /var/tmp/dockermap-boot-id.before >/dev/null
sudo reboot
```

After reconnecting, prove the boot identity changed and repeat the protected
boundary checks:

```bash
if test "$(cat /proc/sys/kernel/random/boot_id)" = "$(sudo cat /var/tmp/dockermap-boot-id.before)"; then
  echo 'guest boot_id did not change' >&2
  exit 1
fi
cd /opt/dockermap-alpha2
sudo docker compose --env-file /etc/dockermap/dockermap.env \
  -p dockermap-alpha2 ps
for attempt in $(seq 1 60); do
  HEALTHY_SERVICES=0
  for service in dockermap collector docker-read-gateway; do
    CONTAINER_ID="$(sudo docker compose --env-file /etc/dockermap/dockermap.env -p dockermap-alpha2 ps -q "$service")"
    test "$(sudo docker inspect "$CONTAINER_ID" --format '{{.State.Health.Status}}')" = healthy && HEALTHY_SERVICES=$((HEALTHY_SERVICES + 1))
  done
  test "$HEALTHY_SERVICES" = 3 && break
  sleep 2
done
test "$HEALTHY_SERVICES" = 3
unset HEALTHY_SERVICES CONTAINER_ID
export DOCKERMAP_API_TOKEN="$(sudo sed -n 's/^DOCKERMAP_API_TOKEN=//p' /etc/dockermap/dockermap.env)"
export DOCKERMAP_SMOKE_URL='http://127.0.0.1:3233'
for attempt in $(seq 1 60); do
  test "$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $DOCKERMAP_API_TOKEN" http://127.0.0.1:3233/api/health || true)" = 200 && break
  sleep 2
done
./scripts/smoke-deploy.sh
test "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3233/api/findings)" = 401
test "$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $DOCKERMAP_API_TOKEN" \
  http://127.0.0.1:3233/api/findings)" = 200
test -z "$(sudo docker compose --env-file /etc/dockermap/dockermap.env \
  -p dockermap-alpha2 port collector 4100)"
python3 - <<'PY'
import json, os, time, urllib.request
headers = {"Authorization": f"Bearer {os.environ['DOCKERMAP_API_TOKEN']}"}
def get(path):
    request = urllib.request.Request(f"http://127.0.0.1:3233{path}", headers=headers)
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)
health, status = get("/api/health"), get("/api/status")
assert health["daemon"]["mode"] == "docker" and health["dockerReachable"] is True
assert status["mode"] == "docker" and status["sourceCoherent"] is True
assert status["snapshotSource"] == "docker" and status["dockerReachable"] is True
for attempt in range(10):
    snapshot, history = get("/api/snapshot"), get("/api/history")
    assert snapshot["source"] == "docker" and snapshot["modelRevision"]
    assert history["source"] == "docker" and history["baselineEstablished"] is True
    assert history["observedRevision"] and len(history["events"]) <= 64
    if history["currentModelRevision"] == snapshot["modelRevision"]:
        break
    time.sleep(0.25)
else:
    raise AssertionError("snapshot/history publication revisions did not converge")
PY
FRONTEND_ID="$(sudo docker compose --env-file /etc/dockermap/dockermap.env -p dockermap-alpha2 ps -q dockermap)"
COLLECTOR_ID="$(sudo docker compose --env-file /etc/dockermap/dockermap.env -p dockermap-alpha2 ps -q collector)"
GATEWAY_ID="$(sudo docker compose --env-file /etc/dockermap/dockermap.env -p dockermap-alpha2 ps -q docker-read-gateway)"
sudo docker inspect "$FRONTEND_ID" "$COLLECTOR_ID" "$GATEWAY_ID" | python3 -c '
import json, sys
items = json.load(sys.stdin)
mounts = {item["Name"]: item.get("Mounts", []) for item in items}
frontend = next(value for key, value in mounts.items() if "dockermap-1" in key)
collector = next(value for key, value in mounts.items() if "collector" in key)
gateway = next(value for key, value in mounts.items() if "docker-read-gateway" in key)
raw = "/var/run/docker.sock"
assert not frontend
assert all(m.get("Source") != raw and m.get("Destination") != raw for m in collector)
assert {(m["Destination"], m["RW"]) for m in collector} == {
    ("/opt/dockermap/project", False), ("/run/dockermap", True)}
assert sum(m.get("Source") == raw and m.get("Destination") == raw and not m["RW"] for m in gateway) == 1
assert sum(m.get("Source") == raw for group in mounts.values() for m in group) == 1
'
unset FRONTEND_ID COLLECTOR_ID GATEWAY_ID
unset DOCKERMAP_API_TOKEN DOCKERMAP_SMOKE_URL
```

Snapshot history is daemon-lifetime memory. A clean collector restart or guest
reboot correctly establishes a new baseline; it does not restore pre-restart
history.

## 6. Prove rollback with a failing upgrade image

Preserve the accepted image's immutable local ID, then deliberately replace the
moving `dockermap:local` tag with a deterministic empty image. This is an
acceptance-harness fault, not DockerMap source, and proves the rollback is not a
no-op against an untouched image:

```bash
export DOCKERMAP_ACCEPTED_IMAGE="$(sudo docker image inspect dockermap:local --format '{{.Id}}')"
sudo docker image tag "$DOCKERMAP_ACCEPTED_IMAGE" dockermap:rollback-alpha2
sudo docker compose --env-file /etc/dockermap/dockermap.env \
  -p dockermap-alpha2 down --remove-orphans
printf '%s\n' 'FROM dockermap:rollback-alpha2' \
  'RUN rm -f /frontend-entrypoint.sh /usr/local/bin/dockermap-daemon /usr/local/bin/dockermap-docker-gateway' \
  | sudo docker build -t dockermap:local -
test "$(sudo docker image inspect dockermap:local --format '{{.Id}}')" != "$DOCKERMAP_ACCEPTED_IMAGE"
if sudo docker compose --env-file /etc/dockermap/dockermap.env \
  -p dockermap-alpha2 up -d --no-build; then
  echo 'failing upgrade image unexpectedly started' >&2
  exit 1
fi
```

Remove the failed project objects, restore the preserved image without
rebuilding source, and prove both image identity and acceptance recover:

```bash
sudo docker compose --env-file /etc/dockermap/dockermap.env \
  -p dockermap-alpha2 down --remove-orphans
sudo docker image tag dockermap:rollback-alpha2 dockermap:local
test "$(sudo docker image inspect dockermap:local --format '{{.Id}}')" = "$DOCKERMAP_ACCEPTED_IMAGE"
sudo docker compose --env-file /etc/dockermap/dockermap.env \
  -p dockermap-alpha2 up -d --no-build
export DOCKERMAP_API_TOKEN="$(sudo sed -n 's/^DOCKERMAP_API_TOKEN=//p' /etc/dockermap/dockermap.env)"
export DOCKERMAP_SMOKE_URL='http://127.0.0.1:3233'
for attempt in $(seq 1 60); do
  test "$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $DOCKERMAP_API_TOKEN" http://127.0.0.1:3233/api/health || true)" = 200 && break
  sleep 2
done
./scripts/smoke-deploy.sh
test "$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $DOCKERMAP_API_TOKEN" \
  http://127.0.0.1:3233/api/findings)" = 200
test -z "$(sudo docker compose --env-file /etc/dockermap/dockermap.env \
  -p dockermap-alpha2 port collector 4100)"
unset DOCKERMAP_API_TOKEN DOCKERMAP_SMOKE_URL DOCKERMAP_ACCEPTED_IMAGE
```

This rolls back DockerMap's image; DockerMap has no application database or
persisted history to migrate.

## 7. Uninstall and prove clean state

This removes only the explicitly named DockerMap Compose project, including its
private network and socket volume. It does not remove unrelated Docker objects.

```bash
cd /opt/dockermap-alpha2
sudo docker compose --env-file /etc/dockermap/dockermap.env \
  -p dockermap-alpha2 down --volumes --remove-orphans
test -z "$(sudo docker ps -aq --filter label=com.docker.compose.project=dockermap-alpha2)"
test -z "$(sudo docker network ls -q --filter label=com.docker.compose.project=dockermap-alpha2)"
test -z "$(sudo docker volume ls -q --filter label=com.docker.compose.project=dockermap-alpha2)"
test "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3233/api/health || true)" = 000
```

After the clean-state evidence is captured, remove only DockerMap's known local
images and exact installation paths:

```bash
sudo docker image rm dockermap:local dockermap:rollback-alpha2 2>/dev/null || true
test "$(realpath /opt/dockermap-alpha2)" = /opt/dockermap-alpha2
sudo rm -rf -- /opt/dockermap-alpha2
sudo rm -f -- /etc/dockermap/dockermap.env /var/tmp/dockermap-boot-id.before
sudo rmdir /etc/dockermap
```

Those last commands delete the checkout and credentials and are not reversible.
Resolve and verify the exact paths before running them.

## 8. Reinstall proof

Repeat sections 1–3 from a new clone of the same exact SHA and newly generated
tokens. Rerun the smoke, findings, and private-daemon checks. Record that the
checkout, credentials, Compose project, image, network, and volume were newly
created; do not reuse the objects retained for rollback.

## Plain Docker compatibility

The root image can run all components in one container for local compatibility
testing:

```bash
docker build -t dockermap:local .
docker run --rm --env-file /etc/dockermap/dockermap.env \
  -p 127.0.0.1:3233:3233 \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v "$PWD":/opt/dockermap/project:ro \
  dockermap:local
```

This profile gives one container the raw Docker socket and is not the supported
alpha deployment or release-certification path.

## Configuration contract

`.env.example` describes the complete Node, daemon, and web configuration
surface. Boolean switches enable only on the literal value `true`. Keep secrets
out of `VITE_*` variables, logs, screenshots, shell tracing, and committed proxy
configuration. The alpha procedure intentionally sets only these Compose
inputs:

| Variable | Purpose |
| --- | --- |
| `DOCKERMAP_API_TOKEN` | Required browser API bearer credential. |
| `DOCKERMAP_DAEMON_TOKEN` | Separate frontend-to-collector bearer credential. |
| `DOCKER_GID` | Numeric group owning `/var/run/docker.sock`. |
| `DOCKERMAP_BIND_ADDRESS` | Keep `127.0.0.1` for the supported alpha. |
| `DOCKERMAP_FRONTEND_PORT` | Host frontend port, default `3233`. |
| `DOCKERMAP_INTERNAL_SUBNET` | Unused private `/24` for the internal API network. |

See [the security threat model](../security/THREAT_MODEL.md) and
[Docker authority boundary](../architecture/DOCKER_AUTHORITY_BOUNDARY.md) for
the exact read and trust boundaries.
