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

test("the Docker-only Compose collector is always PID-restricted", async () => {
  const compose = await text("docker-compose.yml");
  assert.match(
    compose,
    /collector:[\s\S]*?DOCKERMAP_PID_NAMESPACE:\s*restricted/,
    "the recommended container collector must not gain implicit full-host visibility"
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
