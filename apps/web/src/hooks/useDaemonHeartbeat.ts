import { useEffect, useState } from "react";
import type { HealthResponse } from "@dockermap/contracts";
import { apiUrl } from "../utils/api";
import { fetchJson, notifyBearerUnauthorized, ApiResponseError } from "../utils/api";
import { getDemoHealth } from "../lib/demoData";
import { useSettings } from "./useSettings";

export function useDaemonHeartbeat() {
  const { settings } = useSettings();
  const [tick, setTick] = useState(0);
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    if (settings.demoMode) {
      setHealth(getDemoHealth());
      setTick((value) => value + 1);
      const timer = window.setInterval(() => {
        setHealth(getDemoHealth());
        setTick((value) => value + 1);
      }, settings.refreshIntervalMs);
      return () => window.clearInterval(timer);
    }

    const source = new EventSource(apiUrl("/api/events/stream"));

    source.addEventListener("snapshot", (event) => {
      const message = JSON.parse((event as MessageEvent).data) as HealthResponse;
      setHealth(message);
      setTick((value) => value + 1);
    });

    source.addEventListener("error", () => {
      void fetchJson("/api/auth/whoami").catch((error) => {
        if (error instanceof ApiResponseError && error.status === 401 && error.code === "unauthorized") {
          notifyBearerUnauthorized();
        }
      });
      setHealth((current) =>
        current
          ? {
              ...current,
              status: "degraded",
              message: "Live stream interrupted",
              // Conservative: drop dockerReachable so the connection dot turns
              // offline with the interruption message instead of staying green.
              dockerReachable: false
            }
          : current,
      );
    });

    return () => {
      source.close();
    };
  }, [settings.demoMode, settings.refreshIntervalMs]);

  return { tick, health };
}
