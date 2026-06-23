import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { SystemModel } from "../lib/model";
import Icon, { type IconName, KIND_ICON } from "./Icon";

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: IconName;
  group: string;
  run: () => void;
  keywords?: string;
}

export default function CommandPalette({
  open,
  onClose,
  model
}: {
  open: boolean;
  onClose: () => void;
  model: SystemModel | null;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      window.setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  const go = (path: string) => {
    navigate(path);
    onClose();
  };

  const commands = useMemo<Command[]>(() => {
    const nav: Command[] = [
      { id: "nav-home", label: "Home — Command Center", icon: "home", group: "Navigate", run: () => go("/") },
      { id: "nav-map", label: "Service Map", icon: "map", group: "Navigate", run: () => go("/map") },
      { id: "nav-changes", label: "Change Center", icon: "history", group: "Navigate", run: () => go("/changes") },
      { id: "nav-copilot", label: "Copilot", icon: "spark", group: "Navigate", run: () => go("/copilot") },
      { id: "nav-net", label: "Networking", icon: "network", group: "Navigate", run: () => go("/networking") },
      { id: "nav-storage", label: "Storage", icon: "storage", group: "Navigate", run: () => go("/storage") },
      { id: "nav-images", label: "Images", icon: "image", group: "Navigate", run: () => go("/images") },
      { id: "nav-logs", label: "Logs", icon: "logs", group: "Navigate", run: () => go("/logs") },
      { id: "nav-compose", label: "Compose", icon: "compose", group: "Navigate", run: () => go("/compose") }
    ];
    const services: Command[] = (model?.services ?? []).map((s) => ({
      id: `svc-${s.id}`,
      label: `Go to ${s.name}`,
      hint: s.role,
      icon: KIND_ICON[s.kind],
      group: "Services",
      keywords: `${s.name} ${s.role} ${s.imageRepo}`,
      run: () => go(`/services/${encodeURIComponent(s.name)}`)
    }));
    return [...nav, ...services];
  }, [model]);

  const trimmed = query.trim();
  const filtered = useMemo(() => {
    if (!trimmed) return commands;
    const q = trimmed.toLowerCase();
    return commands.filter((c) => (c.label + " " + (c.keywords ?? "")).toLowerCase().includes(q));
  }, [commands, trimmed]);

  const askCopilot: Command | null = trimmed
    ? {
        id: "ask",
        label: `Ask Copilot: "${trimmed}"`,
        icon: "spark",
        group: "Copilot",
        run: () => go(`/copilot?q=${encodeURIComponent(trimmed)}`)
      }
    : null;

  const items = askCopilot ? [askCopilot, ...filtered] : filtered;
  const clampedActive = Math.min(active, Math.max(0, items.length - 1));

  if (!open) return null;

  return (
    <div className="cmdk-backdrop" onClick={onClose} role="presentation">
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command palette" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk-input">
          <Icon name="search" size={17} />
          <input
            ref={inputRef}
            value={query}
            placeholder="Search services, navigate, or ask Copilot…"
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(items.length - 1, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                items[clampedActive]?.run();
              } else if (e.key === "Escape") {
                onClose();
              }
            }}
          />
          <kbd>esc</kbd>
        </div>
        <ul className="cmdk-list">
          {items.length === 0 && <li className="cmdk-empty">No matches</li>}
          {items.map((c, i) => (
            <li key={c.id}>
              <button
                type="button"
                className={`cmdk-item${i === clampedActive ? " is-active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={c.run}
              >
                <Icon name={c.icon} size={15} />
                <span className="cmdk-item-label">{c.label}</span>
                {c.hint && <span className="cmdk-item-hint">{c.hint}</span>}
                <span className="cmdk-item-group">{c.group}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
