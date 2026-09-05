# Infrastructure Atlas Architecture

Status: prospective architecture for #250/#251. This document does **not** describe shipped behavior. The as-built design docs remain authoritative until #256/#265 cutover.

## 1. Product objective

The Infrastructure Atlas replaces the current service graph as DockerMap's flagship spatial product. Its job is to make observed infrastructure understandable without inventing architecture.

The Atlas must be:

- truthful: every subject, group, membership, attachment and directional relation has a deterministic source rule;
- deterministic: equivalent canonical evidence produces equivalent projection and logical layout;
- structurally stable: unrelated changes do not globally reshuffle the host;
- useful: a user can locate subjects, exposure, attachments, declared relationships, attention and uncertainty quickly;
- visually restrained: simple HTML/SVG/CSS, strong alignment/hierarchy, low simultaneous color, progressive disclosure;
- continuous: Home, Atlas, Networking, Runtime and detail surfaces reuse one topology identity/interaction language;
- read-only, collision-safe, redaction-safe and bounded.

Runtime AI/LLM involvement is prohibited. AI may assist implementation and review only.

## 2. Repo facts that constrain the design

The current web runtime depends on React, React DOM and React Router; it has no dedicated graph/layout dependency. Zero new graphics dependency is therefore the baseline to beat.

`ServiceMap.tsx` currently owns custom SVG pan/zoom/selection and uses `lib/layout.ts`, a seeded force simulation followed by global min/max normalization. The new Atlas must not inherit the global-normalization failure mode: adding one extreme subject must not move every existing subject.

`Map.tsx` deliberately limits graph relationships to resolved Compose start-order declarations and explicitly states that shared networks/storage are context, not proof of communication or causality. This non-claim is mandatory.

`SystemModel` contains useful collision-safe services, networks, volumes and runtime records, but `ServiceKind` is heuristic classification. It is never topology authority.

The canonical `ContainerRecord` currently contains id/name/role/image/status/ports/networks/mounts/dependsOn but no Compose project identity. V1 therefore cannot assume project grouping. Project grouping is optional only if #259 identifies a trustworthy existing source; otherwise Docker subjects remain ungrouped or use a provider-neutral presentation taxonomy.

Runtime contracts contain many distinct node/provider kinds. Atlas must not flatten them all into fake generic services.

## 3. Source authority gate

Before implementation, #259 must produce an authority matrix for `DockerSnapshot`, `SystemModel`, `RuntimeMap`, `/api/graph`, and relevant Compose surfaces.

For every Atlas object class, record:

1. authoritative source;
2. stable/collision-safe identity;
3. whether direction or causality is actually established;
4. source/evidence reference form;
5. freshness/availability semantics;
6. safe route/focus identity.

Prefer a narrow frontend adapter over existing authorities. Do not expand backend contracts only to satisfy a preferred diagram.

## 4. Presentation-domain model

The exact TypeScript names may change only in the #251 architecture PR. The model must remain closed and serialisable.

```ts
interface AtlasModel {
  projectionVersion: number;
  subjects: AtlasSubject[];
  groups: AtlasGroup[];
  relations: AtlasRelation[];
  memberships: AtlasMembership[];
  attachments: AtlasAttachment[];
  aggregates: AtlasAggregate[];
  diagnostics: AtlasDiagnostic[];
  stats: AtlasStats;
}
```

### Subject
A routable or visible infrastructure identity. It carries provider/kind metadata plus **separate** operational state, freshness, attention and ambiguity fields.

### Group
Exists only when a trustworthy source establishes grouping. No fuzzy grouping, image-name clustering or inferred architecture.

### Relation
Directional only when the source establishes direction. Compose start-order and qualifying runtime evidence are examples; shared network/storage membership is not.

### Membership / attachment
Non-causal context such as network membership or storage attachment.

### Aggregate
A bounded deterministic presentation object for high-degree structures. Aggregation may reduce detail but must propagate material child attention/ambiguity/exposure counts.

### Diagnostic
Represents unsupported, unresolved, collided or otherwise non-routable presentation evidence without selecting an arbitrary endpoint.

Every projected object carries a named/versioned projection rule and bounded source reference. Renderer-specific geometry does not enter AtlasModel.

## 5. Orthogonal state model

Never collapse these concepts into one status color:

- operational state/health;
- provider/evidence freshness;
- Findings/attention severity;
- identity ambiguity/collision.

A healthy subject observed through stale evidence is not automatically unhealthy. A healthy subject with a Finding is not degraded. A collision is not a health failure.

Compact aggregate summaries may define explicit precedence for markers/text, but the underlying fields remain separate and fixtures cover cross-products.

## 6. Provider-neutral presentation taxonomy

#262 must exhaustively classify supported runtime kinds into one of:

- primary spatial subject;
- secondary/context subject;
- membership/attachment object;
- inspector-only evidence;
- unsupported/neutral fallback.

The taxonomy preserves provider truth. `runtime.layer` and provider names may organise presentation but never become causal architecture by themselves. Unknown future kinds fail closed to neutral/unsupported presentation.

## 7. Logical layout contract

The layout consumes AtlasModel only.

### Required invariants

- logical coordinates are viewport/theme independent;
- group/lane ordering is canonical;
- local subject ordering is canonical;
- content uses fixed documented geometry classes; long text does not change global topology;
- no random, time, DOM measurement or AI input;
- no global min/max normalization;
- lens changes preserve canonical subject coordinates;
- focus expansion is local, deterministic and reversible.

### Structural-stability classes

1. state/freshness/finding-only mutation: zero subject displacement;
2. relation/attachment-only mutation: subject anchors unchanged; affected connector/aggregate region may change;
3. add/remove subject within a group: affected group may reflow; unrelated group anchors/order remain stable;
4. group/lane creation/removal: affected lane may reflow; unrelated lanes preserve order and bounded anchors;
5. viewport/theme/lens change: logical coordinates unchanged.

#252 turns these into property tests and freezes a numeric displacement budget where exact zero is not appropriate.

The preferred family of algorithms is deterministic lanes/regions/slots with local reflow. A third-party layout library is not architecture by default.

## 8. One Atlas, multiple lenses

Canonical logical placement is shared by:

- Overview;
- Connectivity;
- Dependencies;
- Storage;
- Runtime;
- Attention.

Lenses alter emphasis, secondary visibility and inspector content. They do not rebuild the host into unrelated maps.

### Overview
Orientation-first, not edge-first. Prioritise host/group/subject placement, identity and material attention. Do not draw every relation. Secondary relationship detail appears in a lens or selected local context.

### Connectivity
Shows bounded network membership, published host bindings and other explicitly evidenced connectivity context. Membership is not traffic.

### Dependencies
Shows only genuinely directional evidence. Dense relation sets obey #268 congestion/aggregation rules.

### Storage
Shows volumes/bind/storage attachment without implying data direction.

### Runtime
Adds provider-neutral host/runtime context according to #262 rather than flattening unlike runtime objects into containers.

### Attention
Overlays existing Findings/attention/freshness/ambiguity without creating new topology semantics.

## 9. High-degree policy

Networks, storage, ports, dependencies and large groups use deterministic aggregation classes. Thresholds are named/versioned constants established from #252/#253 fixtures.

A threshold transition may reflow the affected structure only. It must not globally rearrange the host. Selected subjects/networks may expand local detail deterministically.

No runtime aesthetic heuristic chooses between rail/card/aggregate forms.

## 10. Visual grammar

#257 owns exact geometry/tokens. Architecture requires:

- neutral topology by default;
- identity/hierarchy dominates normal healthy views;
- healthy state is quiet rather than a field of green;
- attention becomes prominent when present;
- Hearth Azure for action/focus;
- AI Purple only for AI;
- non-color cues for every semantic distinction;
- technical mono only for technical values;
- compact fixed geometry classes;
- deterministic label wrap/truncate plus full-value access;
- no decorative gradients, glass, glow, particles, animated traffic or physics settling;
- no rainbow project/network palette.

Relationship grammar:

| Class | Direction | Default presentation |
| --- | --- | --- |
| evidenced dependency | as evidenced | restrained directed connector in dependency/focus context |
| network membership | none | membership/rail/aggregate |
| storage attachment | none | attachment/aggregate |
| published host port/socket | binding only | host-boundary marker |
| provider/runtime membership | none unless source says otherwise | context/grouping |
| unresolved/collided | none | visible non-routable uncertainty |
| heuristic kind | none | icon/search metadata only |

#268 freezes edge-routing and congestion budgets. When the budget is exceeded, aggregate/focus; do not draw more lines.

## 11. Cross-screen continuity

Continuity is semantic and interaction-level, not merely matching colors.

The same safe subject retains:

- canonical display identity;
- provider/kind glyph family;
- state/freshness/attention/ambiguity semantics;
- selected/focused treatment;
- route/focus target where safe;
- evidence language.

Home uses a crop/summary of the same Atlas model, not an independent mini-map algorithm. Networking/Runtime may remain list/table-heavy where clearer but reuse the same subject contract. Detail screens may show a compact subject header/local context rather than a separate graph.

#261 freezes URL/lens/selection/expansion/focus state. Durable state stores semantic identities, never layout coordinates.

## 12. Live refresh

#269 freezes refresh behavior:

- one coherent model revision projects/layouts atomically;
- no half-updated layout;
- state-only changes do not move subjects;
- safe surviving selection remains;
- removed/collided selection fails closed with deterministic focus recovery;
- no physics settling or decorative exit animation;
- pan/zoom is preserved/reset only by explicit context policy.

## 13. Renderer decision

#253 compares the same fixtures across native SVG/HTML and any justified third-party candidate.

A dependency must materially beat the zero-dependency baseline on deterministic routing/stability, accessibility, maintainability and accepted visual quality while staying inside bundle/runtime/security budgets. Reject a library that mainly replaces simple pan/zoom/selection.

Any selected dependency is pinned and cannot add runtime egress, telemetry, remote assets/fonts, unsafe HTML, WASM or workers without separate approval.

## 14. Module ownership

Target dependency direction:

```text
screens
  ↓
atlas presentation + interaction
  ↓
renderer/lenses  → deterministic layout
        \             /
         AtlasModel/projection
                 ↓
       existing model/contracts
```

Suggested implementation map:

- `apps/web/src/lib/atlas/types.ts`
- `apps/web/src/lib/atlas/source.ts`
- `apps/web/src/lib/atlas/project.ts`
- `apps/web/src/lib/atlas/rules.ts`
- `apps/web/src/lib/atlas/layout.ts`
- `apps/web/src/lib/atlas/layoutPolicy.ts`
- `apps/web/src/lib/atlas/version.ts`
- `apps/web/src/components/atlas/*`
- `apps/web/src/components/atlas/lenses/*`
- `apps/web/src/hooks/useAtlasState.ts`
- `apps/web/src/lib/atlas/__fixtures__/*`

Rules: pure projection/layout where possible; closed unions; exhaustive switches; stable keys; bounded work; no screen-local topology derivation; no renderer→raw API dependency. `ServiceMap.tsx` remains legacy until cutover.

## 15. Test architecture

#252 builds designed adversarial fixtures plus property generation across subject counts, grouping absence/presence, sparse/dense/cyclic declarations, high-degree/multi-membership networks, storage patterns, mixed providers, ports, collisions, long/Unicode labels, orthogonal states/freshness, and controlled mutations/permutations.

Exact semantic/layout goldens are separate from browser geometry and screenshots (#270):

1. exact AtlasModel/layout JSON;
2. numeric geometry assertions;
3. controlled screenshot matrix;
4. human approval for intentional visual redesign.

Screenshot or AI visual review cannot authorize semantic change.

## 16. Usefulness and visual-quality gates

#260 freezes task-oriented acceptance: locate a subject, attention, host-published exposure, network/storage membership, a recorded dependency, ambiguity, and the boundary of unknown evidence without critical facts depending on hover.

Visual rubric covers hierarchy, alignment, whitespace/rhythm, label legibility, connector congestion/crossings, simultaneous color count, group distinguishability, selected/focus clarity, attention salience and continuity with adjacent screens.

## 17. Security and bounds

#263 treats all observed labels/metadata as untrusted presentation input. No raw argv/env/secret promotion; no raw value→CSS class/style channel; bounded strings/object/edge/segment counts; safe text rendering; collision/redaction preserved; screenshot fixtures contain no live secrets.

The 250-object fixture is a stress gate, not permission for unbounded O(n²) behavior. Expansion/routing work has explicit caps.

## 18. Accessibility/responsive

#35/#67 remain the floor. Required: keyboard operation, visible non-state focus, deterministic focus recovery, semantic text/table alternative, 200% zoom, reduced motion, touch targets, Axe/manual keyboard evidence.

Narrow screens switch to directory + focused local topology + inspector rather than shrinking the desktop Atlas until unreadable.

## 19. Version/change control

#264 owns internal projection/layout policy versioning. Intentional rule changes update exact goldens with explicit review. Dependency upgrades cannot silently churn coordinates. Do not make internal layout version a public API promise unless separately justified.

## 20. Implementation spine

1. #259/#251/#262/#267/#266: authority + semantics + taxonomy + state + module freeze.
2. #252/#260/#270: fixtures, property/usefulness/golden harness.
3. #257/#268: visual grammar and congestion policy.
4. #253/#263/#264: renderer, security/dependency and version decision.
5. #254: projection/layout + Overview behind parallel route/feature gate.
6. #258: bounded high-degree connectivity/storage/port projection.
7. #261/#269/#255: route/revision continuity, lenses and cross-screen integration.
8. #256/#265: heterogeneous-host certification, cutover and as-built docs.

Do not collapse this into one implementation PR.

## 21. Review convergence

Before #251 closure, hostile passes must cover truth/authority, determinism/stability, provider taxonomy, design language, information architecture, coding boundaries, dependency/performance, accessibility, security, cross-screen state, high-degree geometry, live refresh, test governance and documentation control.

A pass is converged when it produces no new independent P1/P2 architecture requirement and every prior finding is represented here or in a child issue.
