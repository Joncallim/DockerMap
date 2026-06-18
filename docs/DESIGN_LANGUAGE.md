# DockerMap UI/UX Design Language

## Source Skill Review

I reviewed GitHub UI/UX skills for Codex and selected `frontend-design` from `vipulgupta2048/codex-skills` for this repo. It is Codex-specific, supports repo-scoped installation at `.codex/skills/`, and focuses on distinctive production-grade frontend work. Other candidates were broader multi-platform packs, Claude-oriented, or Next.js-specific.

Installed location:

```text
.codex/skills/frontend-design/
```

Use this project-local skill for future DockerMap UI work.

## Product Interpretation

DockerMap is a local, security-sensitive operational tool for Docker and nearby host
runtimes. Its design should prioritize:

- Scanability over persuasion.
- Provenance over decoration.
- Diff confidence over speed-to-click.
- Explicit risk over optimistic UI.
- Local trust boundaries over cloud/SaaS polish.
- One-host runtime awareness across Docker, Compose, PM2, systemd, cron, tmux,
  Tailscale/Headscale, reverse proxies, and local DNS.

## Aesthetic Route

Primary route: **Industrial / Utilitarian**

Adapted for DockerMap as **Harbor Control**:

- Rigid grid, labeled panels, coordinate-like metadata.
- Terminal path tags and route lines.
- Carbon, slate, mist, oxide teal, hazard amber, cut coral.
- Compact tables and graph surfaces with strong information scent.
- Minimal motion, used to show data refresh and focus changes.

## Layout Principles

- Use full-width work surfaces, not decorative section cards.
- Keep side navigation restrained and persistent on desktop.
- Use compact repeated cards only for individual resources.
- Favor tables, rails, tabs, segmented controls, and diagnostic strips for operational views.
- Make Compose path mapping a first-class work surface: graph, diagnostics, file origin, dry-run diff.

## Component Language

### Path Tag

Use for host paths, container paths, Compose filenames, and mount sources.

- Mono font.
- Subtle carbon background.
- Left border or leading glyph showing path type.
- Wrap long paths across lines before truncating.

### Diagnostic Strip

Use for validation output.

- Severity label.
- Short human-readable message.
- Origin: file, service, field.
- Machine-readable ID in muted mono.

### Diff Preview

Use for edit plans.

- Unified diff format.
- No write action until a later explicit confirmation design exists.
- Sticky summary showing `willWrite: false` while DockerMap remains read-first.

### Runtime Health

Use for daemon, Docker socket, mock fallback, and snapshot age.

- Signal dot plus text label.
- Color is supporting evidence, not the only state indicator.

## Token Files

- [DESIGN.md](../DESIGN.md): human-facing design source of truth.
- [apps/web/src/design-tokens.css](../apps/web/src/design-tokens.css): CSS variables for implementation.

## Future UI Work

When GUI work begins, start with:

1. Compose map route.
2. Diagnostics table.
3. Edit-plan diff preview.
4. Runtime inventory refinements for Docker and non-Docker runtime signals.
5. Reverse-proxy/deployment status view.
