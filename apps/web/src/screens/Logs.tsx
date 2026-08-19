import { useCallback, useEffect, useState } from "react";
import type { LogEntry, LogsResponse } from "@dockermap/contracts";
import { useApp } from "../context";
import { fetchJson } from "../utils/api";
import { formatRelative } from "../lib/format";
import { EmptyState, ErrorState, Loading, Panel } from "../components/primitives";

type LevelFilter = "all" | "info" | "warn" | "error";

const PAGE_SIZE = 100;

export default function Logs() {
  const { model, tick } = useApp();
  const [service, setService] = useState("");
  const [level, setLevel] = useState<LevelFilter>("all");
  const [search, setSearch] = useState("");
  const [live, setLive] = useState(false);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const path = service ? `/api/logs?service=${encodeURIComponent(service)}` : "/api/logs";

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchJson<LogsResponse>(path);
      setEntries(data.entries);
      setNextCursor(data.nextCursor);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Log stream request failed");
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage, tick]);

  useEffect(() => {
    if (!live) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      void loadFirstPage();
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [live, loadFirstPage]);

  const loadOlder = useCallback(async () => {
    if (!nextCursor || loadingOlder) {
      return;
    }
    setLoadingOlder(true);
    try {
      const separator = path.includes("?") ? "&" : "?";
      const data = await fetchJson<LogsResponse>(
        `${path}${separator}cursor=${encodeURIComponent(nextCursor)}&limit=${PAGE_SIZE}`
      );
      setEntries((current) => [...current, ...data.entries]);
      setNextCursor(data.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Older log request failed");
    } finally {
      setLoadingOlder(false);
    }
  }, [nextCursor, loadingOlder, path]);

  const needle = search.trim().toLowerCase();
  const visible = entries.filter(
    (entry) =>
      (level === "all" || entry.level === level) &&
      (needle === "" || entry.message.toLowerCase().includes(needle))
  );

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <div className="eyebrow">Output stream</div>
          <h1 className="screen-title">Logs</h1>
        </div>
        <select
          className="service-select"
          value={service}
          onChange={(e) => setService(e.target.value)}
          aria-label="Filter by service"
        >
          <option value="">All services</option>
          {model?.services.map((s) => (
            <option key={s.id} value={s.name}>
              {s.name}
            </option>
          ))}
        </select>
      </header>

      <div className="log-controls">
        <select
          className="log-level-select"
          value={level}
          onChange={(e) => setLevel(e.target.value as LevelFilter)}
          aria-label="Filter by level"
        >
          <option value="all">All levels</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
        <input
          className="log-search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search messages…"
          aria-label="Search log messages"
        />
        <label className="log-live">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
          <span>Live tail</span>
        </label>
        <span className="muted-line">{visible.length} shown</span>
      </div>

      <Panel title="Recent output" icon="logs" hint={service || "all services"}>
        {loading && entries.length === 0 ? (
          <Loading label="Hydrating log stream…" />
        ) : error && entries.length === 0 ? (
          <ErrorState title="Logs unavailable" body={error} />
        ) : visible.length === 0 ? (
          <EmptyState icon="logs" title="No logs" body="No output matches the current selection." />
        ) : (
          <>
            <ul className="log-stream">
              {visible.map((entry) => (
                <li key={entry.id} className={`log-line lvl-${entry.level}`}>
                  <span className="log-time">{formatRelative(entry.timestamp)}</span>
                  <span className="log-svc">{entry.container}</span>
                  <span className="log-lvl">{entry.level}</span>
                  <span className="log-msg">{entry.message}</span>
                </li>
              ))}
            </ul>
            {nextCursor && (
              <div className="log-footer">
                <button
                  type="button"
                  className="ghost-link"
                  onClick={() => void loadOlder()}
                  disabled={loadingOlder}
                >
                  {loadingOlder ? "Loading…" : "Load older"}
                </button>
              </div>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
