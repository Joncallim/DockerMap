# Infrastructure Atlas — Orthogonal Review Ledger

Companion to `INFRASTRUCTURE_ATLAS.md` for #250/#251. This records repo-grounded review findings so implementation agents do not need to reconstruct the reasoning.

## Review method

Each pass asks a different failure question. A finding is considered absorbed only when it appears in the architecture spec or a tracked #250 child issue. Review converges when another pass yields no new independent P1/P2 architecture class.

## Pass 1 — truth and contract authority

### Finding
The initial Atlas concept assumed evidence-backed application/project grouping. The live generated `ContainerRecord` contract has no Compose project identity. `SystemModel` also contains heuristic `ServiceKind` classification.

### Refinement
- V1 may not assume project grouping.
- #259 must inventory the actual source authority and choose the narrowest truthful Atlas adapter.
- No name/image clustering or aesthetic backend contract expansion.
- If no trustworthy grouping source exists, render ungrouped/provider-standardised subjects.

Status: absorbed by #250/#251/#259.

## Pass 2 — identity and permutation safety

### Finding
A layout can be permutation-invariant at the canonical-id level while still assigning arbitrary occurrence positions when post-redaction IDs collide. Array index is not a safe semantic identity.

### Refinement
The projection architecture must distinguish:
- safe routable identity;
- visible non-routable occurrence identity;
- fully indistinguishable duplicate observations.

For collided visible occurrences, derive presentation occurrence ordering from a canonical safe published tuple/fingerprint plus deterministic duplicate ordinal **after canonical sorting**. The occurrence key is presentation-only and must never become a route or imply underlying identity. If records are indistinguishable after publication, an ambiguity aggregate/count is preferable to inventing distinguishable identities.

All Atlas arrays and map iteration feeding layout must be canonically sorted before projection/layout. Exact goldens assert this.

Status: required addition to #251/#252 implementation.

## Pass 3 — revision coherence vs semantic determinism

### Finding
`DockerSnapshot.modelRevision` is an opaque publication revision and `lastUpdated` is temporal metadata. If either is embedded in the exact semantic `AtlasModel`, equivalent content across refreshes will fail byte-determinism despite identical topology.

### Refinement
Separate the deterministic semantic payload from live revision metadata, e.g. conceptually:

```ts
interface AtlasEnvelope {
  sourceRevision: string | null;
  projectedAtSourceRevision: string | null;
  atlas: AtlasModel; // deterministic from semantic inputs only
}
```

Exact AtlasModel/layout goldens exclude wall-clock timestamps and opaque publication revisions. Revision metadata is used to apply coherent updates and reject stale async results, not to determine topology or coordinates.

Status: required addition to #251/#269.

## Pass 4 — design language and flagship visual quality

### Finding
Current as-built design docs say state dominates and describe the old force/impact graph. Carrying that literally into Atlas would create a field of green and make healthy state visually louder than topology identity.

### Refinement
Atlas-specific exception: normal healthy topology is identity/hierarchy first; health remains truthful but quiet. Attention escalates only when present. Health, freshness, Findings and ambiguity remain orthogonal.

Overview is orientation-first, not edge-first. Secondary relations move to lenses/selected local context. Beauty comes from alignment, whitespace, regular geometry, limited simultaneous color and low connector congestion.

Status: absorbed by #257/#260/#265/#267/#268.

## Pass 5 — graphics/dependency weight

### Finding
The current web package has no graph/layout runtime dependency. Adding React Flow/ELK simply for pan/zoom/layout could increase bundle/maintenance cost while making the product look like a generic editor.

### Refinement
Zero graphics dependency is the baseline to beat. Native HTML/SVG/CSS is preferred if it passes fixtures. Any dependency must materially improve accepted deterministic routing/stability/accessibility and pass security/egress/bundle gates.

Status: absorbed by #253/#263.

## Pass 6 — structural stability

### Finding
A blanket requirement that every unrelated mutation cause zero displacement is unrealistic, while simple seeded determinism is too weak. The existing global force normalization demonstrates why global coordinate churn is dangerous.

### Refinement
Freeze mutation classes:
1. state/freshness/finding only → zero displacement;
2. relation/attachment only → subject anchors fixed;
3. add/remove subject → affected group may reflow only;
4. group/lane change → affected lane may reflow only;
5. lens/theme/viewport → logical coordinates unchanged.

Do not use global min/max normalization.

Status: absorbed by #251/#252.

## Pass 7 — layout complexity and browser denial of service

### Finding
The existing force layout is pairwise repulsion. A 250-object Atlas cannot simply replace one O(n²) global visual algorithm with another and call it bounded.

### Refinement
Projection and base placement should target near-linear/log-linear behavior in subjects plus observed relations (conceptually O(n log n + e)) and use explicit caps for routing/expansion. Any super-linear operation must be bounded to a local affected region with a stress test. #253 freezes measured budgets rather than accepting theoretical claims alone.

Status: absorbed by #253/#263; add explicit complexity assertion to implementation review.

## Pass 8 — provider standardisation

### Finding
Runtime contracts contain containers, systemd services, jobs, PM2 apps, tmux sessions, processes, listeners, package nodes, external APIs and other kinds. Flattening them into one `service` visual lies; giving every provider its own dialect destroys continuity.

### Refinement
#262 defines a provider-neutral presentation taxonomy with primary/context/attachment/inspector-only roles and exhaustive unknown-kind fallback. Provider/layer may organise presentation but does not establish causal architecture.

Status: absorbed by #262.

## Pass 9 — cross-screen continuity

### Finding
Home currently embeds a separate noninteractive ServiceMap while Runtime/Networking/details use different structures. Reusing colors alone will not create continuity.

### Refinement
One topology-subject contract and one safe interaction state model. Home derives a crop/summary from the same Atlas model. Detail screens use the same subject header/local context. Networking/Runtime may remain table/list-heavy but share identity, state, focus, ambiguity and evidence grammar. Lens/subject state may deep-link; coordinates do not.

Status: absorbed by #255/#261.

## Pass 10 — live refresh

### Finding
Even a deterministic snapshot can flicker or temporarily lie if projection/layout results from different model revisions are interleaved.

### Refinement
Projection/layout applies atomically for one coherent source revision. Async work must be revision-gated. State-only updates do not move subjects. Safe selection survives; collision/disappearance fails closed. No physics settling.

Status: absorbed by #269.

## Pass 11 — high-degree topology and connector congestion

### Finding
Network rails can become horizontal spaghetti; dependency lenses can become line carpets. Thin lines do not solve information overload.

### Refinement
Use deterministic aggregation classes and explicit connector/crossing/segment budgets. Overview does not render all edges. Selected context gets priority. When a budget is exceeded, aggregate/focus rather than draw more.

Status: absorbed by #258/#268.

## Pass 12 — accessibility/responsive

### Finding
A spatial flagship can accidentally become mouse/desktop-only even if the rest of DockerMap passes Axe.

### Refinement
Maintain a semantic non-spatial equivalent, keyboard focus/selection/expansion, deterministic focus recovery, 200% zoom, reduced motion and touch. Narrow screens switch to directory + focused topology + inspector rather than shrinking desktop geometry.

Status: absorbed by #250/#256.

## Pass 13 — test governance

### Finding
Pixel screenshots alone are too brittle and too weak: they can fail for antialiasing while missing semantic drift.

### Refinement
Separate exact semantic/layout goldens, numeric geometry tests, controlled screenshot regression and human approval. AI screenshot critique is supplementary only. Intentional layout-version changes explicitly migrate exact goldens.

Status: absorbed by #264/#270.

## Pass 14 — documentation/change control

### Finding
Updating current design docs before the feature ships would make them aspirational and break their stated as-built role.

### Refinement
Keep this prospective architecture separate. #265 updates `DESIGN.md`, `DESIGN_LANGUAGE.md` and screenshots only at accepted cutover.

Status: absorbed by #265.

## Pass 15 — coding structure

### Finding
`ServiceMap.tsx` and `Map.tsx` already combine substantial layout, selection, focus, filter and inspector behavior. Reusing them as the Atlas container would recreate a monolith.

### Refinement
Freeze dependency direction and modules before implementation (#266). Screens do not derive topology. Renderer does not fetch raw APIs. Projection/layout are pure. Closed semantic unions use exhaustive handling.

Status: absorbed by #251/#266.

## Pass 16 — usefulness vs prettiness

### Finding
A deterministic, unclipped, accessible Atlas can still be a poor flagship if users cannot answer basic topology questions quickly.

### Refinement
#260 adds task-oriented usefulness and visual-quality rubrics. Critical facts cannot depend on hover. Measure hierarchy, label legibility, crossings/congestion, simultaneous color, focus/attention salience and continuity. Human approval remains required for the final certified screenshots.

Status: absorbed by #260.

## Pass 17 — first convergence sweep

Re-ran the architecture against:

- hosts with no Compose grouping;
- one giant network;
- many small networks;
- no dependency declarations;
- dense dependency declarations;
- Docker-only hosts;
- host-native-heavy mixed runtime;
- collision/redaction-heavy inputs;
- stale/unavailable provider evidence;
- long/Unicode identities;
- state-only rapid refreshes;
- single unrelated subject additions;
- narrow/touch/200% zoom;
- third-party renderer upgrades;
- screenshot/golden migrations.

No new independent P1/P2 architecture class emerged at that stage. A subsequent deeper repo-grounded sweep deliberately reopened convergence rather than treating this result as permanent.

## Pass 18 — exposure semantics are weaker than the mock-up assumed

### Finding
The generated canonical `ContainerRecord` exposes `ports: string[]`, not a structured `hostIp/hostPort/containerPort/protocol/exposureScope` contract. A visually attractive host-boundary port marker could therefore upgrade opaque display text into a stronger claim such as “externally exposed”.

### Refinement
#259 now requires an exposure authority audit. Atlas may render stronger host-published/bind-scope semantics only from a structured canonical source or a separately approved closed parser/adapter over an authoritative format. Otherwise ports remain observed text/context and the Atlas omits the stronger boundary claim.

Status: absorbed by #259; acceptance fixtures must include opaque/ambiguous port strings.

## Pass 19 — visual containment can fabricate ownership

### Finding
The architecture distinguished evidence-backed groups from no grouping, but it still allowed “lanes/regions” without explicitly protecting against a renderer making those regions look like semantic containment. A box around nodes is itself a claim to most users.

### Refinement
Create two distinct model/presentation concepts:
- semantic group/containment: evidence-backed and attributable;
- presentation lane/region: deterministic organisational scaffolding only.

They require different types and visibly different grammar. Presentation lanes cannot acquire group labels/counts/ownership language that imply membership.

Status: absorbed into #259; #257 must encode the non-semantic lane treatment.

## Pass 20 — inspection scope is not automatically host containment

### Finding
`RuntimeMap` can contain external APIs, DNS/provider context, tailnet/network entities and other subjects that are discoverable while inspecting a host but are not necessarily located on that host. A giant “host” rectangle around all runtime subjects would be false containment.

### Refinement
Use an inspection-scope concept separately from host containment. Place a subject inside a host only when location/containment/runs-on evidence establishes it. Off-host/context/unresolved subjects remain outside or in an explicitly non-containment context region. Discovery source does not establish physical/logical location.

Status: absorbed by #259/#262.

## Pass 21 — duplicate truth across Docker and runtime surfaces

### Finding
`SystemModel` contains both service/Docker records and a runtime model. Multiple surfaces/providers can describe the same underlying container/service/listener. Atlas could either double-render the same thing or incorrectly merge records by label similarity.

### Refinement
#259 now requires a source-correlation matrix. Unification is allowed only through canonical collision-safe identity or explicit backend correlation that proves equivalence. Otherwise keep source-scoped subjects/context distinct. Relation/membership dedupe also requires proven semantic equivalence, not merely matching endpoints. Conflicting correlated facts use explicit source ownership/precedence or a diagnostic; no last-write-wins reconciliation.

Status: absorbed by #259/#262/#252.

## Pass 22 — split-revision fetching could be accidentally reintroduced

### Finding
The current `useSystemModel` is already careful: snapshot and runtime responses publish together only when generation, provenance and non-empty `modelRevision` match. A new Atlas hook that independently fetches runtime/network/graph APIs would bypass that protection and visually combine different publications.

### Refinement
Atlas consumes the coherent model/envelope path and does not independently fetch topology authorities from presentation code. If the authority audit requires data absent from that coherent path, architecture must extend the coherent publication/adaptation boundary first rather than fetch piecemeal in a screen.

Status: absorbed by #259/#269/#266.

## Pass 23 — camera stability is separate from coordinate stability

### Finding
A layout can satisfy every logical-coordinate invariant and still appear to reshuffle if the renderer runs `fitToContent` on every refresh. One unrelated node changes content bounds, changing scale/translation for every visible subject.

### Refinement
#269 now freezes camera state independently:
- deterministic fit only on initial entry or explicit reset;
- routine model revisions preserve camera exactly where context survives;
- focus uses bounded ensure-visible/local-centre behavior;
- lenses preserve camera where meaningful;
- resize may clamp but never mutate logical coordinates;
- Home preview framing is noninteractive and separate from durable Atlas camera.

Tests assert both logical displacement and screen-space/camera displacement.

Status: absorbed by #269/#252.

## Pass 24 — global density settings can undermine spatial continuity

### Finding
DockerMap has a global density setting. If Atlas node dimensions/order/layout are recomputed from compact/cozy CSS measurements, changing density can reshuffle topology even though the infrastructure did not change.

### Refinement
Atlas uses fixed documented spatial geometry or otherwise preserves subject anchor centres/order across density changes. Theme and density never become semantic/layout inputs. Density may affect surrounding directories/inspectors and bounded internal text/padding, but must not cause whole-map re-layout.

Status: absorbed by #269/#257.

## Pass 25 — camera, focus and semantic alternative must share one selection authority

### Finding
The spatial canvas, directory/text alternative and detail inspector could each maintain their own selected subject. This creates split-brain UI state, especially with keyboard navigation, browser back/forward and model revisions.

### Refinement
`useAtlasState` (or equivalent) owns the single semantic selection/lens/expansion/focus target. Canvas, directory, text alternative and inspector are projections of that state. Visual hover may remain ephemeral and local, but selected identity cannot diverge between representations. Route state and model-revision reconciliation flow through the same authority.

Status: add to #261/#266 implementation contract.

## Pass 26 — hidden relations cannot silently disappear from aggregate claims

### Finding
Overview intentionally suppresses most relations. Aggregate cards such as “3 dependencies” can become misleading if the count mixes resolved, unresolved, filtered, stale or unsupported evidence without exposing coverage.

### Refinement
Every aggregate/count must define its population and evidence state. Prefer explicit labels such as `3 resolved declarations · 1 unresolved` over a generic `4 dependencies`. Filtering/lens suppression changes presentation, not the underlying count authority. Ambiguous/unresolved evidence remains separately countable and inspectable.

Status: add to #251/#257/#260/#252.

## Pass 27 — second convergence sweep

Re-ran the hardened architecture against additional failure scenarios:

- opaque port strings that look published but lack structured bind scope;
- the same container represented by Docker and runtime providers;
- two different subjects with identical human labels;
- provider disagreement over correlated subject metadata;
- external API/tailnet/DNS nodes discovered from a host;
- presentation lanes mistaken for evidence-backed groups;
- unchanged Atlas coordinates with auto-fit camera churn;
- density/theme changes during an active inspection;
- selected subject present in canvas but absent from current text filter;
- unresolved relation counts hidden by Overview suppression;
- rapid coherent revisions while selection and camera are active;
- narrow-screen switch between spatial and directory-first representation.

No further independent P1/P2 architecture class emerged after Passes 18–26. Remaining open choices are now explicitly empirical or authority-driven rather than left to implementation taste: source/correlation authority (#259), provider taxonomy (#262), deterministic fixtures/budgets (#252/#253/#268), visual grammar (#257), interaction/camera policy (#261/#269), and acceptance rubric (#260).

## Coding-agent handoff rule

A coding orchestrator should not reason from this ledger ad hoc. It should execute the issue spine in #250 and treat the review-derived children as acceptance gates:

1. close authority/correlation/semantics architecture;
2. build fixtures/properties/rubrics including second-sweep cases;
3. freeze visual grammar, camera behavior and renderer decision;
4. implement Overview behind parallel route using one selection authority;
5. implement bounded attachments/lenses/continuity;
6. certify heterogeneous hosts and cut over.

If implementation requires inventing a new semantic rule not present in `INFRASTRUCTURE_ATLAS.md`, this ledger, or the child issues, stop and reopen architecture rather than improvising in code.
