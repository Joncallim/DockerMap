import type { ReactNode } from "react";
import type { ServiceState } from "../lib/model";
import Icon, { type IconName } from "./Icon";

export const STATE_LABEL: Record<ServiceState, string> = {
  healthy: "Healthy",
  warning: "Warning",
  degraded: "Degraded",
  offline: "Offline",
  updating: "Updating",
  unknown: "Unknown"
};

/** Color is never decorative — it always maps to a state. */
export function StateDot({ state, pulse }: { state: ServiceState; pulse?: boolean }) {
  return <span className={`state-dot s-${state}${pulse ? " is-pulse" : ""}`} aria-hidden="true" />;
}

export function StatePill({ state, label }: { state: ServiceState; label?: string }) {
  return (
    <span className={`state-pill s-${state}`}>
      <StateDot state={state} pulse={state === "healthy"} />
      {label ?? STATE_LABEL[state]}
    </span>
  );
}

export function Tag({ children, icon, tone }: { children: ReactNode; icon?: IconName; tone?: "accent" | "warn" | "muted" }) {
  return (
    <span className={`tag${tone ? ` tag-${tone}` : ""}`}>
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}

export function Panel({
  title,
  icon,
  hint,
  actions,
  children,
  className = ""
}: {
  title?: ReactNode;
  icon?: IconName;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {(title || actions) && (
        <header className="panel-head">
          <div className="panel-head-text">
            {title && (
              <h2 className="panel-title">
                {icon && <Icon name={icon} size={15} />}
                {title}
              </h2>
            )}
            {hint && <span className="panel-hint">{hint}</span>}
          </div>
          {actions && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function KeyValue({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="kv">
      <span className="kv-label">{label}</span>
      <span className={`kv-value${mono ? " mono" : ""}`}>{value}</span>
    </div>
  );
}

export function Metric({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <strong className="metric-value">{value}</strong>
      {sub && <span className="metric-sub">{sub}</span>}
    </div>
  );
}

export function Sparkline({ data, state = "healthy" }: { data: number[]; state?: ServiceState }) {
  const w = 88;
  const h = 24;
  if (data.length === 0) return <svg className={`spark s-${state}`} width={w} height={h} aria-hidden="true" />;
  const step = w / Math.max(1, data.length - 1);
  const points = data.map((v, i) => `${(i * step).toFixed(1)},${(h - v * (h - 2) - 1).toFixed(1)}`).join(" ");
  return (
    <svg className={`spark s-${state}`} width={w} height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} fill="none" />
    </svg>
  );
}

export function Bar({ value, state = "healthy" }: { value: number; state?: ServiceState }) {
  return (
    <span className="bar" role="img" aria-label={`${Math.round(value)} percent`}>
      <span className={`bar-fill s-${state}`} style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
    </span>
  );
}

export function EmptyState({ icon, title, body, action }: { icon: IconName; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size={22} />
      </span>
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <div className="loading" role="status">
      <span className="loading-spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty empty-error">
      <span className="empty-icon">
        <Icon name="alert" size={22} />
      </span>
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}
