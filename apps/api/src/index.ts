import cors from "cors";
import express from "express";
import type {
  ApiError,
  ContainerRecord,
  DockerSnapshot,
  GraphResponse,
  HealthResponse,
  ImageRecord,
  LogsResponse,
  NetworkRecord,
  VolumeRecord
} from "@dockermap/contracts";
import {
  containers as mockContainers,
  graph as mockGraph,
  images as mockImages,
  networks as mockNetworks,
  snapshot as mockSnapshot,
  volumes as mockVolumes
} from "./mockData.js";

const app = express();
const port = Number(process.env.PORT ?? 4000);
const daemonBaseUrl = process.env.DOCKERMAP_DAEMON_URL ?? "http://127.0.0.1:4100";
const allowMockFallback = process.env.DOCKERMAP_ALLOW_MOCK === "true";
const pollIntervalMs = Number(process.env.DOCKERMAP_SSE_INTERVAL_MS ?? 2000);

app.use(cors());
app.use(express.json());

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(body.message);
  }
}

async function fetchDaemon<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);

  try {
    const response = await fetch(`${daemonBaseUrl}${path}`, {
      ...init,
      signal: controller.signal
    });

    if (!response.ok) {
      const details = await response.text();
      throw new HttpError(response.status, {
        code: `daemon_${response.status}`,
        message: `Daemon request failed for ${path}`,
        details
      });
    }

    return (await response.json()) as T;
  } catch (error) {
    if (allowMockFallback) {
      return getMockResponse<T>(path);
    }

    if (error instanceof HttpError) {
      throw error;
    }

    throw new HttpError(502, {
      code: "daemon_unavailable",
      message: `Unable to reach DockerMap daemon at ${daemonBaseUrl}`,
      details: error instanceof Error ? error.message : String(error)
    });
  } finally {
    clearTimeout(timeout);
  }
}

function getMockResponse<T>(path: string): T {
  const health: HealthResponse = {
    status: "degraded",
    mode: "mock",
    dockerReachable: false,
    lastUpdated: mockSnapshot.lastUpdated ?? Date.now(),
    snapshotVersion: String(mockSnapshot.lastUpdated ?? Date.now()),
    message: "Node mock fallback active"
  };

  if (path === "/daemon/health") {
    return health as T;
  }

  if (path === "/daemon/snapshot") {
    return mockSnapshot as T;
  }

  if (path === "/daemon/graph") {
    return mockGraph as T;
  }

  if (path === "/daemon/containers") {
    return { containers: mockContainers } as T;
  }

  if (path.startsWith("/daemon/containers/")) {
    const name = decodeURIComponent(path.split("/").at(-1) ?? "");
    const container = mockContainers.find((item) => item.name === name);
    if (!container) {
      throw new HttpError(404, {
        code: "container_not_found",
        message: `Container ${name} not found`
      });
    }
    return container as T;
  }

  if (path === "/daemon/images") {
    return { images: mockImages } as T;
  }

  if (path === "/daemon/networks") {
    return { networks: mockNetworks } as T;
  }

  if (path === "/daemon/volumes") {
    return { volumes: mockVolumes } as T;
  }

  if (path.startsWith("/daemon/logs")) {
    return {
      service: null,
      entries: mockContainers.flatMap((container, index) => [
        {
          id: `${container.id}-log-${index}`,
          timestamp: Date.now() - index * 30_000,
          container: container.name,
          level: "info",
          message: `${container.name} running on ${container.image}`
        }
      ]),
      nextCursor: null
    } as T;
  }

  throw new HttpError(500, {
    code: "unknown_mock_path",
    message: `No mock response for ${path}`
  });
}

function sendError(res: express.Response, error: unknown) {
  if (error instanceof HttpError) {
    res.status(error.status).json(error.body);
    return;
  }

  res.status(500).json({
    code: "internal_error",
    message: error instanceof Error ? error.message : "Unexpected API failure"
  } satisfies ApiError);
}

function buildLogsPath(query: express.Request["query"]) {
  const params = new URLSearchParams();
  const service = typeof query.service === "string" ? query.service : "";
  const q = typeof query.q === "string" ? query.q : "";

  if (service) {
    params.set("service", service);
  }

  if (q) {
    params.set("q", q);
  }

  const suffix = params.toString();
  return suffix ? `/daemon/logs?${suffix}` : "/daemon/logs";
}

app.get("/health", async (_req, res) => {
  try {
    const health = await fetchDaemon<HealthResponse>("/daemon/health");
    res.json({ status: "ok", daemon: health });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/health", async (_req, res) => {
  try {
    const health = await fetchDaemon<HealthResponse>("/daemon/health");
    res.json({
      node: { status: "ok", port },
      daemon: health,
      dockerReachable: health.dockerReachable
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/snapshot", async (_req, res) => {
  try {
    res.json(await fetchDaemon<DockerSnapshot>("/daemon/snapshot"));
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/graph", async (_req, res) => {
  try {
    res.json(await fetchDaemon<GraphResponse>("/daemon/graph"));
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/containers", async (_req, res) => {
  try {
    res.json(await fetchDaemon<{ containers: ContainerRecord[] }>("/daemon/containers"));
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/containers/:name", async (req, res) => {
  try {
    res.json(
      await fetchDaemon<ContainerRecord>(`/daemon/containers/${encodeURIComponent(req.params.name)}`),
    );
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/images", async (_req, res) => {
  try {
    res.json(await fetchDaemon<{ images: ImageRecord[] }>("/daemon/images"));
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/networks", async (_req, res) => {
  try {
    res.json(await fetchDaemon<{ networks: NetworkRecord[] }>("/daemon/networks"));
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/volumes", async (_req, res) => {
  try {
    res.json(await fetchDaemon<{ volumes: VolumeRecord[] }>("/daemon/volumes"));
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/logs", async (req, res) => {
  try {
    res.json(await fetchDaemon<LogsResponse>(buildLogsPath(req.query)));
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/events/stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const emit = async () => {
    try {
      const health = await fetchDaemon<HealthResponse>("/daemon/health");
      res.write(`event: snapshot\n`);
      res.write(`data: ${JSON.stringify(health)}\n\n`);
    } catch (error) {
      const payload =
        error instanceof HttpError
          ? error.body
          : {
              code: "stream_error",
              message: error instanceof Error ? error.message : "Unknown stream error"
            };
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  };

  const timer = setInterval(emit, pollIntervalMs);
  void emit();

  req.on("close", () => {
    clearInterval(timer);
    res.end();
  });
});

app.listen(port, () => {
  console.log(`@dockermap/api listening on http://127.0.0.1:${port}`);
});
