# DockerMap Page Logic

This document describes the current browser architecture. The route declaration in
`apps/web/src/App.tsx` remains executable authority when this guide and code differ.
DockerMap is read-only: no page exposes start, stop, restart, pull, prune, create,
delete, connect, or disconnect actions.

## Shared model

`AppShell` loads one authenticated Docker snapshot, runtime map, findings response,
and bounded observed-history response. Screens derive their views from that shared
state; they do not create parallel provider models.

- The Docker snapshot owns container, image, network, and volume inventory.
- The runtime map owns provider-neutral nodes, edges, evidence, diagnostics, and
  provider freshness.
- Findings are a closed Rust-owned advisory contract.
- Observed history contains at most 64 sanitized deltas between successful Docker
  inventory snapshots during the current daemon lifetime. It is not Docker event,
  deployment, causality, or persistent audit history.
- Resource telemetry is not collected. Live and mock modes must say so rather than
  render demo CPU, memory, or network activity as observed data.

## Current routes

| Route | Purpose |
| --- | --- |
| `/` | Home summary and primary topology story. |
| `/map` | Interactive service topology. |
| `/runtime` | Provider-neutral runtime inventory and evidence. |
| `/findings` | Closed, evidence-bounded advisories. |
| `/services/:name` | Service detail resolved through collision-safe identity. |
| `/networks/:name` | Docker network detail. |
| `/volumes/:name` | Docker volume detail. |
| `/images/:image` | Docker image detail. |
| `/changes` | Bounded daemon-lifetime inventory deltas, or an honest non-collection state. |
| `/copilot` | Deterministic read-only questions over the loaded model. |
| `/networking` | Network inventory. |
| `/storage` | Volume inventory. |
| `/images` | Image inventory. |
| `/logs` | Bounded non-following container logs. |
| `/compose` | Compose discovery and dry-run edit planning (`willWrite: false`). |
| `/diagnostics` | Provider and contract diagnostics. |
| `/settings` | Browser-local presentation/settings controls. |
| `/atlas` | Build-gated Atlas overview; absent from the default production image. |

Unknown routes render the explicit not-found screen. There is no `/containers`
route; services are selected from the graph/inventory and open at `/services/:name`.

## Cross-page rules

- The graph is the primary navigation surface. Selecting a service opens its detail
  without changing the observed host.
- Network, volume, and image references link only to the corresponding read view.
- Runtime evidence supports exactly the relationship displayed; reachability,
  activity, health, or causality are not inferred from configuration alone.
- Identity collisions resolve through the canonical aggregate/selector rules rather
  than label-only matching.
- Demo data is visibly labelled and cannot be admitted as live evidence.
- Missing, stale, rejected, or unsupported data produces an explicit unknown or
  not-collected state.

## Browser API authority

The UI consumes authenticated `/api/*` routes through the Node boundary. Node
validates Rust-owned contracts before publication and fails closed on semantic drift.
The browser does not call the Rust daemon or Docker socket directly. See
`CONTRACT_AUTHORITY.md` and `DOCKER_AUTHORITY_BOUNDARY.md` for those boundaries.
