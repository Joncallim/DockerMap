import { useEffect, useState } from "react";
import type { HealthResponse } from "@dockermap/contracts";
import { apiUrl } from "../utils/api";

export function useDaemonHeartbeat() {
  const [tick, setTick] = useState(0);
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
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
  }, []);

  return { tick, health };
}
