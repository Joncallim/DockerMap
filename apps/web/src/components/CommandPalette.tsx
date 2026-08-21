import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { SystemModel } from "../lib/model";
import Icon, { type IconName, KIND_ICON } from "./Icon";
import { identityText, UNAVAILABLE_SERVICE, UNAVAILABLE_SERVICE_ROLE } from "../lib/identity";

type CloseReason = "cancel" | "navigate";

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
  onClose: (reason?: CloseReason) => void;
  model: SystemModel | null;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLLIElement | null)[]>([]);
  const triggerRef = useRef<HTMLElement | null>(null);
  const closeReason = useRef<CloseReason>("cancel");

  useEffect(() => {
    if (open) {
      triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      closeReason.current = "cancel";
      setQuery("");
      setActive(0);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    } else if (triggerRef.current) {
      if (closeReason.current === "cancel") triggerRef.current.focus();
      triggerRef.current = null;
      closeReason.current = "cancel";
    }
  }, [open]);

  const close = (reason: CloseReason = "cancel") => {
    closeReason.current = reason;
    onClose(reason);
  };
  const go = (path: string) => {
    closeReason.current = "navigate";
    navigate(path);
    onClose("navigate");
  };

  const commands = useMemo<Command[]>(() => {
    const nav: Command[] = [
      { id: "nav-home", label: "Home — Command Center", icon: "home", group: "Navigate", run: () => go("/") },
      { id: "nav-map", label: "Service Map", icon: "map", group: "Navigate", run: () => go("/map") },
      { id: "nav-runtime", label: "Runtime Map", icon: "layers", group: "Navigate", run: () => go("/runtime") },
      { id: "nav-changes", label: "Change Center", icon: "history", group: "Navigate", run: () => go("/changes") },
      { id: "nav-copilot", label: "Copilot", icon: "spark", group: "Navigate", run: () => go("/copilot") },
      { id: "nav-net", label: "Networking", icon: "network", group: "Navigate", run: () => go("/networking") },
      { id: "nav-storage", label: "Storage", icon: "storage", group: "Navigate", run: () => go("/storage") },
      { id: "nav-images", label: "Images", icon: "image", group: "Navigate", run: () => go("/images") },
      { id: "nav-logs", label: "Logs", icon: "logs", group: "Navigate", run: () => go("/logs") },
      { id: "nav-compose", label: "Compose", icon: "compose", group: "Navigate", run: () => go("/compose") }
    ];
    const services: Command[] = (model?.services ?? [])
      .filter((service) => model?.byId.has(service.id) && model.byName.has(service.name))
      .map((service) => ({
        id: `svc-${service.id}`,
        label: `Go to ${identityText(service.name, UNAVAILABLE_SERVICE)}`,
        hint: identityText(service.role, UNAVAILABLE_SERVICE_ROLE),
        icon: KIND_ICON[service.kind],
        group: "Services",
        keywords: `${service.name} ${service.role} ${service.imageRepo}`,
        run: () => go(`/services/${encodeURIComponent(service.name)}`)
      }));
    return [...nav, ...services];
  }, [model]);

  const trimmed = query.trim();
  const filtered = useMemo(() => {
    if (!trimmed) return commands;
    const q = trimmed.toLowerCase();
    return commands.filter((command) => (command.label + " " + (command.keywords ?? "")).toLowerCase().includes(q));
  }, [commands, trimmed]);
  const askCopilot: Command | null = trimmed
    ? { id: "ask", label: `Ask Copilot: "${trimmed}"`, icon: "spark", group: "Copilot", run: () => go(`/copilot?q=${encodeURIComponent(trimmed)}`) }
    : null;
  const items = askCopilot ? [askCopilot, ...filtered] : filtered;
  const clampedActive = Math.min(Math.max(0, active), Math.max(0, items.length - 1));

  useEffect(() => {
    itemRefs.current[clampedActive]?.scrollIntoView({ block: "nearest" });
  }, [clampedActive]);

  if (!open) return null;

  const trapFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusables = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("input, [tabindex]:not([tabindex=\"-1\"])") ?? [])
      .filter((element) => !element.hasAttribute("disabled"));
    if (focusables.length === 0) return;
    event.preventDefault();
    (event.shiftKey ? focusables[focusables.length - 1] : focusables[0]).focus();
  };

  return (
    <div className="cmdk-backdrop" onMouseDown={() => close()} role="presentation">
      <div
        className="cmdk"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        ref={dialogRef}
        onKeyDown={trapFocus}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="cmdk-input">
          <Icon name="search" size={17} />
          <input
            ref={inputRef}
            value={query}
            placeholder="Search services, navigate, or ask Copilot…"
            aria-activedescendant={items.length > 0 ? `cmdk-option-${clampedActive}` : undefined}
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-listbox"
            aria-autocomplete="list"
            aria-label="Search commands"
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && items.length > 0) {
                event.preventDefault();
                setActive((current) => Math.min(items.length - 1, current + 1));
              } else if (event.key === "ArrowUp" && items.length > 0) {
                event.preventDefault();
                setActive((current) => Math.max(0, current - 1));
              } else if (event.key === "Home" && items.length > 0) {
                event.preventDefault();
                setActive(0);
              } else if (event.key === "End" && items.length > 0) {
                event.preventDefault();
                setActive(items.length - 1);
              } else if (event.key === "Enter") {
                event.preventDefault();
                items[clampedActive]?.run();
              }
            }}
          />
          <kbd>esc</kbd>
        </div>
        <ul id="cmdk-listbox" className="cmdk-list" role="listbox" aria-label="Commands">
          {items.length === 0 && <li className="cmdk-empty" role="status">No matches</li>}
          {items.map((command, index) => (
            <li
              key={command.id}
              id={`cmdk-option-${index}`}
              role="option"
              aria-selected={index === clampedActive}
              className={`cmdk-item${index === clampedActive ? " is-active" : ""}`}
              ref={(element) => { itemRefs.current[index] = element; }}
              onMouseMove={() => setActive(index)}
              onClick={command.run}
            >
              <Icon name={command.icon} size={15} />
              <span className="cmdk-item-label">{command.label}</span>
              {command.hint && <span className="cmdk-item-hint">{command.hint}</span>}
              <span className="cmdk-item-group">{command.group}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
