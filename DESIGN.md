# DockerMap Design Language

DockerMap should feel like a local operations instrument: precise, inspectable, and calm
under pressure. The interface is not a marketing surface. It is a workbench for
understanding Docker paths and nearby host runtimes before anyone edits files or changes
services.

## Design Direction

Name: **Harbor Control**

Personality:
- Industrial, local-first, technical, and trustworthy.
- Dense enough for repeated use, but not noisy.
- Clear about risk, provenance, and what will or will not write.
- Aware of one host as a whole: Docker, Compose, PM2, systemd, cron, tmux, tailnet,
  reverse-proxy, DNS, and port signals should feel connected.

Signature move:
- **Mapline rails**: thin routed lines, coordinate labels, and terminal-like path tags that make host path to container path relationships feel inspectable.

Avoid:
- Purple/blue gradient SaaS styling.
- Oversized landing-page hero sections.
- Decorative cards nested inside cards.
- Cute container metaphors that hide operational risk.
- Any UI that makes edit actions feel casual.

## Visual Tokens

The canonical CSS token file is [apps/web/src/design-tokens.css](apps/web/src/design-tokens.css).

Core palette:
- Carbon base for depth and focus.
- Mist text for high contrast.
- Oxide teal for primary path mapping.
- Signal green for healthy runtime state.
- Hazard amber for warnings and review-required states.
- Cut coral for destructive or blocked states.

Typography:
- Display and UI: `Space Grotesk`, then `Inter`, then system sans.
- Body: `Inter`, then system sans.
- Code/path/numeric text: `JetBrains Mono`, then `ui-monospace`.

Shape:
- Work surfaces: 8px to 12px radius.
- Repeated inventory cards: 8px radius.
- Pills/tags: rounded only when representing compact metadata, not primary panels.

Motion:
- Fast, linear-feeling transitions for operational controls.
- No decorative bounce.
- Respect `prefers-reduced-motion`.

## Interaction Rules

- Every edit flow starts as preview/diff.
- Risk states must be visible in text, color, and icon/shape, never color alone.
- Host paths, container paths, file origins, and service names should be copyable or selectable in future UI.
- Filters must preserve URL state.
- Long paths should wrap, truncate only with accessible full text, or use a horizontal code rail.

## Screen Families

- Runtime inventory: dense tables, graph rails, health strips, and filter rows for
  containers, services, jobs, sessions, tailnet nodes, proxies, DNS, and ports.
- Compose map: service to host/container path graph, diagnostics list, and file origin panel.
- Edit preview: unified diff, diagnostics, confirmation gate, rollback note.
- Logs: streaming rows with service/source markers and query state.

## Accessibility Baseline

- WCAG AA contrast for all normal text.
- Minimum 44px interactive targets on touch layouts.
- Visible focus ring using `--focus-ring`.
- One `h1` per route.
- No hover-only disclosure.
