import type { ReactElement, SVGProps } from "react";

/**
 * Inline stroke-icon set. The skills explicitly forbid emoji-as-icon, so every
 * glyph here is a real SVG that inherits `currentColor` and a 1.6 stroke.
 */
export type IconName =
  | "dashboard"
  | "container"
  | "image"
  | "network"
  | "volume"
  | "logs"
  | "compose"
  | "search"
  | "arrow"
  | "pulse"
  | "orbit"
  | "link"
  | "shield"
  | "layers"
  | "chevron";

const paths: Record<IconName, ReactElement> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
  container: (
    <>
      <path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z" />
      <path d="m4 7 8 4 8-4" />
      <path d="M12 11v10" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="m21 16-5-5L5 20" />
    </>
  ),
  network: (
    <>
      <circle cx="12" cy="5" r="2.4" />
      <circle cx="5" cy="18" r="2.4" />
      <circle cx="19" cy="18" r="2.4" />
      <path d="M12 7.4 6.6 15.9M12 7.4l5.4 8.5M7.4 18h9.2" />
    </>
  ),
  volume: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
      <path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" />
    </>
  ),
  logs: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 2.5L7 14M13 14h4" />
    </>
  ),
  compose: (
    <>
      <path d="M4 6h16M4 12h16M4 18h10" />
      <circle cx="18.5" cy="18" r="1.6" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.2-3.2" />
    </>
  ),
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  pulse: <path d="M3 12h4l2.5-6 4 12 2.5-6H21" />,
  orbit: (
    <>
      <circle cx="12" cy="12" r="3" />
      <ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(-28 12 12)" />
    </>
  ),
  link: (
    <>
      <path d="M9.5 14.5 14.5 9.5" />
      <path d="M8 12.5 6.5 14a3.5 3.5 0 0 0 5 5l1.5-1.5" />
      <path d="M16 11.5 17.5 10a3.5 3.5 0 0 0-5-5L11 6.5" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 5 6v5c0 4.4 3 8 7 10 4-2 7-5.6 7-10V6l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3 13 9 5 9-5" />
    </>
  ),
  chevron: <path d="m9 6 6 6-6 6" />,
};

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
}

export default function Icon({ name, size = 18, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {paths[name]}
    </svg>
  );
}
