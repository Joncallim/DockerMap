import { useEffect, useState } from "react";
import type { HealthResponse } from "@dockermap/contracts";
import { apiUrl } from "../utils/api";
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
      setHealth((current) =>
        current
          ? { ...current, status: "degraded", message: "Live stream interrupted" }
          : current,
      );
    });

    return () => {
      source.close();
    };
  }, [settings.demoMode, settings.refreshIntervalMs]);

  return { tick, health };
}
