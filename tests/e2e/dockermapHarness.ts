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
  } catch (error) {
    cleanupLiveDocker(docker, fixture);
    throw error;
  }

  const ports = await allocatePorts();
  const processes: ProcessHandle[] = [];

  await ensureDaemonBinary();
  processes.push(startDaemon({ port: ports.daemon, cwd: fixture.dir, useDockerAccess: true, docker }));
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
}): ProcessHandle {
  const env = {
    ...process.env,
    DOCKERMAP_DAEMON_HOST: "127.0.0.1",
    DOCKERMAP_DAEMON_PORT: String(options.port),
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
  mkdirSync(join(dir, "api-data"), { recursive: true });
  mkdirSync(join(dir, "worker-data"), { recursive: true });
  writeFileSync(join(dir, "api-data", "fixture.txt"), "dockermap live api data\n");
  writeFileSync(join(dir, "worker-data", "fixture.txt"), "dockermap live worker data\n");

  const composeFile = join(dir, "compose.yaml");
  const projectName = `dockermap-e2e-${Date.now().toString(36)}`;
  writeFileSync(composeFile, liveComposeYaml());
  return { dir, composeFile, projectName };
}

function liveComposeYaml() {
  return `services:
  api:
    image: busybox:1.36.1
    command: sh -c "mkdir -p /www && echo dockermap-live-api > /www/index.html && httpd -f -p 8080"
    ports:
      - "8080"
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
    volumes:
      - type: bind
        source: ./worker-data
        target: /worker-data
      - type: volume
        source: live-logs
        target: /logs
    networks:
      - back

networks:
  front:
  back:
    internal: true

volumes:
  live-cache:
  live-logs:
`;
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
