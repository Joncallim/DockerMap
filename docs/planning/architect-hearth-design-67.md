# #67 Hearth design-system adoption: preflight boundary

**Status:** preparation only; no Hearth design tokens, assets, or private
repository content have been imported.

## What is verified locally

DockerMap currently has a standalone web token layer in
`apps/web/src/styles.css`, uses a system-font variable plus technical
monospace, and has separate light/dark theme selectors. Its public build does
not declare a private design-system package. This preparatory slice removes
the unused Google Fonts/preconnect links and adds a source regression test, so
the normal UI now has no font-CDN dependency before any visual token migration.

Existing product-specific behavior that a Hearth alignment must preserve:

- topology state colors encode operational state and are not decorative;
- collision, unavailable, and sample evidence are explicit and fail closed;
- Copilot/evidence treatment is separate from ordinary operational state;
- 800px, 640px, keyboard, 200% zoom, and Axe coverage are release gates.

## Authority boundary decision

No private repository dependency may enter `package.json`, `npm ci`, Docker
builds, CI, or the public source checkout. The eventual implementation must
consume a **committed public-safe export** containing only reviewed tokens and
assets, with source/version metadata in this repository. A build-time fetch,
git submodule, private npm registry, or runtime asset URL is rejected.

Before implementation, record the authoritative Hearth export version and a
license/asset-safety review. Until then, this document intentionally does not
invent canonical hex values, logos, typography rules, or copy guidance.

## Divergence matrix to complete against the source export

| Area | DockerMap baseline to inspect | Migration guardrail |
| --- | --- | --- |
| Typography | `--font` normal UI and `--mono` technical evidence | Normal text follows the approved Hearth stack; paths, ports, logs, IDs remain monospace. |
| Tokens | CSS custom properties in `styles.css` | Map semantic roles, never bulk-replace arbitrary colors. |
| Themes | `data-theme` and Settings override | Keep system default and explicit user override. |
| Health state | service/map/runtime state colors | Do not repurpose state colors for brand decoration. |
| AI | Copilot/evidence presentation | Reserve AI purple only for AI-assisted context. |
| Primitives | panels, tags, links, controls, empty/error/loading states | Preserve accessible names, focus, keyboard behavior, and evidence labels. |
| Topology | graph node/edge and inspector rules | Preserve dense-host readability and collision visibility. |
| Runtime egress | HTML/font/network requests | Public production page must load with no font CDN dependency. |

## Required implementation evidence

1. Commit the reviewed public-safe export and its source/version metadata.
2. Add a deterministic drift check that does not contact a private service.
3. Prove `npm ci`, build, and production image need no private credential.
4. Capture an offline page load with no external font request.
5. Re-run full browser and a11y matrices, including light/dark and 200% zoom.
6. Record retained DockerMap-specific exceptions in the #67 resolution evidence.

This preflight does not satisfy #67 acceptance criteria and must not be used to
close the epic. It only prevents a future implementation from silently
introducing a private dependency or treating unverified guidance as canonical.
