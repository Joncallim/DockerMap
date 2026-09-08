# Atlas Visual Policy

Status: prospective policy for #257, #268, #260 and #270. It freezes the
visual and acceptance contract that #254 must implement after the authority,
fixture, and renderer gates. It does not describe a shipped Atlas, add a
topology fact, or replace the as-built design documentation.

The Atlas is an orientation tool: it helps a person find an observed subject
and understand supported context without turning every observed record into a
diagram claim. `INFRASTRUCTURE_ATLAS.md` remains authoritative for projection,
source provenance, collision handling, and logical layout.

## 1. Inputs and non-claims

The production view consumes one coherent `AtlasEnvelope`/`AtlasModel` and its
logical layout. A renderer, lens, screenshot fixture, or text alternative must
not fetch or join raw APIs, Compose data, `/api/graph`, or a second publication.
It must not create an edge, group, membership, host boundary, or identity that
is absent from the model.

| Model item | Permitted visual meaning | Prohibited visual meaning |
| --- | --- | --- |
| `AtlasGroup` with structural membership evidence | semantic membership/containment | a group inferred from labels, providers, images, or proximity |
| `AtlasLane` | alignment scaffold only | a box, title, count, ownership copy, or boundary suggesting membership/host placement |
| evidenced relation | recorded directional declaration | traffic, readiness, health, reachability, or causality |
| membership/attachment | recorded non-causal context | communication or data direction |
| opaque `ContainerRecord.ports` text | bounded observed text in the directory/inspector only | an attachment, relation, or host/external/bind/protocol/reachability claim |
| closed `docker_port_publication` runtime-edge evidence | recorded port-publication context attached to its proved container/listener endpoints | host/external/bind/protocol/reachability claim |
| non-routable diagnostic | bounded uncertainty | a selectable endpoint or a guessed identity |

V1 has no supported semantic groups, so `groups` are `[]`. A V1 renderer must
not reserve or draw a containment region merely to make the map look tidier.
Lanes use whitespace, alignment, and a low-emphasis non-interactive guide only;
they have no enclosing stroke, title, or count. A future evidenced group uses a
distinct header/boundary only after its source-contract change is accepted.

Operational state, freshness, Finding attention, and ambiguity are independent
visual channels. Healthy is quiet. Attention and ambiguity receive the strongest
non-colour marker; freshness is secondary metadata; operational state is
truthful but never a field of healthy-green cards. No channel changes another
channel's meaning.

The non-colour vocabulary and composition order are closed. Each present marker
also occurs in the subject's accessible name and text alternative, in this order:
safe identity, attention, ambiguity, operational state, then freshness. The
same order applies to the fixed visual marker row after the identity: attention
uses an outlined (advisory) or filled (warning) triangle; ambiguity uses a
cross-hatched diamond (collision), broken-link diamond (unresolved), or hollow
diamond (unsupported); operational state uses check (healthy), outlined pause
(warning), filled diamond (degraded), square (offline), segmented static ring
(updating), or question mark (unknown); freshness uses solid clock (fresh),
dashed clock (stale), hourglass (timed out), slashed clock (unavailable), minus
(disabled), or question mark (unknown). A compact card may visually prioritise
attention and ambiguity before state/freshness, but it cannot hide the latter
from the immediately adjacent keyboard directory/text alternative. These glyphs
are not colour-only, are never animated, and do not alter the field values.

## 2. Frozen visual grammar and geometry

This renderer-neutral token set uses logical CSS-pixel-equivalent units at the
1× test viewport. Values are not obtained from font measurement, theme,
application density, or browser layout. The selected SVG/HTML hybrid may use
HTML for the keyboard directory and text alternative, but the same tokens govern
its SVG topology.

| Token | Value | Rule |
| --- | ---: | --- |
| compact subject | 46 × 30 | overview/compact subject hit and visual box; matches the frozen logical layout class |
| default subject | 92 × 56 | focused directory/inspector companion; never reanchors the logical subject centre |
| focused subject | 92 × 56 + 2 ring | presentation-only expansion; does not relayout neighbours |
| subject radius | 6 | neutral surface; no decorative glass, glow, or gradient |
| subject gap | 18 | logical row/column clearance; labels and connectors respect it |
| lane gap | 96 | whitespace/alignment only; never a semantic boundary |
| semantic-group inset (future only) | 16 | applies only to an evidenced `AtlasGroup`; V1 must not render it |
| semantic-group header (future only) | 24 high | has an evidence-aware label and looks unlike a lane guide |
| connector / selected stroke | 1 / 2 | evidence connector and selected/local-context emphasis |
| focus ring | 2 | Hearth Azure action/focus treatment plus a visible shape/outline cue |
| subject label | 1 line overview; 2 lines focused | 96 safe display characters maximum; deterministic ellipsis; full safe display available without hover |
| connector label | none by default | show safe evidence/context in selected inspector or directory, not line-label clutter |
| attachment / aggregate | compact rail, chip, or count card | population wording exposes resolved, unresolved, ambiguous, and omitted portions where present |

Hearth alignment is role-based, not a topology palette: neutral topology is the
default; Hearth Azure denotes action/focus; AI Purple is reserved for actual AI
subjects; health colours retain their existing health role. No network, project,
provider, or lane receives a rainbow colour. Every distinction has a non-colour
cue: text, icon/shape, line style, or accessible name.

Global compact/cozy density may alter surrounding directories, inspector
padding, and bounded typography. It must not change subject logical centres,
canonical order, lane assignment, connector order, or camera state. Theme also
cannot change those inputs. Reduced motion removes optional transition feedback
without losing focus, selection, attention, or uncertainty; there is no physics
settling, animated traffic, pulsing healthy state, particles, glow, or decorative
animation.

## 3. Lenses, disclosure, and continuity

Overview is identity-first orientation, not an edge view. It renders subjects,
selected/local context, material attention/ambiguity, and only bounded markers
the model supports. It does not draw every relation by default. The active lens
and selected subject are semantic state shared by spatial view, keyboard
directory, text alternative, and inspector; hover is ephemeral and cannot be
the only way to learn a critical fact.

| Lens or surface | Default detail | On selection/focus | Must not imply |
| --- | --- | --- | --- |
| Overview / Home crop | identity, quiet state, attention/ambiguity, lanes | bounded local supported context | separate topology algorithm or full edge set |
| Dependencies | bounded directional declarations | selected/local declared relations and evidence context | traffic, readiness, or causality |
| Connectivity | bounded membership and closed-evidence port context | selected/local network and port attachment; opaque port strings stay observed text in inspector | network communication or host exposure |
| Storage | bounded attachment/aggregate context | selected/local storage context | data direction |
| Runtime | provider/kind context | safe provenance and independent freshness | containment or cross-source merge |
| Attention | existing attention/freshness/ambiguity overlay | inspectable supported reason/context | a new edge or health rewrite |
| Detail / directory / text alternative | same safe identity and markers | local context and safe evidence language | divergent selection or hidden hover-only fact |

Narrow layouts switch deterministically to a directory, focused local topology,
and inspector. They do not shrink the desktop map until labels or touch targets
fail. Camera coordinates are not route state. Selection persists only while the
exact routable key survives the coherent revision; collision, removal, or
unresolved identity fails closed with deterministic focus recovery.

## 4. Deterministic routing and congestion policy

The selected hybrid is an SVG topology plus an HTML directory; it does not
delegate routing to a graph library. Routing is a pure function of the model,
layout, active lens, selected safe key, and policy version.

1. Map only the following closed evidence/relationship pairs into routing
   classes: `docker_compose_depends_on`/`depends_on`, `systemd_requires`/
   `requires`, `systemd_wants`/`wants`, and `systemd_part_of`/`part_of` are
   directed declaration relations; `docker_network_membership`/`connected_to`,
   `docker_volume_mount`/`mounts`, `docker_port_publication`/`exposes`, and
   `docker_daemon_state_bind_mount`/`exposes_daemon_state` are non-causal
   attachments. The port attachment means only recorded context between proved
   runtime endpoints. Opaque `ContainerRecord.ports` text never enters routing.
   All other combinations are rejected from Atlas routing rather than guessed.
2. Canonically sort candidates by routing class, source key, target key, rule,
   and `atlas-v1/evidence-sort-1` before allocating a route. That sort key is
   the `JSON.stringify` array serialization of `[provider, kind, assertionKind,
   freshness, id, providerRevision, providerSlot-or-empty, subjectRef, summary,
   collectedAt-as-decimal-string, version-as-decimal-string]`; arrays of evidence
   keys sort lexicographically and are joined with U+0002. A field/order or
   serialization change requires a new named sort-policy version and exact
   golden review.
3. Allocate selected/local-context relations first, then remaining candidates
   in that order. A selected relation never bypasses collision, evidence, or
   global safety caps.
4. Use a fixed side/port and deterministic offset for parallel compatible
   routes. A route has at most three orthogonal segments; a direct route has
   one. Bundle only relations with identical source, target, direction, and
   relation class, and expose a stable bundle population.
5. A connector may enter an interactive subject rectangle only at its endpoint.
   It must not traverse another subject interior or obscure an interactive label
   or focus ring. A future semantic-group crossing gets an explicit ingress/
   egress marker; V1 has no group boundary to cross.
6. Edge labels are absent by default. Selection, directory, or inspector shows
   safe evidence/context instead of line-label clutter.
7. If a candidate would exceed a limit or has no legal route, omit it from the
   spatial layer and represent the bounded remainder through aggregate/count or
   focused local context. This is not silent: population wording states resolved,
   unresolved, ambiguous, and omitted values. The renderer may not choose an
   aesthetic unbounded alternative.

The canonical logical routing region is a lane-local tile of eight fixed
columns by five fixed rows, using the frozen 46 × 30 subject box, 18 subject
gap, and 96 lane gap. Its key is the canonical provider×role lane ordinal plus
`floor(subject-row / 5)`. This region exists only for routing/congestion
accounting; it is not a visual lane label, group, containment, or host claim.
The controlled test viewport is the canonical region plus its 18-unit clearance
on every side. Each viewport budget below applies to the union of its visible
regions, while each region budget applies independently to every intersecting
logical routing region.

A crossing is two non-endpoint connector segments intersecting in the visible
region; a route touching its own endpoint is not a crossing. Routed segments
are displayed segments after bundling, not source declarations. The existing
#253 80-item relation/attachment class cap limits the largest two sizes.

| Fixture subjects | connectors / viewport | crossings / viewport | segments / viewport | connectors / region | crossings / region | segments / region | selected/local reservation | Required reduction |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 25 | 24 | 4 | 72 | 12 | 2 | 36 | up to 8 | aggregate/focus secondary relations |
| 100 | 80 | 12 | 240 | 16 | 3 | 48 | up to 16 | aggregate/focus secondary relations |
| 250 | 80 | 12 | 240 | 16 | 3 | 48 | up to 16 | aggregate/focus secondary relations |

Attachments, relations, and aggregates retain their independent #253 caps of
80 each; the visible-connector cap above applies to all line-like relation and
attachment forms together. The lower applicable bound wins. Apply caps before
creating routes, SVG paths, or DOM nodes. Rejection/aggregation order is
canonical, so input permutation cannot swap surviving detail.

The harness asserts at 25, 100, and 250 subjects that emitted routes satisfy
the rectangle rule, canonical order, both viewport and every-region
connector/crossing/segment limits, and bounded DOM/SVG work; state-only changes
keep route allocation and subject anchors stable; and a local relation change
affects only its local route/aggregate region. Browser geometry may use a
documented 0.5 px tolerance only where the browser measures geometry, never for
logical route policy.

## 5. Measurable usefulness and visual-quality gate

Each certified fixture and representative real-host capture is assessed using
these tasks. An activation is a keyboard/pointer selection, lens/filter action,
or navigation to visible text alternative; hover does not count. All tasks must
work by keyboard and pointer.

| Task | Evidence of success | Maximum activations | Hover-only allowed? |
| --- | --- | ---: | --- |
| Locate a named safe subject | visible subject or directory item with same identity | 2 | no |
| Locate attention | non-colour attention cue and subject identity | 1 | no |
| Inspect port context | either a closed-evidence attachment or bounded opaque inspector text, each explicitly observed and never an exposure claim | 2 | no |
| Inspect network/storage membership | non-causal wording and population | 2 | no |
| Inspect recorded dependency | directional-declaration wording and safe evidence context | 2 | no |
| Inspect unresolved/ambiguous evidence | non-routable cue plus stated uncertainty boundary | 2 | no |
| Establish what is not known | unsupported/omitted/disagreement wording and population where applicable | 2 | no |

A missing/wrong result, hover-only disclosure, excess activation, or inaccessible
keyboard/text path fails the gate. A fixture without a fact is **not applicable**;
the certification matrix still requires a fixture or real-host capture covering
each applicable fact.

Score every visual criterion 0, 1, or 2 from recorded screenshot and geometry
evidence. Two meets the definition; one is visible but non-critical defect; zero
is material failure. Pass requires at least 18/20, no zero in a critical † row,
and no task-gate failure.

| Criterion | Score 2 definition |
| --- | --- |
| Hierarchy † | identity/structure reads first; material attention/ambiguity next; provider/context/evidence secondary |
| Alignment | subjects use logical slot centres; no drift beyond 0.5 px browser-measurement tolerance |
| Whitespace/rhythm | fixed gaps remain; no subject, marker, route, or label violates clearance |
| Label legibility † | line limits hold; truncation is deterministic; complete safe display is available without hover |
| Connector congestion † | routing limits hold; no connector crosses a non-endpoint interior or obscures focus/interactive label |
| Simultaneous colour | at most four non-neutral semantic colour roles; each also has non-colour cue |
| Group/lane distinction † | V1 lanes have no containment grammar; future groups require structural evidence and distinct grammar |
| Selection/focus clarity † | one target is unambiguous, visible, keyboard-reachable, and mirrored in directory/text/inspector |
| Attention salience † | every material attention/ambiguity item has a non-colour cue without healthy-state dominance |
| Cross-screen continuity | equivalent safe identity, glyph, state/freshness/attention/ambiguity, and focus treatment match adjacent surface |

AI screenshot critique may identify a possible defect, but cannot pass a
criterion, change a score, authorize semantic change, or replace human approval.
A human/maintainer records rubric, failures, and approved intentional redesign
alongside the certified baseline update.

### Selected-hybrid performance and bundle promotion evidence

Before #254 promotes the selected SVG/HTML hybrid from the fixture spike to a
route, it must create and approve `atlas-v1/hybrid-perf-baseline-1`. For the
exact 25, 100, and 250-subject named fixtures, the artifact records fifteen
warmed mount and selected-subject-update samples per run, and the median of the
three run p95 values for each operation. It also records the controlled browser
revision, browser flags, font environment, CPU/runner class, build mode, fixture
revision, renderer policy version, and source revision. Projection/layout timing
remains diagnostic; mount and selected-subject update are the promotion gates.

The production candidate passes each size/operation only when its controlled
median-of-three p95 is no more than `max(baseline × 1.25, baseline + 2 ms)`.
The check runs only in a pinned, dedicated browser benchmark job, after a clean
production build, and is not a timing assertion in a shared/local unit-test
command. Three complete controlled runs are required; a runner-health failure
invalidates the run rather than producing a retry-until-green result. Changed
fixture, browser, policy, or runner class creates a new named baseline with
maintainer review instead of comparing unrelated machines.

The same promotion evidence includes `atlas-v1/hybrid-bundle-baseline-1`: the
production-build manifest and gzip sizes for the Atlas route entry and its
transitive chunks, plus the zero added-runtime-dependency proof. The candidate
may add no runtime package dependency and may increase the recorded Atlas route
gzip total by no more than `max(2 KiB, 10%)`. A deliberate exception requires a
new baseline, measured justification, security review where applicable, and
maintainer approval; it is not hidden in a screenshot or timing change.

## 6. Golden, geometry, screenshot, and approval governance

These layers test different things and cannot substitute for one another.

| Layer | Authority | Comparison rule | Required change control |
| --- | --- | --- | --- |
| Semantic golden | exact `AtlasModel` | byte-exact canonical JSON | explicit projection/source-policy review; screenshots cannot authorize it |
| Logical-layout golden | exact canonical points/layout policy | byte-exact canonical JSON | explicit layout-policy/version review |
| Browser geometry | mounted controlled renderer | numeric assertions; 0.5 px only for browser-measured geometry | update assertion with bounded-policy reason |
| Screenshot baseline | controlled browser/theme/viewport/fixture/font | visual diff is a signal, not semantic oracle | human/maintainer approval plus rubric result |
| Human review | certified screenshot and task/rubric record | approve/reject intentional visual redesign | cannot waive truth, redaction, accessibility, collision, or caps |

Semantic/layout goldens exclude timestamps, model revisions, live-host data,
secrets, raw metadata, and browser output. A projection or layout policy-version
change updates its exact golden deliberately and records why. Dependency upgrades
cannot silently rewrite those artifacts. Screenshot approval alone never changes
semantic or source authority.

The first #254 representative screenshot matrix has exactly twelve controlled
cells. Every named family below has both light and dark coverage; the paired
cells deliberately combine only orthogonal hazards so the suite stays small:

| Fixture family | Light cell | Dark cell | Why this is a permitted combination |
| --- | --- | --- | --- |
| empty orientation | desktop 1× | desktop 1× | proves no-data composition without inventing topology |
| collision/non-routable | desktop 1× | desktop 1× | collision is a non-routable diagnostic, not a separate topology family |
| long label + mixed provider | 200% zoom desktop | 200% zoom desktop | stresses label disclosure and provider-neutral grammar without claiming correlation |
| dense relation | desktop 1× | desktop 1× | exercises canonical reduction and routing budget |
| high-degree attachment | desktop 1× | desktop 1× | exercises aggregate/count grammar independently of relation causality |
| attention + freshness + unknown | narrow touch | narrow touch | exercises the closed independent-marker order under constrained presentation |

The six paired rows total 12 cells. They cover empty, collision/non-routable,
long label, mixed provider, dense, high-degree, attention, freshness, and
unknown states across light/dark, 200% zoom, and narrow-touch modes. Property
fixtures cover permutations and hostile inputs; do not baseline every
permutation.

Each cell records fixture revision/name, renderer/policy versions, browser and
font environment, viewport/zoom/theme, active lens, selection state, date,
reviewer, task results, rubric score, and approval. Checked-in screenshots and
metadata contain no live host, secret, raw path, raw identity, or unredacted
evidence.

## 7. #254 entry checklist

#254 is not ready to claim an Overview implementation until all are true:

- [ ] The authority/correlation boundary is unchanged and the route consumes
      one coherent model publication.
- [ ] #252 semantic/layout fixtures and cap invariants pass, including
      collision, omission, long-label, and orthogonal-state cases.
- [ ] #253's selected SVG/HTML hybrid and zero-dependency, 80-item, and
      250-subject caps remain in force; no route silently changes policy.
- [ ] This grammar is implemented without lane containment, default relation
      spaghetti, host-exposure claims, raw identity leaks, or collapsed state.
- [ ] The routing harness covers the 25/100/250 table and aggregates/focuses
      deterministically before DOM/path creation, enforcing viewport and region
      caps.
- [ ] `atlas-v1/hybrid-perf-baseline-1` and
      `atlas-v1/hybrid-bundle-baseline-1` meet their controlled 25/100/250
      mount/update and bundle thresholds.
- [ ] Exact semantic/layout, browser geometry, and the named 12-cell controlled
      screenshot layers exist separately, with completed human rubric/approval
      evidence.
- [ ] Keyboard, visible focus, text alternative, 200% zoom, reduced motion,
      narrow/touch behaviour, existing web tests, and relevant e2e/a11y gates
      have production-route evidence.

Passing this checklist authorizes only a parallel/feature-gated Overview route.
The legacy Service Map remains available until later cutover and heterogeneous-
host certification work has its own evidence.
