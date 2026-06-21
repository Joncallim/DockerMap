import { useMemo } from "react";
import type { ContainerRecord, LogsResponse } from "@dockermap/contracts";
import { useApiResource } from "../hooks/useApiResource";
import { useSearchParamState } from "../hooks/useSearchParamState";
import { formatTime } from "../utils/format";
import Icon from "../components/Icon";
import { Chip, PageHead, StateView } from "../components/ui";

const LEVELS = ["info", "warn", "error"] as const;

export default function LogsPage(props: { heartbeat: number }) {
  const { searchParams, update } = useSearchParamState();
  const service = searchParams.get("service") ?? "";
  const q = searchParams.get("q") ?? "";
  const level = searchParams.get("level") ?? "";

  const path = `/api/logs${service || q ? `?${new URLSearchParams({ ...(service ? { service } : {}), ...(q ? { q } : {}) }).toString()}` : ""}`;
  const logs = useApiResource<LogsResponse>(path, props.heartbeat);
  const containers = useApiResource<{ containers: ContainerRecord[] }>("/api/containers", props.heartbeat);

  const entries = useMemo(
    () => (logs.data?.entries ?? []).filter((e) => !level || e.level === level),
    [logs.data, level],
  );

  if (logs.loading || containers.loading) {
    return <StateView kind="loading" title="Loading logs" body="Hydrating log stream and service filters." icon="logs" />;
  }
  if (logs.error || containers.error || !logs.data || !containers.data) {
    return <StateView kind="error" title="Logs unavailable" body={logs.error ?? containers.error ?? "Unknown failure"} />;
  }

  return (
    <section className="stack">
      <PageHead
        eyebrow="Output stream"
        title="Logs"
        subtitle="Tail recent output and focus a single service."
        actions={
          <select
            className="select"
            value={service}
            onChange={(event) => update({ service: event.target.value || null })}
            aria-label="Filter by service"
          >
            <option value="">All services</option>
            {containers.data.containers.map((c) => (
              <option key={c.id} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        }
      />

      <div className="chip-row">
        <Chip active={level === ""} onClick={() => update({ level: null })}>
          All levels
        </Chip>
        {LEVELS.map((l) => (
          <Chip key={l} active={level === l} onClick={() => update({ level: l })}>
            {l}
          </Chip>
        ))}
      </div>

      <section className="section terminal">
        <header className="terminal-bar">
          <span className="terminal-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="terminal-title">
            <Icon name="logs" size={14} />
            {service || "all services"} · {entries.length} lines
          </span>
        </header>
        {entries.length === 0 ? (
          <StateView kind="empty" title="No logs found" body="Try another service, level, or clear the current search." icon="search" />
        ) : (
          <div className="logstream">
            {entries.map((e) => (
              <div className={`logline log-${e.level}`} key={e.id}>
                <time>{formatTime(e.timestamp)}</time>
                <span className="log-svc">{e.container}</span>
                <span className="log-level">{e.level}</span>
                <span className="log-msg">{e.message}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}
