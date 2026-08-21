import { useCallback, useEffect, useRef, useState } from "react";
import type { LogEntry, LogsResponse } from "@dockermap/contracts";
import { useApp } from "../context";
import { fetchJson } from "../utils/api";
import { formatRelative } from "../lib/format";
import { identityText, UNAVAILABLE_CONTAINER } from "../lib/identity";
import { EmptyState, ErrorState, Loading, Panel } from "../components/primitives";

type LevelFilter = "all" | "info" | "warn" | "error";

const PAGE_SIZE = 100;

export default function Logs() {
  const { model } = useApp();
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

  // Cancels any in-flight log request when the screen unmounts or a newer
  // request supersedes it, so a slow response can never clobber newer state.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  // Tracks whether "Load older" has reached the end of the daemon's history
  // window (nextCursor === null). Once exhausted, a live poll's shallow
  // first-page cursor must not resurrect the "Load older" button (see
  // refreshLive); the flag resets when a fresh selection loads.
  const exhaustedRef = useRef(false);

  const fetchLogs = useCallback((requestPath: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    return fetchJson<LogsResponse>(requestPath, { signal: controller.signal });
  }, []);

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchLogs(path);
      setEntries(data.entries);
      setNextCursor(data.nextCursor);
      // A fresh selection (first load or service/path change) starts from an
      // un-exhausted cursor state: any prior "reached the end of history"
      // flag belonged to the old path/service and must not suppress cursor
      // adoption for the new one.
      exhaustedRef.current = false;
      setError(null);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") {
        return;
      }
      setError(cause instanceof Error ? cause.message : "Log stream request failed");
    } finally {
      setLoading(false);
    }
  }, [path, fetchLogs]);

  // The first page loads on mount and when the path/service changes ONLY —
  // the daemon heartbeat tick must not wipe accumulated older pages every
  // ~2s (live updates go through the merge-refresh below instead).
  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const refreshLive = useCallback(async () => {
    try {
      const data = await fetchLogs(path);
      setEntries((current) => {
        if (current.length === 0) {
          // Nothing on screen yet (e.g. a first load that raced the stream):
          // adopt the fresh page wholesale.
          return data.entries;
        }
        const newest = current[0].timestamp;
        // Prepend entries at or after the newest loaded entry; everything
        // already on screen (including pages loaded via "Load older") is
        // preserved. `>=` (not `>`) matters because Docker timestamps are
        // ms-truncated: a newly-arrived line sharing the top entry's
        // millisecond would be filtered out by a strict comparison and,
        // being newer than the cursor, never surface via Load older either —
        // permanently lost from the live tail. The id-dedupe below skips the
        // already-present top entry (and any other known line), so `>=`
        // cannot duplicate; it relies on ids being unique per PHYSICAL line
        // (round-8 F1), otherwise identical same-ms lines would collapse.
        const fresh = data.entries.filter(
          (entry) => entry.timestamp >= newest && !current.some((known) => known.id === entry.id)
        );
        if (fresh.length === 0) {
          return current;
        }
        // fresh is newest-first from the API; prepending keeps newer lines
        // above, while already-loaded older pages stay below untouched.
        return [...fresh, ...current];
      });
      // Adopt the poll's cursor ONLY when none exists yet (e.g. the first
      // page loaded before the stream had enough history for one) AND the
      // history window has not been paged to its end. A non-null cursor —
      // in particular one "Load older" has advanced deeper — is never
      // overwritten by a live poll's shallow first-page cursor, which would
      // make the next click re-fetch an already-displayed page. Once the
      // window IS exhausted (nextCursor null from "Load older"), a poll's
      // first-page cursor must likewise not resurrect the button: clicking
      // it would re-fetch already-displayed entries (deduped away) and
      // drain cursor round-trips before paging back to null.
      setNextCursor((current) =>
        current === null && !exhaustedRef.current ? data.nextCursor : current
      );
      setError(null);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") {
        return;
      }
      setError(cause instanceof Error ? cause.message : "Live log refresh failed");
    }
  }, [path, fetchLogs]);

  // One live tail loop: every 3s fetch the newest page and merge new lines
  // above the already-loaded stream instead of replacing it.
  useEffect(() => {
    if (!live) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      void refreshLive();
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [live, refreshLive]);

  const loadOlder = useCallback(async () => {
    if (!nextCursor || loadingOlder) {
      return;
    }
    setLoadingOlder(true);
    try {
      const separator = path.includes("?") ? "&" : "?";
      const data = await fetchLogs(
        `${path}${separator}cursor=${encodeURIComponent(nextCursor)}&limit=${PAGE_SIZE}`
      );
      setEntries((current) => {
        const known = new Set(current.map((entry) => entry.id));
        const older = data.entries.filter((entry) => !known.has(entry.id));
        return [...current, ...older];
      });
      setNextCursor(data.nextCursor);
      // A null cursor means the daemon's history window is fully consumed:
      // remember that so a live poll's shallow first-page cursor cannot
      // resurrect the "Load older" button (see refreshLive).
      exhaustedRef.current = data.nextCursor === null;
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") {
        return;
      }
      setError(cause instanceof Error ? cause.message : "Older log request failed");
    } finally {
      setLoadingOlder(false);
    }
  }, [nextCursor, loadingOlder, path, fetchLogs]);

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
          {model?.services.filter((service) => model.byId.has(service.id) && model.byName.has(service.name)).map((service, index) => (
            <option key={`${service.id}-${index}`} value={service.name}>
              {service.name}
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
              {visible.map((entry, index) => (
                <li key={`${entry.id}-${index}`} className={`log-line lvl-${entry.level}`}>
                  <span className="log-time">{formatRelative(entry.timestamp)}</span>
                  <span className="log-svc">{identityText(entry.container, UNAVAILABLE_CONTAINER)}</span>
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
