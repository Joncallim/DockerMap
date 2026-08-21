import { Link } from "react-router-dom";

interface IdentityRefProps {
  /** Identity string straight from the snapshot; schema-valid but may be empty. */
  name: string;
  /** Plain-text fallback rendered verbatim when `name` is empty. */
  fallback: string;
  /** Route target; only rendered as a Link while `name` is non-empty. */
  to?: string;
  /** Class applied to the Link only (plain spans keep the default styling). */
  className?: string;
}

/**
 * Relationship identity that stays VISIBLE when the snapshot records an empty
 * string (see docs/planning/architect-detail-pages-34.md): empty identities
 * render an explicit "Unavailable …" plain-text fallback and never emit a
 * link. Non-empty identities link only when a route target is supplied.
 */
export function IdentityRef({ name, fallback, to, className }: IdentityRefProps) {
  if (name === "") return <span>{fallback}</span>;
  if (to !== undefined) return <Link className={className} to={to}>{name}</Link>;
  return <span>{name}</span>;
}
