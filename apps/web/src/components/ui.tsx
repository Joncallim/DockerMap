import type { ReactNode } from "react";
import Icon, { type IconName } from "./Icon";

/* ----------------------------------------------------------------------------
 * Shared primitives. Single source of truth for surfaces so we never nest a
 * card inside a card (impeccable rule) — sections own the boundary, rows live
 * inside flat.
 * ------------------------------------------------------------------------- */

export type Tone = "ok" | "warn" | "err" | "info" | "aqua" | "gold" | "neutral";

const STATUS_TONE: Record<string, Tone> = {
  running: "ok",
  ok: "ok",
  healthy: "ok",
  up: "ok",
  paused: "warn",
  restarting: "warn",
  degraded: "warn",
  created: "info",
  exited: "err",
  dead: "err",
  error: "err",
  down: "err",
};

export function toneForStatus(status: string | null | undefined): Tone {
  if (!status) return "neutral";
  return STATUS_TONE[status.toLowerCase()] ?? "info";
}

export function StatusDot({ status, pulse }: { status: string | null | undefined; pulse?: boolean }) {
  const tone = toneForStatus(status);
  return <span className={`dot dot-${tone}${pulse ? " dot-pulse" : ""}`} aria-hidden="true" />;
}

export function Badge({
  children,
  tone = "neutral",
  icon,
}: {
  children: ReactNode;
  tone?: Tone;
  icon?: IconName;
}) {
  return (
    <span className={`badge badge-${tone}`}>
      {icon && <Icon name={icon} size={13} />}
      {children}
    </span>
  );
}

export function Chip({ children, href, onClick, active }: { children: ReactNode; href?: string; onClick?: () => void; active?: boolean }) {
  const className = `chip${active ? " chip-active" : ""}`;
  if (onClick) {
    return (
      <button type="button" className={className} onClick={onClick}>
        {children}
      </button>
    );
  }
  return <span className={className}>{children}</span>;
}

export interface KpiSegment {
  color: string;
  value: number;
  label: string;
}

export function Kpi({
  icon,
  label,
  value,
  sub,
  accent = "aqua",
  segments,
}: {
  icon: IconName;
  label: string;
  value: ReactNode;
  sub?: string;
  accent?: Tone;
  segments?: KpiSegment[];
}) {
  const total = segments?.reduce((a, s) => a + s.value, 0) ?? 0;
  return (
    <article className={`kpi kpi-${accent}`}>
      <div className="kpi-top">
        <span className="kpi-icon">
          <Icon name={icon} size={18} />
        </span>
        <span className="kpi-label">{label}</span>
      </div>
      <strong className="kpi-value">{value}</strong>
      {segments && total > 0 ? (
        <div className="kpi-meter" role="img" aria-label={segments.map((s) => `${s.value} ${s.label}`).join(", ")}>
          {segments
            .filter((s) => s.value > 0)
            .map((s) => (
              <span key={s.label} style={{ flexGrow: s.value, background: s.color }} title={`${s.value} ${s.label}`} />
            ))}
        </div>
      ) : null}
      {segments ? (
        <div className="kpi-legend">
          {segments.map((s) => (
            <span key={s.label}>
              <i style={{ background: s.color }} />
              {s.value} {s.label}
            </span>
          ))}
        </div>
      ) : sub ? (
        <span className="kpi-sub">{sub}</span>
      ) : null}
    </article>
  );
}

export function SectionCard({
  eyebrow,
  title,
  icon,
  actions,
  children,
  className = "",
  flush,
}: {
  eyebrow?: string;
  title?: ReactNode;
  icon?: IconName;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <section className={`section ${flush ? "section-flush" : ""} ${className}`}>
      {(eyebrow || title || actions) && (
        <header className="section-head">
          <div>
            {eyebrow && <div className="eyebrow">{eyebrow}</div>}
            {title && (
              <h2 className="section-title">
                {icon && <Icon name={icon} size={17} />}
                {title}
              </h2>
            )}
          </div>
          {actions && <div className="section-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function PageHead({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow: string;
  title: ReactNode;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function StateView({
  kind,
  title,
  body,
  icon = "pulse",
}: {
  kind: "loading" | "error" | "empty";
  title: string;
  body: string;
  icon?: IconName;
}) {
  return (
    <section className={`state state-${kind}`}>
      <span className="state-icon">
        <Icon name={kind === "error" ? "shield" : icon} size={22} />
      </span>
      <h2>{title}</h2>
      <p>{body}</p>
      {kind === "loading" && (
        <div className="state-skeleton" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      )}
    </section>
  );
}

export function MetaItem({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="meta-item">
      <span className="meta-label">{label}</span>
      <span className={`meta-value${mono ? " mono" : ""}`}>{value}</span>
    </div>
  );
}
