# DockerMap Design Language

DockerMap is a visual operating system for self-hosted infrastructure. The interface
exists to create **understanding**, not to manage containers. Every screen should help a
person answer — within seconds — what they have, how it is connected, what is healthy,
what changed, and what to do next.

The companion document [docs/design/DESIGN_LANGUAGE.md](DESIGN_LANGUAGE.md) shows this
language applied, screen by screen, with screenshots. This file is the source of truth for
principles and tokens.

## North Star

DockerMap should feel like the clarity of Linear, the situational awareness of Datadog,
the spatial organisation of Arc, and the speed of Raycast — with the restraint of a premium
productivity tool. The emotional result is *"I understand my infrastructure,"* never
*"I am managing containers."*

We optimise for understanding. We do not imitate Portainer, Kubernetes dashboards, or the
AWS console, which optimise for operational power.

## Mental Model

The product is built around four first-class concepts. The UI thinks in these terms and
nothing below the data layer leaks Docker vocabulary into the experience.

| We say | Not |
| --- | --- |
| Service | Container |
| Project | Compose file |
| Relationship | Network |
| Outcome / Impact | Infrastructure |

## Progressive Disclosure

Information reveals itself by intent across four layers. We never show everything at once.

1. **System story** — counts, what needs attention, recent change (Home).
2. **Relationships** — the service map, dependencies, impact radius (Service Map).
3. **Operations** — logs, resources, configuration, images, volumes, networks.
4. **Docker internals** — container IDs, raw image refs, port bindings. Shown only on request.

## Information Hierarchy

Always, in this order:

1. **State** — healthy, warning, degraded, offline, updating, unknown.
2. **Service name**.
3. **Key metrics** — CPU, memory, network.
4. **Metadata** — image tags, container IDs, technical detail.

State dominates. Names come second. Metrics third. Metadata last.

## State System

Every service is in exactly one state. State is visible everywhere, and **colour only ever
encodes state** — it is never decorative.

| State | Token | Meaning |
| --- | --- | --- |
| Healthy | `--s-healthy` (green) | Fully operational |
| Warning | `--s-warning` (amber) | Issue detected, still functional |
| Degraded | `--s-degraded` (orange) | Functionality impaired |
| Offline | `--s-offline` (red) | Unavailable |
| Updating | `--s-updating` (blue) | Deploy or maintenance in progress |
| Unknown | `--s-unknown` (grey) | Insufficient information |

`--accent` (blue) is reserved for selection and interactive affordances. Because selection
and the *updating* state share a hue, selection is always reinforced with a ring or weight
change so the two never rely on colour alone.

## Visual Tokens

The public-safe Hearth primitive export lives in
[apps/web/src/hearth-tokens.css](../../apps/web/src/hearth-tokens.css). DockerMap aliases
those roles in `:root` in [apps/web/src/styles.css](../../apps/web/src/styles.css), then
keeps operational state colours local. Highlights:

- **Surfaces** — a near-black base (`--bg`) with three raised surface levels and two
  hairline border weights. Dense layouts stay calm because contrast between surfaces is low
  and intentional.
- **Typography** — Hearth's `--hearth-type-xs/sm/body/title` roles drive common control and
  interface text; `--mono` is reserved for paths, IDs, ports, log lines, and clocks.
- **Shape and spacing** — Hearth's `--hearth-radius-*` and `--hearth-space-*` roles drive
  common actions and forms. Pills are fully rounded only for compact metadata.
- **Shell roles** — the rail uses Hearth's raised canvas; the topbar and navigation hover
  state use its surfaces; the selected navigation item and brand mark use Azure. On narrow
  screens the horizontal rail remains scrollable and its overflow affordance returns to the
  raised canvas, so routes are never clipped.
- **Operational exceptions** — `--s-*` service state, map network, edge-health, and log
  severity colours remain DockerMap-owned because they encode observed topology and health,
  not a decorative theme. Map nodes, edge geometry, and the 30px map-view controls likewise
  retain their local spatial measurements: they describe graph interaction targets rather
  than ordinary form controls. The binary settings switch also retains its knob and track
  measurements so its checked state remains visually unambiguous.
- **Motion** — one easing token (`--t`, ~140ms). Motion explains (focus, selection, data
  refresh); it never decorates. Respect `prefers-reduced-motion`.

## Information Compression

Maximise signal ÷ pixels. Information density is high; cognitive load is low.

- Prefer split panes, tables, the topology view, context panels, and the command palette.
- Avoid giant cards, oversized metrics, decorative gradients, and dashboard bloat.
- Every element must justify its existence. A row should carry several facts, not one.

## Navigation

Navigation is spatial, organised into **spaces** rather than a deep menu tree:

- **Understand** — Home, Service Map, Changes, Copilot.
- **Operate** — Networking, Storage, Images, Logs, Compose.

The **⌘K command palette** is a primary interface: navigate, jump to any service, or ask
Copilot. Everything reachable by search.

Azure belongs to shared shell selection and navigation affordances. Copilot is the sole
consumer of the Hearth AI purple roles; topology and operational state colours remain
DockerMap-local and never borrow either decorative treatment.

## AI Doctrine

The map is the primary interface; Copilot enhances understanding. Copilot is an
**interpreter, investigator, educator, and architect** — it explains and reasons over the
topology. It is never a container operator, a chat-first interface, or a hidden navigation
layer. Today it reasons locally and deterministically over the live model.

## Interaction Rules

- Risk and state are expressed in text *and* colour *and* shape — never colour alone.
- Hovering a service highlights its relationships; selecting it reveals its impact radius.
- Empty states teach the next action; they never market, decorate, or celebrate.
- Resource usage samples are shown only in explicit demo mode and labelled "Sample data";
  mock and live mode report non-collection rather than showing a number. Change history
  is likewise synthetic only in explicit demo mode; mock and live mode report it as
  not collected.

## Accessibility Baseline

- WCAG AA contrast for normal text.
- One `h1` per route.
- Visible keyboard focus; map nodes are focusable and operable by keyboard.
- No hover-only disclosure of essential information.

## The Final Test

For every feature, screen, and interaction: *does this help the user understand their
infrastructure?* If no, remove it. If maybe, simplify it. If yes, make it obvious.
