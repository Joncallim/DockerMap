import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import net from "node:net";

export type Stack = {
  apiUrl: string;
  webUrl: string;
  daemonUrl: string;
  fixtureDir: string;
  projectName: string | null;
  controlContainerName: string | null;
  stop: () => Promise<void>;
};

type ProcessHandle = {
  name: string;
  process: ChildProcessWithoutNullStreams;
  logs: string[];
};

type Fixture = {
  dir: string;
  composeFile: string;
  projectName: string;
  labelFilter: string;
  stubBinDir: string;
  controlContainerName: string;
};

const repoRoot = resolve(__dirname, "../..");
const daemonBinary = join(repoRoot, "crates/target/debug/dockermap-daemon");

export async function startMockStack(): Promise<Stack> {
  const fixtureDir = mkdtempSync(join(tmpdir(), "dockermap-mock-e2e-"));
  const ports = await allocatePorts();
  const processes: ProcessHandle[] = [];

  await ensureDaemonBinary();
  processes.push(startDaemon({ port: ports.daemon, cwd: fixtureDir, useDockerAccess: false }));
  await waitForJson(`http://127.0.0.1:${ports.daemon}/daemon/health`);

  processes.push(startApi({ port: ports.api, daemonPort: ports.daemon, webPort: ports.web }));
  await waitForJson(`http://127.0.0.1:${ports.api}/api/health`);

  processes.push(startWeb({ port: ports.web, apiPort: ports.api }));
  await waitForHttp(`http://127.0.0.1:${ports.web}`);

  return {
    apiUrl: `http://127.0.0.1:${ports.api}`,
    webUrl: `http://127.0.0.1:${ports.web}`,
    daemonUrl: `http://127.0.0.1:${ports.daemon}`,
    fixtureDir,
    projectName: null,
    controlContainerName: null,
    stop: async () => {
      await stopProcesses(processes);
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  };
}

export async function startLiveDockerStack(): Promise<Stack> {
  const docker = detectDockerCommand();
  if (!docker) {
    throw new SkipLiveDockerError("Docker is not reachable by the current user or sudo -n docker.");
  }

  const fixture = createLiveDockerFixture();
  try {
    runDocker(docker, ["compose", "-p", fixture.projectName, "-f", fixture.composeFile, "up", "-d"], fixture.dir);
    runDocker(docker, ["run", "-d", "--name", fixture.controlContainerName, "busybox:1.36.1", "sh", "-c", "while true; do sleep 60; done"], fixture.dir);
  } catch (error) {
    cleanupLiveDocker(docker, fixture);
    throw error;
  }

  const ports = await allocatePorts();
  const processes: ProcessHandle[] = [];

  await ensureDaemonBinary();
  processes.push(startDaemon({
    port: ports.daemon,
    cwd: fixture.dir,
    useDockerAccess: true,
    docker,
    dockerLabelFilter: fixture.labelFilter,
    pathPrefix: fixture.stubBinDir
  }));
  await waitForDockerHealth(`http://127.0.0.1:${ports.daemon}/daemon/health`);
  await waitForFixtureSnapshot(`http://127.0.0.1:${ports.daemon}/daemon/snapshot`, fixture.projectName);

  processes.push(startApi({ port: ports.api, daemonPort: ports.daemon, webPort: ports.web }));
  await waitForJson(`http://127.0.0.1:${ports.api}/api/health`);

  processes.push(startWeb({ port: ports.web, apiPort: ports.api }));
  await waitForHttp(`http://127.0.0.1:${ports.web}`);

  return {
    apiUrl: `http://127.0.0.1:${ports.api}`,
    webUrl: `http://127.0.0.1:${ports.web}`,
    daemonUrl: `http://127.0.0.1:${ports.daemon}`,
    fixtureDir: fixture.dir,
    projectName: fixture.projectName,
    controlContainerName: fixture.controlContainerName,
    stop: async () => {
      await stopProcesses(processes);
      cleanupLiveDocker(docker, fixture);
    }
  };
}

export class SkipLiveDockerError extends Error {}

async function allocatePorts() {
  const [daemon, api, web] = await Promise.all([freePort(), freePort(), freePort()]);
  return { daemon, api, web };
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a TCP port.")));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

async function ensureDaemonBinary() {
  const result = spawnSync("cargo", ["build", "--manifest-path", "crates/Cargo.toml", "-p", "dockermap-daemon"], {
    cwd: repoRoot,
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error(`Failed to build dockermap-daemon:\n${result.stdout}\n${result.stderr}`);
  }
}

function startDaemon(options: {
  port: number;
  cwd: string;
  useDockerAccess: boolean;
  docker?: string[];
  dockerLabelFilter?: string;
  pathPrefix?: string;
}): ProcessHandle {
  const env = {
    ...process.env,
    DOCKERMAP_DAEMON_HOST: "127.0.0.1",
    DOCKERMAP_DAEMON_PORT: String(options.port),
    ...(options.dockerLabelFilter ? { DOCKERMAP_DOCKER_LABEL_FILTER: options.dockerLabelFilter } : {}),
    ...(options.pathPrefix ? { PATH: `${options.pathPrefix}:${process.env.PATH}` } : {}),
    ...(options.useDockerAccess ? {} : { DOCKERMAP_FORCE_MOCK: "true" })
  };

  if (options.useDockerAccess && options.docker?.[0] === "sudo") {
    return startProcess("daemon", "sudo", ["-n", "env", ...envPairs(env), daemonBinary], {
      cwd: options.cwd,
      env: process.env
    });
  }

  return startProcess("daemon", daemonBinary, [], { cwd: options.cwd, env });
}

function startApi(options: { port: number; daemonPort: number; webPort: number }) {
  return startProcess("api", join(repoRoot, "node_modules/.bin/tsx"), ["apps/api/src/index.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(options.port),
      DOCKERMAP_DAEMON_URL: `http://127.0.0.1:${options.daemonPort}`,
      DOCKERMAP_ALLOWED_ORIGINS: `http://127.0.0.1:${options.webPort}`
    }
  });
}

function startWeb(options: { port: number; apiPort: number }) {
  return startProcess(
    "web",
    "npm",
    ["--workspace", "@dockermap/web", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(options.port), "--strictPort"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        VITE_API_BASE_URL: `http://127.0.0.1:${options.apiPort}`
      }
    },
  );
}

function startProcess(
  name: string,
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): ProcessHandle {
  const child = spawn(command, args, {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const logs: string[] = [];
  const capture = (chunk: Buffer) => {
    logs.push(chunk.toString());
    if (logs.length > 120) {
      logs.shift();
    }
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.once("exit", (code, signal) => {
    if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGINT") {
      logs.push(`${name} exited with ${code ?? signal}`);
    }
  });
  return { name, process: child, logs };
}

async function stopProcesses(processes: ProcessHandle[]) {
  await Promise.all(processes.toReversed().map(stopProcess));
}

async function stopProcess(handle: ProcessHandle) {
  if (handle.process.exitCode !== null) {
    return;
  }

  signalProcess(handle, "SIGTERM");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (handle.process.exitCode !== null) {
      return;
    }
    await delay(100);
  }
  signalProcess(handle, "SIGKILL");
}

function signalProcess(handle: ProcessHandle, signal: NodeJS.Signals) {
  try {
    if (process.platform !== "win32" && handle.process.pid) {
      process.kill(-handle.process.pid, signal);
      return;
    }
  } catch {
    // Fall back to signaling the direct child below.
  }
  handle.process.kill(signal);
}

async function waitForDockerHealth(url: string) {
  await waitForCondition(async () => {
    const health = await fetchJson<{ mode: string; dockerReachable: boolean }>(url);
    return health.mode === "docker" && health.dockerReachable;
  }, `Docker health at ${url}`);
}

async function waitForFixtureSnapshot(url: string, projectName: string) {
  await waitForCondition(async () => {
    const snapshot = await fetchJson<{ containers: Array<{ name: string }> }>(url);
    return snapshot.containers.some((container) => container.name.includes(projectName));
  }, `fixture containers in ${url}`);
}

async function waitForJson(url: string) {
  await waitForCondition(async () => {
    await fetchJson(url);
    return true;
  }, url);
}

async function waitForHttp(url: string) {
  await waitForCondition(async () => {
    const response = await fetch(url);
    return response.ok;
  }, url);
}

async function waitForCondition(check: () => Promise<boolean>, label: string) {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < 45_000) {
    try {
      if (await check()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }

  throw new Error(`Timed out waiting for ${label}${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return (await response.json()) as T;
}

function detectDockerCommand(): string[] | null {
  const explicit = process.env.DOCKERMAP_E2E_DOCKER_COMMAND;
  if (explicit) {
    return explicit.split(" ").filter(Boolean);
  }

  if (commandSucceeds("docker", ["version", "--format", "{{.Server.Version}}"])) {
    return ["docker"];
  }
  if (commandSucceeds("sudo", ["-n", "docker", "version", "--format", "{{.Server.Version}}"])) {
    return ["sudo", "-n", "docker"];
  }
  return null;
}

function commandSucceeds(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0;
}

function createLiveDockerFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "dockermap-live-e2e-"));
  const projectName = `dockermap-e2e-${Date.now().toString(36)}`;
  const labelFilter = `com.dockermap.fixture=${projectName}`;
  const controlContainerName = `${projectName}-unlabeled-control`;
  const stubBinDir = join(dir, "bin");
  mkdirSync(join(dir, "api-data"), { recursive: true });
  mkdirSync(join(dir, "worker-data"), { recursive: true });
  mkdirSync(join(dir, "services", "node-agent"), { recursive: true });
  mkdirSync(stubBinDir, { recursive: true });
  writeFileSync(join(dir, "api-data", "fixture.txt"), "dockermap live api data\n");
  writeFileSync(join(dir, "worker-data", "fixture.txt"), "dockermap live worker data\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "dockermap-live-fixture-root",
    private: true,
    packageManager: "npm@10.0.0",
    scripts: { start: "node services/node-agent/index.js" },
    dependencies: { openai: "^4.0.0", express: "^4.18.0" },
    devDependencies: { tsx: "^4.0.0" }
  }, null, 2));
  writeFileSync(join(dir, "package-lock.json"), "{\"lockfileVersion\":3,\"packages\":{}}\n");
  writeFileSync(join(dir, "services", "node-agent", "package.json"), JSON.stringify({
    name: "dockermap-live-fixture-agent",
    private: true,
    scripts: { start: "node agent.js" },
    dependencies: { "@modelcontextprotocol/sdk": "^1.0.0", langchain: "^0.3.0" }
  }, null, 2));
  writeProviderStubs(stubBinDir, projectName);

  const composeFile = join(dir, "compose.yaml");
  writeFileSync(composeFile, liveComposeYaml(projectName));
  return { dir, composeFile, projectName, labelFilter, stubBinDir, controlContainerName };
}

function liveComposeYaml(projectName: string) {
  return `services:
  api:
    image: busybox:1.36.1
    command: sh -c "mkdir -p /www && echo dockermap-live-api > /www/index.html && httpd -f -p 8080"
    ports:
      - "8080"
    labels:
      com.dockermap.fixture: "${projectName}"
    volumes:
      - type: bind
        source: ./api-data
        target: /data
        read_only: true
      - type: volume
        source: live-cache
        target: /cache
    networks:
      - front
      - back

  worker:
    image: busybox:1.36.1
    command: sh -c "while true; do echo dockermap-live-worker; sleep 2; done"
    depends_on:
      - api
    labels:
      com.dockermap.fixture: "${projectName}"
    volumes:
      - type: bind
        source: ./worker-data
        target: /worker-data
      - type: volume
        source: live-logs
        target: /logs
    networks:
      - back

  caddy-proxy:
    image: busybox:1.36.1
    command: sh -c "while true; do sleep 60; done"
    depends_on:
      - api
    labels:
      com.dockermap.fixture: "${projectName}"
    networks:
      - front

  dnsmasq-dns:
    image: busybox:1.36.1
    command: sh -c "while true; do sleep 60; done"
    labels:
      com.dockermap.fixture: "${projectName}"
    networks:
      - front

  tailscale-node:
    image: busybox:1.36.1
    command: sh -c "while true; do sleep 60; done"
    labels:
      com.dockermap.fixture: "${projectName}"
    networks:
      - front

  headscale-control:
    image: busybox:1.36.1
    command: sh -c "while true; do sleep 60; done"
    labels:
      com.dockermap.fixture: "${projectName}"
    networks:
      - back

networks:
  front:
    labels:
      com.dockermap.fixture: "${projectName}"
  back:
    internal: true
    labels:
      com.dockermap.fixture: "${projectName}"

volumes:
  live-cache:
    labels:
      com.dockermap.fixture: "${projectName}"
  live-logs:
    labels:
      com.dockermap.fixture: "${projectName}"
`;
}

function writeProviderStubs(stubBinDir: string, projectName: string) {
  writeFileSync(join(stubBinDir, "tailscale"), `#!/bin/sh
if [ "$1 $2" = "status --json" ]; then
  cat <<'EOF'
{
  "Self": {
    "DNSName": "dockermap-live.tailnet.test.",
    "HostName": "dockermap-live",
    "Online": true,
    "TailscaleIPs": ["100.64.0.30"]
  },
  "Peer": {
    "peer-1": {
      "DNSName": "dockermap-live-peer.tailnet.test.",
      "HostName": "dockermap-live-peer",
      "Online": true,
      "TailscaleIPs": ["100.64.0.31"]
    }
  }
}
EOF
  exit 0
fi
exit 1
`);
  writeFileSync(join(stubBinDir, "headscale"), `#!/bin/sh
if [ "$1 $2 $3 $4" = "nodes list --output json" ]; then
  cat <<'EOF'
[
  {
    "id": "live-node-1",
    "givenName": "dockermap-live-headscale-node",
    "online": true,
    "ipAddresses": ["100.65.0.30"],
    "user": "fixture"
  }
]
EOF
  exit 0
fi
exit 1
`);
  writeFileSync(join(stubBinDir, "systemctl"), `#!/bin/sh
case "$1" in
  list-units)
    cat <<'EOF'
dockermap-live-api.service loaded active running DockerMap live fixture API service
dockermap-live-worker.service loaded active running DockerMap live fixture worker service
EOF
    exit 0
    ;;
  show)
    cat <<'EOF'
Id=dockermap-live-api.service
ActiveState=active
SubState=running
Description=DockerMap live fixture API service
ExecStart={ path=/usr/bin/node ; argv[]=node server.js ; }
Requires=dockermap-live-worker.service
Wants=
PartOf=

Id=dockermap-live-worker.service
ActiveState=active
SubState=running
Description=DockerMap live fixture worker service
ExecStart={ path=/usr/bin/python ; argv[]=python worker.py ; }
Requires=
Wants=
PartOf=
EOF
    exit 0
    ;;
esac
exit 1
`);
  writeFileSync(join(stubBinDir, "pm2"), `#!/bin/sh
if [ "$1" = "jlist" ]; then
  cat <<'EOF'
[
  {
    "pm_id": 43,
    "name": "dockermap-live-pm2",
    "pm2_env": {
      "name": "dockermap-live-pm2",
      "status": "online",
      "pm_cwd": "/tmp/dockermap-live",
      "pm_exec_path": "/tmp/dockermap-live/app.js",
      "restart_time": 0
    }
  }
]
EOF
  exit 0
fi
exit 1
`);
  writeFileSync(join(stubBinDir, "tmux"), `#!/bin/sh
if [ "$1" = "list-sessions" ]; then
  printf '%s\\t%s\\t%s\\t%s\\n' "live-session-${projectName}" "dockermap-live-agent" "0" "1"
  exit 0
fi
exit 1
`);
  writeFileSync(join(stubBinDir, "crontab"), `#!/bin/sh
if [ "$1" = "-l" ]; then
  echo "*/5 * * * * /usr/local/bin/dockermap-live-job --read-only"
  exit 0
fi
exit 1
`);
  for (const command of ["tailscale", "headscale", "systemctl", "pm2", "tmux", "crontab"]) {
    spawnSync("chmod", ["+x", join(stubBinDir, command)]);
  }
}

function runDocker(docker: string[], args: string[], cwd: string) {
  const result = spawnSync(docker[0], [...docker.slice(1), ...args], {
    cwd,
    encoding: "utf8",
    timeout: 120_000
  });
  if (result.status !== 0) {
    throw new Error(`Docker command failed: ${docker.join(" ")} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
}

function cleanupLiveDocker(docker: string[], fixture: Fixture) {
  try {
    runDocker(docker, ["rm", "-f", fixture.controlContainerName], fixture.dir);
  } catch {
    // Best-effort cleanup should not hide the original test result.
  }
  try {
    runDocker(
      docker,
      ["compose", "-p", fixture.projectName, "-f", fixture.composeFile, "down", "--volumes", "--remove-orphans"],
      fixture.dir,
    );
  } catch {
    // Best-effort cleanup should not hide the original test result.
  }
  rmSync(fixture.dir, { recursive: true, force: true });
}

function envPairs(env: NodeJS.ProcessEnv) {
  return Object.entries(env).flatMap(([key, value]) => (value === undefined ? [] : [`${key}=${value}`]));
}
