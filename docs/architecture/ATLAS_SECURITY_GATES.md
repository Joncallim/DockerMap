# Atlas Security, Redaction, and Resource Gates

This document is the security acceptance gate for Atlas changes that consume
published infrastructure data. It makes the review questions concrete without
claiming that a review gate changes the daemon, API authentication, or browser
runtime by itself. Atlas remains read-only and may show only the bounded,
redacted facts already admitted by its projection.

Status: review and acceptance policy for #250/#263. Gate version:
`atlas-v1/security-gates-1`. It supplements
[Infrastructure Atlas Architecture](./INFRASTRUCTURE_ATLAS.md),
[Atlas Implementation Module Map](./ATLAS_IMPLEMENTATION_MAP.md), and
[Atlas Golden Governance](../../apps/web/src/lib/atlas/GOLDEN_GOVERNANCE.md).
Those documents remain authoritative for source semantics, module ownership,
and golden changes.

## How to use this gate

Before approving an Atlas change, the author records the changed gate rows,
the exact tests run, and any row which needs a new test. A reviewer rejects the
change if it weakens a required row, substitutes a visual check for a
source-boundary check, or treats an unimplemented future check as evidence.
The gate is deliberately versioned so a later, approved expansion can be
reviewed as a policy change rather than silently relaxing V1.

Current implementation evidence named below is a useful regression check, not
a blanket guarantee for future code. “Future verification required” means the
current tree has no dedicated automated enforcement for that proposed change.

## Required gates

| Gate | Required outcome | Current V1 evidence | Future verification required when changed |
| --- | --- | --- | --- |
| Identity, collision, and routability | A selected or linked subject must be an exact, bounded, current projected key. Empty, malformed, duplicate, unsupported, unresolved, or redacted-colliding identities stay visible but non-routable. Never fall back to name, label, array position, image, role, or DOM text. | `project.ts` validates keys and emits derived non-routable diagnostics; `selectedSubject` and `interaction.ts` require an exact routable entry. `atlas.test.ts`, `interaction.test.ts`, `localContext.test.ts`, and `renderer-mounted.test.tsx` cover collision and invalid-selection cases. | Add adversarial cases for every new identity source, cross-screen handoff, aggregate, or selection surface. |
| Coherent source and no screen join | Atlas screens/components consume `AppContext.atlas`; only `useSystemModel.ts` projects a matching snapshot/runtime revision and accepts revision-matched Findings. No Atlas screen, renderer, lens, or local rail fetches or joins graph, Compose, runtime, network, storage, or Findings data. | `useSystemModel.ts`, `AtlasOverview.tsx`, and the module map document the one-publisher boundary; `useSystemModel.test.tsx` covers coherence/Findings admission and `AtlasOverview.test.tsx` covers composition. | Add an import/fetch-boundary test before adding a screen, lens, source, cache, or context publisher. |
| Redaction and raw-data minimisation | Do not promote argv, environment, Compose contents, raw metadata, path, error text, raw evidence/source references, or unredacted host records into the Atlas model, DOM, URL, fixture, golden, or screenshot. A source label may appear only through the bounded projected display field; it is never a key or direct raw-DOM/URL value. Renderer/local-context output uses safe projected display/state fields only. | `project.ts` ignores metadata and makes bounded display text; `localContext.ts` accepts `AtlasModel`, not raw records, and does not emit evidence identifiers or summaries. `renderer.test.tsx` and `localContext.test.ts` include raw-source/raw-secret non-rendering checks. | Add explicit negative assertions for every new projected field and any new capture/screenshot pipeline. |
| Bounded input and pre-normalisation work | Reject whole over-cap node, edge, edge-evidence, provider-state, and Finding collections before sort/allocation. Bound raw IDs, display strings, status parsing, evidence strings, subjects, relations, per-subject attachments, diagnostics, local-rail scans/items, layout points, and renderer DOM work. Do not introduce an input-dependent nested scan or unbounded normalization before a cap. | `ATLAS_CAPS` in `types.ts`; `project.ts`, `localContext.ts`, renderer policy, and layout implement caps. `atlas.test.ts`, `localContext.test.ts`, and `renderer-mounted.test.tsx` exercise 250-subject, oversize, hostile-string, edge-evidence/provider-state, attachment, and DOM-cap cases. | Provide a cap, failure/omission wording, deterministic test, and complexity review for each new collection, index, traversal, aggregation, label operation, or renderer primitive. |
| Safe browser rendering | Host-derived values are React/SVG text, not HTML. A raw value must never select a CSS class, style, token, element name, `data-*` semantic channel, ARIA role/name, selector, transform, URL, or navigation destination. Classes and marker labels come only from closed Atlas unions and fixed lookup tables. | `presentation.ts` maps closed enums to fixed glyph/class tables; `AtlasOverviewTopology.tsx` bounds display text and derives classes from booleans/closed state. No Atlas module uses `dangerouslySetInnerHTML`. | Add DOM-level hostile text and attribute assertions before adding a new attribute, style, SVG primitive, markdown/HTML formatter, or user-visible URL. |
| URL and interaction confinement | Atlas URL state is bounded and atomic: only model-valid `subject` and `expand` values, plus the default `lens=overview` token, survive. Unknown, duplicate, oversized, camera-like, label, evidence, occurrence, and coordinate values do not become state. Cross-screen links use exact published source IDs only; selection clears on a missing/collided revision. | `interaction.ts` uses a closed query vocabulary and exact model lookup; `useAtlasState.ts` reconciles revisions. `interaction.test.ts` and `useAtlasState.test.tsx` cover invalid, oversized, collision, and refresh cases. | Re-review URL parsing and redaction before adding a lens, parameter, deep link, persisted state, clipboard/export behavior, or an external link. |
| Evidence and topology non-claims | A relation needs closed directional evidence; an attachment is only recorded non-causal context. Opaque port strings and port-publication evidence never become host exposure, bind scope, protocol, externality, reachability, traffic, readiness, ownership, containment, or data-direction claims. | `project.ts` permits only canonical structural evidence; `localContext.ts` revalidates attachment vocabulary. `atlas.test.ts` and `localContext.test.ts` check fail-closed evidence handling and non-claim output; `AtlasLocalContext.tsx` states the disclaimer. | Require architecture and security review plus fixtures for every evidence kind, relation direction, attachment label, port presentation, group, or semantic claim. |
| Fixture, golden, screenshot, and capture sanitation | Synthetic fixtures are the normal input. Fixtures, goldens, test HTML, screenshots, and approved real-host captures may not contain secrets, raw evidence/source references, raw metadata, or unredacted host data. A screenshot is presentation evidence, never permission to disclose a new field or establish topology. | `fixtures.ts` is synthetic; `GOLDEN_GOVERNANCE.md` forbids live host data, timestamps, revisions, and screenshots as semantic authority. No approved Atlas screenshot/capture suite is claimed by the current tree. | Before adding captures/screenshots, review fixture diffs for secret-like and host-specific data, record redaction procedure/source/revision, and add an automated sanitation check where practical. |
| Dependency and egress change control | V1 adds no graphics/layout dependency, telemetry, remote asset/font, external fetch, worker, WASM, or unsafe-HTML requirement. A third-party renderer/layout library cannot enter through a transitive convenience import without normal production dependency/audit review and explicit architecture approval. | `RENDERER_DECISION.md` records the selected dependency-free SVG/HTML approach; renderer tests assert the bounded native baseline. This is implementation evidence, not a general dependency scanner. | For any package, CDN/remote asset, worker, WASM, network request, telemetry, or build plugin: perform dependency/license/security review, inspect production bundles and CSP/egress impact, document data flow, and obtain explicit architecture approval before merge. |
| Authentication and read-only boundary | Atlas does not add an API endpoint, credentials, auth bypass, write action, or change to browser/daemon authentication. Existing typed API resources retain their established auth/CORS/redaction path. | The Atlas path reuses the existing `useSystemModel` resources and feature-gated route; no Atlas-specific API client or write action exists. | An API, token, cookie, CORS, remote-daemon, download, or write-mode change requires API-contract and security review with matching tests. |

## Review procedure

1. Identify the untrusted input boundary and every new field or collection.
2. Trace it from typed API resource through `useSystemModel`, projection,
   layout/interaction, and renderer. Confirm there is no side fetch or raw
   join.
3. Apply each required gate above, including negative rendering and
   non-routability cases. Check the changed code, not only a fixture outcome.
4. Run the narrowest owner tests. For a projection, interaction, or renderer
   boundary change, include the corresponding tests named in the table; run
   `npm run typecheck` when TypeScript module boundaries change.
5. If a future-verification row applies, add its test/check in the same change
   or keep the change out of V1 until architecture/security approval names a
   bounded alternative.

The reviewer records the gate version, changed rows, files inspected, commands
and results, and any intentionally deferred policy work. “Read-only” never
waives input, redaction, or denial-of-service review.

## Explicit V1 limits

This gate does not claim that Atlas has a generic secret detector, a production
dependency scanner, live-host screenshot certification, browser-wide CSP/egress
monitoring, or a formal performance threshold. Those are future controls if a
change needs them. The present safety boundary is the closed projection,
bounded deterministic work, React/SVG text rendering, exact-key routing, and
the existing authenticated API path; it must not be described as a broader
guarantee.
