# Atlas Implementation Module Map

This document assigns Atlas responsibilities before further implementation grows
the feature. It keeps one coherent published model at the boundary, makes every
translation inspectable, and prevents the legacy Service Map from becoming a
second Atlas implementation. It records code ownership and test ownership; it
does not add an endpoint, dependency, or topology fact.

Status: implementation map for #250/#266. It supplements
[Infrastructure Atlas Architecture](./INFRASTRUCTURE_ATLAS.md). Where the two
documents differ, the architecture document controls semantic authority and
safety rules.

## Non-negotiable boundary

`useSystemModel` is the only browser-side publisher allowed to turn the
snapshot/runtime-map pair into an Atlas publication. The permitted flow is:

```text
existing API contracts
  -> useSystemModel (coherence gate and one projection)
  -> AppContext.atlas (AtlasEnvelope)
  -> Atlas screen / interaction / presentation
  -> renderer primitives
```

The screen, renderers, interaction hook, local-context rail, and tests consume
the published `AtlasEnvelope` or its `AtlasModel`. They must not fetch a graph,
Compose document, network/storage payload, runtime map, snapshot, or Findings
payload for Atlas work. They must not rebuild topology from `SystemModel`,
labels, ports, names, or rendered DOM.

`ServiceMap.tsx` and the existing `lib/layout.ts` remain legacy code until a
separately approved cutover. No Atlas module may be added to either file, and
the legacy map may not import an Atlas projector, renderer, URL-state helper,
or layout rule. The feature flag in `lib/atlas/feature.ts` retains that safe,
default-off parallel rollout boundary.

## Module and ownership map

The paths below are the V1 ownership seams. “Owns” means this is the sole
place that may make the stated transformation or write the stated state. A
future split may add a file inside the named directory only if it preserves the
same inputs, outputs, and dependency direction.

| Concern | Owner path(s) | May read | May write / produce | Must not do |
| --- | --- | --- | --- | --- |
| Coherent data publication | `apps/web/src/hooks/useSystemModel.ts`, `apps/web/src/context.tsx` | Existing typed snapshot, runtime-map, and revision-matched Findings resources | `SystemModel`, `AtlasEnvelope`, and the context publication | Publish a mixed generation/provenance/revision pair; expose raw runtime topology to an Atlas screen; let a screen perform a second join |
| Atlas vocabulary and source adapters | `apps/web/src/lib/atlas/types.ts`, `apps/web/src/lib/atlas/project.ts` | The coherence-gated `RuntimeMap` at the publisher boundary plus already accepted Findings option | Closed `AtlasModel` and `AtlasEnvelope`; only the documented projection rules and bounded diagnostics | Fetch, render, derive endpoints from names/labels, use unbounded raw strings, or create non-evidenced relations/groups |
| Projection rules | `apps/web/src/lib/atlas/project.ts` | Closed contract unions and structural evidence | Subject, relation, attachment, aggregate, diagnostic, and semantic-alternative records | Make visual/camera decisions or treat a presentation lane as containment |
| Deterministic layout and camera-policy constants | `apps/web/src/lib/atlas/layout.ts` | `AtlasModel` only | Revision-free `AtlasLayout`, fixed camera default, and the sole layout/camera-policy version constants | Read the DOM, viewport, theme, wall clock, random source, URL, or raw API data; globally normalize coordinates. `types.ts` describes the corresponding schema literal only. |
| Visual grammar | `docs/architecture/ATLAS_VISUAL_POLICY.md`, `apps/web/src/styles.css`, `apps/web/src/lib/atlas/presentation.ts` | Atlas presentation fields and approved visual-policy tokens | Marker order/text and CSS treatment | Reclassify health/freshness/attention/ambiguity, expose evidence/source metadata, or infer topology |
| Renderer primitives and selection decision | `apps/web/src/lib/atlas/renderers/`, `apps/web/src/components/atlas/AtlasOverviewTopology.tsx` | `AtlasModel`, `AtlasLayout`, fixed camera, presentation helpers, explicit callbacks | SVG/HTML structure and accessible orientation/text representation | Fetch or project topology, mutate route state directly, invent hidden edges, or use raw API/contract records |
| Screen composition | `apps/web/src/screens/AtlasOverview.tsx`, `apps/web/src/App.tsx` | `AppContext.atlas`, Atlas state hook, renderer/local-context components | Page composition, loading/empty/error treatment, and the fixed per-mount camera ref | Duplicate projection/layout policy, fetch data, or turn lanes/local context into causal claims |
| Interaction and URL state | `apps/web/src/lib/atlas/interaction.ts`, `apps/web/src/hooks/useAtlasState.ts` | `AtlasModel`, current browser location/history | Canonical bounded `subject`/`expand` route state, exact-key selection/expansion, focus recovery | Accept labels, coordinates, arbitrary lenses, raw evidence, or stale/ambiguous identities; retain state outside the exact coherent model |
| Local context / lens policy | `apps/web/src/lib/atlas/localContext.ts`, `apps/web/src/components/atlas/AtlasLocalContext.tsx` | Selected routable subject and evidence-backed Atlas attachment records | Selected-only, bounded local-context items | Create a graph edge, imply communication/reachability/host containment, or disclose raw provenance |
| Refresh and camera policy | `docs/architecture/ATLAS_REFRESH_POLICY.md`, `apps/web/src/screens/AtlasOverview.tsx`, `apps/web/src/hooks/useAtlasState.ts` | Coherent envelope revision, explicit route state | Atomic replacement, retained fixed framing, exact-key reconciliation/focus recovery | Auto-fit/recenter on refresh, persist camera, add camera URL state, or animate inferred temporal behavior |
| Feature gate | `apps/web/src/lib/atlas/feature.ts`, `apps/web/src/App.tsx` | Build-time environment flag | Route inclusion only | Add an operator-facing setting, change legacy routing, or make Atlas default-on without cutover approval |
| Fixtures, goldens, and test builders | `apps/web/src/lib/atlas/fixtures.ts`, `apps/web/src/lib/atlas/__goldens__/`, `apps/web/src/lib/atlas/GOLDEN_GOVERNANCE.md` | Contract-valid static fixture inputs and versioned expected outputs | Deterministic synthetic inputs and approved semantic/layout/local-context goldens | Use a live host, timestamp, secret, raw evidence text, or a screenshot as semantic authority |

## Dependency direction and translation count

Atlas has exactly three allowed semantic translations:

1. Existing API contracts to the existing resource hooks.
2. `RuntimeMap` to `AtlasEnvelope` in `useSystemModel`, by calling the one
   pure `projectRuntimeMap` adapter.
3. `AtlasModel` to `AtlasLayout` in the one pure layout module.

All downstream code is presentation, bounded interaction state, or selected
local disclosure. It may select or format a projected record, but cannot
translate raw contracts into another topology representation. In particular:

- `AtlasOverview` receives `atlas` from context; it owns no data request.
- A renderer receives `AtlasModel`/`AtlasLayout`; it owns no semantic join.
- `useAtlasState` validates only exact projected keys in the current model;
  it owns browser history, not topology.
- `localContext` filters existing projected attachments by exact selected key;
  it owns no relation/membership derivation.
- No module imports the legacy `ServiceMap` graph derivation or `lib/layout.ts`
  for Atlas behavior.

New code that needs a topology fact must first extend the coherent published
contract and the adapter authority in the architecture review. It must not add
an Atlas-specific endpoint, second cache, hidden screen fetch, or a parallel
client-side join merely to avoid changing a contract.

## State-write authority

Atlas intentionally has few mutable states. Their writers are exclusive:

| State | Sole writer | Reset / invalidation rule |
| --- | --- | --- |
| Coherent model and Atlas envelope | `useSystemModel` | Replace only after matching generation, provenance, and non-empty revision; otherwise retain the prior coherent publication |
| Route selection and expansion | `useAtlasState` through canonical URL serialization | Drop all invalid/unrecognized values; retain only an exact current routable key or current aggregate/group key |
| Keyboard focus recovery | `useAtlasState` intent plus the owning directory/expanded content refs | When a selected key disappears, collides, or becomes unresolved, selection clears and focus returns to the directory; expansion focuses its actual content |
| Fixed viewport framing | `AtlasOverview` mount-local ref | Never overwritten by a coherent refresh; it is not URL, local-storage, semantic, or layout state |
| Feature availability | build-time `ATLAS_OVERVIEW_ENABLED` | Defaults off; no runtime setting mutates it |

Components may hold ordinary ephemeral rendering refs, but they may not persist
or publish semantic topology, camera coordinates, or an alternate selection
authority. Closed TypeScript unions are required at every switch over runtime
kind and Atlas semantic kind: unknown values become the documented bounded
unsupported/unresolved outcome rather than a default service shape.

## Test ownership

Tests live beside their owner so a change cannot silently move authority to a
screen. The required ownership is:

| Change area | Required tests / evidence owner |
| --- | --- |
| Types, projection rules, caps, redaction, collision and evidence binding | `apps/web/src/lib/atlas/atlas.test.ts` plus projector-focused cases beside `project.ts` when introduced |
| Deterministic ordering, layout, local reflow, and policy versions | `atlas.test.ts`, layout tests, and exact `__goldens__` governed by `GOLDEN_GOVERNANCE.md` |
| Presentation enums and non-colour text/markers | `apps/web/src/lib/atlas/presentation.test.ts` |
| URL parsing, exact-key reconciliation, history, and focus recovery | `apps/web/src/lib/atlas/interaction.test.ts` and `apps/web/src/hooks/useAtlasState.test.tsx` |
| Coherent source publication and Findings admission | `apps/web/src/hooks/useSystemModel.test.tsx` |
| Renderer semantics, keyboard surface, and renderer selection | `apps/web/src/lib/atlas/renderers/*.test.tsx`, then browser geometry tests before screenshot expansion |
| Screen composition, no screen fetch, local context, and refresh framing | `apps/web/src/screens/AtlasOverview.test.tsx`, `localContext.test.ts`, and refresh-policy tests |

Browser geometry and screenshot tests are renderer-owned acceptance evidence,
not substitutes for semantic or source-authority tests. Screenshot changes
need the review process in `GOLDEN_GOVERNANCE.md`; no test fixture may contain
live host data or unredacted evidence.

## Change-review checklist

Before accepting an Atlas change, reviewers verify that it names one owner in
this map, preserves the dependency flow, and adds tests in that owner's test
layer. Any exception—such as a new lens, a different data source, a new
semantic translation, or Atlas/legacy-map sharing—must be written into
`INFRASTRUCTURE_ATLAS.md` and reviewed before implementation. A code comment
or a renderer convenience is not an exception process.
