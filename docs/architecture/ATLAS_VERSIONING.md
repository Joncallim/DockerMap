# Atlas versioning and golden compatibility

Status: internal change-control authority for #264. This is not a public API,
daemon, or DockerMap release compatibility promise.

Atlas has three independently named policy authorities:

| Authority | V1 value | Owns | Does not own |
| --- | --- | --- | --- |
| Projection | `atlas-v1/projection-1` | accepted runtime facts, source/evidence validation, canonical semantic order, omission behavior | daemon/API compatibility or browser geometry |
| Logical layout | `atlas-v1/local-lanes` | lane taxonomy, slot coordinates, card dimensions, canonical ordering, camera-operation bounds | viewport, theme, density, DOM measurement, or persisted coordinates |
| Visual grammar | `atlas-v1/visual-grammar-1` | renderer-neutral marks, disclosure, accessibility grammar, route/congestion presentation rules | semantic topology, source authority, or physical host placement |

The renderer experiment is separately named `atlas-v1/renderer-spike-1`; it is
not a replacement for the visual grammar authority. These values live in
`apps/web/src/lib/atlas/versioning.ts`. The projection and layout values derive
from their actual projection/layout owners, avoiding a second mutable copy.

## Exact golden contract

`apps/web/src/lib/atlas/__goldens__/policy-versions.json` is an exact manifest,
asserted by a focused test. It binds named semantic, logical-layout, and
selected-local artifacts (including the actual local-rail policy value) to the
policy versions that generated them. Goldens remain canonical JSON only: no
clock values, model revisions, live host data, paths, raw evidence, browser
pixels, or secrets.

A dependency upgrade cannot rewrite a golden by accident. Atlas V1 uses no
third-party graph/layout engine. The explicit dependency policy is `none`; if
one is adopted, the proposal must pin package name and exact version, include
the lockfile diff, show deterministic fixture evidence, and record security and
license review before coordinates or goldens change.

## Policy-change and migration record

Every intentional Atlas policy change must add a dated entry below (newest
first) and satisfy every checklist item. A changed golden, screenshot, or
dependency lockfile alone is never a migration record.

| Date | Policy authority/value change | Why | Exact affected artifacts | Compatibility decision | Reviewer/approval |
| --- | --- | --- | --- | --- | --- |
| 2026-09-07 | Initial `projection-1`, `local-lanes`, `visual-grammar-1` authority | Establish explicit ownership before route evolution | semantic/layout/local-attachment policy goldens | No prior Atlas persisted state; future old state fails closed | #264 foundation |

Required checklist:

- [ ] Identify whether projection, layout, visual grammar, renderer, or a
      dependency decision changed; assign a new named value for every changed
      authority. Do not change an existing value's meaning in place.
- [ ] Update the exact manifest and only the goldens owned by that authority;
      review byte-level semantic/layout diffs separately from screenshots.
- [ ] Explain why canonical order, lane slots, collisions, omission bounds,
      source evidence, and non-claims still hold—or record a separately
      approved authority change.
- [ ] For a layout dependency, pin package and version, review its lockfile,
      license and security posture, and run the deterministic fixture matrix.
- [ ] Run focused version/golden tests plus the relevant projection, renderer,
      browser-geometry, accessibility, and screenshot gates. Screenshot
      approval cannot authorize a semantic/layout change.
- [ ] Record maintainer approval and any browser-state migration result.

## Browser and shareable semantic state

Atlas currently persists and shares no browser state. If that is introduced,
it must use the versioned semantic-state codec in `versioning.ts` and may store
only a lens and one bounded opaque Atlas subject-key identity. Its closed
published-key syntax accepts the daemon's `docker_container_`,
`docker_network_`, `docker_volume_`, listener, host, and provider-specific
families with a bounded opaque suffix (including the daemon's safe `.`
punctuation)—rather than only one fixture's duplicated kind prefix. It rejects
paths, display labels, evidence-like IDs, derived keys, query strings, and
arbitrary prose before the route-time exact-routable-subject check. It must not
store or publish camera `x`/`y`, zoom, viewport, card coordinates, route
geometry, renderer choice, or raw identity/evidence values.

State is accepted only when schema, projection, layout, and visual grammar
versions all exactly match. Malformed, oversized, removed, collided, unresolved,
or old-version state degrades to the unselected Overview lens. The route then
performs its existing exact-routable-subject check before selection. There is no
best-effort coordinate remapping and no fallback lookup by display label. This
protects old local storage or a stale link from moving focus to a different
subject after a policy change.
