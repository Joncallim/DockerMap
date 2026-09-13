import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function text(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

function hasDirective(unit, directive) {
  return unit.split(/\r?\n/).includes(directive);
}

function composeService(compose, service) {
  const lines = compose.split(/\r?\n/);
  const start = lines.indexOf(`  ${service}:`);
  assert.notEqual(start, -1, `missing Compose service ${service}`);
  const endOffset = lines.slice(start + 1).findIndex((line) => /^  [a-zA-Z0-9_-]+:$/.test(line));
  const end = endOffset === -1 ? lines.length : start + 1 + endOffset;
  return lines.slice(start, end).join("\n");
}

test("the Docker-only Compose collector is always PID-restricted", async () => {
  const compose = await text("docker-compose.yml");
  assert.match(
    compose,
    /collector:[\s\S]*?DOCKERMAP_PID_NAMESPACE:\s*restricted/,
    "the recommended container collector must not gain implicit full-host visibility"
  );
});

test("the recommended Docker-only profile fails closed instead of publishing mock topology", async () => {
  const compose = await text("docker-compose.yml");
  const declarations = [...compose.matchAll(/DOCKERMAP_ALLOW_MOCK:\s*"([^"]+)"/g)]
    .map((match) => match[1]);
  assert.deepEqual(
    declarations,
    ["false", "false"],
    "both the frontend and collector must reject unavailable live authority instead of falling back to mock data"
  );
});

test("split Docker services override the frontend image healthcheck at each plane", async () => {
  const compose = await text("docker-compose.yml");
  assert.match(
    compose,
    /collector:[\s\S]*?healthcheck:[\s\S]*?\/daemon\/health/,
    "the collector must check its authenticated daemon endpoint instead of the absent frontend"
  );
  assert.match(
    compose,
    /docker-read-gateway:[\s\S]*?healthcheck:[\s\S]*?--unix-socket \/run\/dockermap\/docker-read\.sock[\s\S]*?\/containers\/json\?all=true&size=false/,
    "the gateway must check its filtered Unix socket instead of the absent frontend"
  );
});

test("the shared deployment image has exactly one Compose build owner", async () => {
  const compose = await text("docker-compose.yml");
  const buildDeclarations = [...compose.matchAll(/^\s{4}build:\s*\.\s*$/gm)];
  const imageDeclarations = [...compose.matchAll(/^\s{4}image:\s*dockermap:local\s*$/gm)];

  assert.equal(
    buildDeclarations.length,
    1,
    "only the frontend service may build the shared image; parallel same-tag builds race on classic builders"
  );
  assert.equal(
    imageDeclarations.length,
    3,
    "the frontend, collector, and gateway must continue consuming the same locally built image"
  );
  assert.match(
    compose,
    /dockermap:\n\s{4}build:\s*\.\n\s{4}image:\s*dockermap:local/,
    "the frontend service must remain the shared image build owner"
  );
});

test("the frontend ingress bridge cannot expose the private collector planes", async () => {
  const compose = await text("docker-compose.yml");
  const frontend = composeService(compose, "dockermap");
  const collector = composeService(compose, "collector");
  const gateway = composeService(compose, "docker-read-gateway");

  assert.match(
    frontend,
    /^    networks: \[dockermap-api, dockermap-ingress\]$/m,
    "the frontend needs both private API reachability and a routable ingress bridge for published ports"
  );
  assert.match(frontend, /^    ports:$/m, "only the frontend may publish a host port");
  assert.match(
    collector,
    /^    networks: \[dockermap-api\]$/m,
    "the collector must remain solely on the internal API network"
  );
  assert.doesNotMatch(collector, /^    ports:$/m, "the collector daemon must not publish a host port");
  assert.doesNotMatch(collector, /dockermap-ingress/, "the collector must not join the ingress network");
  assert.match(gateway, /^    network_mode: "none"$/m, "the Docker gateway must remain networkless");
  assert.doesNotMatch(gateway, /^    ports:$/m, "the Docker gateway must not publish a host port");
  assert.doesNotMatch(gateway, /^    networks:/m, "the Docker gateway must not join any Compose network");

  assert.match(
    compose,
    /^  dockermap-api:\n    internal: true$/m,
    "daemon traffic must remain on an internal network"
  );
  assert.match(
    compose,
    /^  dockermap-ingress:\n    driver: bridge\n    internal: false$/m,
    "frontend ingress must use an explicitly non-internal bridge so Docker can publish its loopback port"
  );
  assert.equal(
    [...compose.matchAll(/^    ports:$/gm)].length,
    1,
    "no service other than the frontend may expose a host port"
  );
});

test("the native collector is an explicit full-host profile", async () => {
  const unit = await text("deploy/systemd/dockermap-daemon.service");
  assert.ok(
    hasDirective(
      unit,
      "ExecStart=/usr/bin/env DOCKERMAP_PID_NAMESPACE=host /opt/dockermap/crates/target/release/dockermap-daemon"
    ),
    "the native systemd collector must force host PID visibility after EnvironmentFile precedence"
  );
  assert.ok(
    hasDirective(unit, "ProtectSystem=strict"),
    "the native collector must keep the system filesystem protected"
  );
});

test("the native full-host exec boundary overrides the shared Docker-only env default", async () => {
  const environment = await text(".env.example");
  const unit = await text("deploy/systemd/dockermap-daemon.service");
  assert.match(
    environment,
    /^DOCKERMAP_PID_NAMESPACE=restricted$/m,
    "the shared environment-file example must remain safe for Docker-only deployment"
  );
  assert.match(
    unit,
    /^EnvironmentFile=\/etc\/dockermap\/dockermap\.env$/m,
    "the native unit must exercise the same EnvironmentFile precedence as deployment"
  );
  assert.match(
    unit,
    /^ExecStart=\/usr\/bin\/env DOCKERMAP_PID_NAMESPACE=host /m,
    "the final executable environment must override EnvironmentFile rather than silently remaining restricted"
  );
  assert.doesNotMatch(
    unit,
    /^Environment=DOCKERMAP_PID_NAMESPACE=host$/m,
    "a systemd Environment= value is insufficient because EnvironmentFile overrides it"
  );
});

test("the native collector has no writable deployment-tree exception", async () => {
  const unit = await text("deploy/systemd/dockermap-daemon.service");
  assert.ok(
    hasDirective(unit, "ReadOnlyPaths=/opt/dockermap"),
    "the deployment tree must remain explicitly read-only"
  );
  assert.equal(
    /^ReadWritePaths=\/opt\/dockermap$/m.test(unit),
    false,
    "the read-first collector must not reopen the full deployment tree for writes"
  );
  assert.equal(
    /^ReadWritePaths=/m.test(unit),
    false,
    "the collector must not have a writable-path exception without a documented runtime need"
  );
});

test("the gateway alone receives its necessary runtime write path", async () => {
  const gateway = await text("deploy/systemd/dockermap-docker-gateway.service");
  assert.ok(hasDirective(gateway, "RuntimeDirectory=dockermap"));
  assert.ok(hasDirective(gateway, "ReadWritePaths=/run/dockermap"));
  assert.equal(
    /^ReadWritePaths=\/opt\/dockermap$/m.test(gateway),
    false,
    "the gateway must not gain a writable deployment-tree exception"
  );
});

test("deployment documentation states the intentional profile and writable-path boundary", async () => {
  const deployment = await text("docs/deployment/DEPLOYMENT.md");
  assert.match(deployment, /dockermap-daemon\.service[\s\S]*?forces[\s\S]*?DOCKERMAP_PID_NAMESPACE=host/);
  assert.match(deployment, /Docker-only Compose[\s\S]*?profile[\s\S]*?DOCKERMAP_PID_NAMESPACE=restricted/);
  assert.match(deployment, /no `ReadWritePaths` exception/);
});
