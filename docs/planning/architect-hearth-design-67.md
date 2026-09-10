# #67 Hearth design-system adoption: preflight boundary

**Status:** the public-safe token export is committed in DockerMap; no private
package, asset, URL, or build-time fetch is required. Wider primitive and
screen alignment remains incremental work under #67.

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

The committed `apps/web/src/hearth-tokens.css` is the public-safe export. It
records its source revision and contains only reviewed CSS primitives. It is
not a package, asset import, or private-repository dependency; public builds
continue to work with no Hearth credentials.

## Source audit — 29 August 2026

The canonical source was reviewed at private repository revision
`04f32a9a48530142189bb6ec4c4209da8ffa71bc`. That revision is provenance only:
the public DockerMap checkout must not fetch it, include it as a submodule, or
depend on it at build/runtime.

The source establishes these relevant contracts:

- Azure is the primary action/selection/focus role; purple is limited to
  AI-assisted context; healthy, warning, and critical remain semantic states.
- Normal UI uses the Apple/system stack beginning with `-apple-system` and
  `BlinkMacSystemFont`; monospace is limited to technical evidence.
- Light surfaces are warm off-whites, dark surfaces are graphite/charcoal,
  geometry is moderately rounded with low-contrast borders, and focus uses the
  Azure role.
- Human-facing language leads with observed state/impact and makes inference
  distinguishable; persona language must not alter evidence or permissions.

No locked Hearth raster mark, private screenshot, generated master, or
private deployment configuration was copied during this audit.

## Divergence matrix to complete against the source export

| Area | DockerMap baseline to inspect | Migration guardrail |
| --- | --- | --- |
| Typography | `--font` and `--mono` resolve through the committed Hearth export; its type roles now anchor the normal UI body/title scale | Retain monospace for paths, ports, logs and IDs. |
| Tokens | `styles.css` consumes the committed Hearth canvas, surface, text, Azure, AI, border, shadow, spacing, radius, and font roles | Map remaining screen-local hard-coded values gradually; never bulk-replace arbitrary colors. |
| Themes | `data-theme` and Settings override already provide system default and explicit user override | Keep behavior; migrate from cool blue-grey light surfaces and near-black dark surfaces to reviewed warm/graphite roles. |
| Health state | service/map/runtime state colors | Do not repurpose state colors for brand decoration. |
| AI | Copilot input, answer panel, suggestion chips, and answer references use the exported AI-purple roles | Do not recolor health, generic actions, or topology state. |
| Primitives | panels, metrics, tags, empty/error/loading states, and common shell spacing/radii consume shared geometry aliases | Consolidate remaining screen-local controls without changing accessible names, focus, keyboard behavior, or evidence labels. |
| Topology | graph node/edge and inspector rules use a fixed dark dense-workspace canvas | This is a deliberate DockerMap-specific exception: keep its high-contrast local palette and collision visibility in both themes rather than forcing a general surface role. |
| Runtime egress | HTML/font/network requests | Public production page must load with no font CDN dependency. |

## Required implementation evidence

1. **Completed:** commit the reviewed public-safe export and its source/version
   metadata, including the audited source revision above and an explicit
   asset-safety statement.
2. Add a deterministic drift check that does not contact a private service.
3. Prove `npm ci`, build, and production image need no private credential.
4. Capture an offline page load with no external font request.
5. Re-run full browser and a11y matrices, including light/dark and 200% zoom.
6. Record retained DockerMap-specific exceptions in the #67 resolution evidence.

This preflight does not satisfy #67 acceptance criteria and must not be used to
close the epic. It only prevents a future implementation from silently
introducing a private dependency or treating unverified guidance as canonical.
