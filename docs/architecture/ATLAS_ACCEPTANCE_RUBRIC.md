# Atlas Acceptance Rubric

This rubric says how a maintainer can decide whether a proposed Atlas view is
both useful and visually clear without relaxing DockerMap's evidence boundary.
It is an acceptance gate for #260, not a promise that all listed browser,
capture, or real-host evidence exists today. The current shipped route and
fixture work remain the source of truth for what is implemented.

Status: prospective acceptance policy for #250/#260. It supplements
[Infrastructure Atlas Architecture](./INFRASTRUCTURE_ATLAS.md), the selected
renderer decision for #253, [Atlas Visual Policy](./ATLAS_VISUAL_POLICY.md)
(#257), its congestion rules (#268), and the certified-capture/review policy
for #270. Those documents control if this rubric conflicts with them.

## 1. Safety and certification boundary

Each certification starts with one coherent, revision-matched `AtlasEnvelope`.
The acceptance harness and reviewer may inspect its safe projected output and
the explicitly approved capture only. They must not fetch/join raw APIs,
Compose files, `/api/graph`, runtime records, Findings, labels, or DOM-derived
identities to make a task pass.

- Safe routable identity is an exact published key; a display name is never a
  fallback route key.
- Collision, unresolved, unsupported, omitted, and disagreement material stays
  visible as bounded, non-routable uncertainty. It must not become a selectable
  target through name, index, image, role, or label matching.
- V1 semantic `groups` are `[]`. Alignment lanes are not group regions and may
  not be scored as containment, ownership, host placement, or membership.
- Opaque `ContainerRecord.ports` strings are display text only, in a bounded
  directory or inspector. They do not prove host publication, externality,
  bind scope, protocol, or reachability. A closed runtime-edge
  `docker_port_publication` record may be shown only as **recorded
  port-publication context** between its proved endpoints, with the same
  non-claims.
- A relation is shown as a dependency only when the enabled lens exposes a
  closed directional declaration. Shared network/storage context is never
  communication, traffic, causality, readiness, or data direction.

Synthetic fixtures are the normal deterministic certification input. A real
host capture may cover an additional case only after the operator explicitly
approves that capture, verifies redaction, records its source/revision and
capture procedure, and accepts that it is observational evidence rather than a
semantic oracle. No fixture or capture may include secrets, raw evidence/source
references, raw metadata, or unredacted host data.

## 2. Task-completion gate

An activation is one keyboard or pointer select, expand, lens/filter change, or
navigation to an already-visible text alternative. Scrolling, reading, and
changing focus inside an already-open control do not count. Hover, tooltip,
colour alone, and a hidden raw-data inspector do not count. Every applicable
task must work by keyboard and pointer; its critical fact must be available in
visible text or the immediate keyboard directory/text alternative without
hover.

| Certified task | Required evidence of completion | Maximum activations | Required fixture/capture |
| --- | --- | ---: | --- |
| Find a named subject | Same safe display identity in the spatial view or directory, with an exact safe selection path when routable | 2 | named routable subject |
| Find attention | Subject identity plus the non-colour attention marker/text | 1 | advisory or warning subject |
| Inspect recorded port context | Bounded opaque port text **or** a closed port-publication attachment, explicitly labelled recorded context and carrying no exposure claim | 2 | opaque port text and/or recorded context |
| Inspect network or storage context | Subject/context identity, non-causal wording, and a bounded population where aggregation applies | 2 | network and storage attachment cases |
| Inspect a declared dependency | Directional-declaration wording and both safe endpoints, only in an enabled dependency lens | 2 | closed declared dependency; otherwise not applicable |
| Inspect ambiguity | Non-routable cue/text and the reason it cannot be safely focused | 2 | collision or unresolved diagnostic |
| Establish the unknown boundary | Unsupported, omitted, disagreement, or unresolved wording and population/count where applicable | 2 | unknown-boundary diagnostic |

A task fails if it returns the wrong subject/fact, needs more activations,
requires hover, lacks a keyboard or pointer route, leaks prohibited source
material, or makes a forbidden topology claim. A fact absent from a fixture is
not applicable to that fixture, but release certification must include at least
one approved fixture or approved real-host capture for every row above.

## 3. Measurable visual-quality gate

For every certified fixture/capture, collect deterministic geometry/DOM
assertions and a screenshot at the controlled viewport defined by the visual
policy. A maintainer scores each criterion 0, 1, or 2: 2 meets the definition,
1 is a visible non-critical defect, and 0 is a material failure. Passing needs
at least 18/20, no 0 in a daggered row, and every applicable task gate above.

| Criterion | Score 2 definition |
| --- | --- |
| Hierarchy † | Safe identity and structural orientation read first; attention/ambiguity read next; state/freshness/context stay secondary. |
| Alignment | Subject centres obey the logical slots; browser-measured drift is at most 0.5 px. |
| Whitespace/rhythm | Frozen gaps and clearance remain intact; no subject, marker, route, or label overlaps another interactive target. |
| Label legibility † | Fixed line/truncation rules hold; the complete safe display is available without hover. |
| Connector congestion † | #268 viewport/region connector, segment, and crossing budgets hold; no route crosses a non-endpoint interior or obscures a focusable label. |
| Simultaneous colour | At most four non-neutral semantic colour roles appear at once, and each meaning has its required non-colour cue. |
| Group/lane distinction † | V1 draws no containment grammar for lanes; any future group has accepted structural membership evidence and a distinct grammar. |
| Selection/focus clarity † | Exactly one selected/focused target is unambiguous, visible, keyboard reachable, and mirrored in directory/text/inspector content. |
| Attention salience † | Every material attention or ambiguity item has its required non-colour cue without healthy-state styling dominating it. |
| Adjacent-screen continuity | The same safe identity and field ordering/glyph treatment match the adjacent Runtime, Networking, Home, or detail handoff that actually exists. |

These thresholds are release failures, not preferences. A proposed visual
redesign may change them only through an explicit policy/version review with
new deterministic fixtures and certified screenshots; it cannot pass because a
reviewer finds it subjectively nicer.

## 4. Required evidence and authority

The deterministic harness is authoritative for projection-safe task inputs,
exact-key routing/non-routability, activation counts, text-alternative presence,
geometry tolerances, label rules, colour-role count, and #268 congestion caps.
It must use fixed fixtures, policy versions, viewport, browser/font environment,
and renderer build. It also records which task rows are applicable.

A human maintainer is authoritative for the recorded screenshot score and final
approval of certified captures. The approval record names fixture/capture ID,
model/projection/layout/presentation/visual-policy version, controlled
environment, task results, ten criterion scores, any intentional exception, and
reviewer/date. An AI screenshot critique may flag a possible defect, but may
not award a score, approve a screenshot, alter semantic authority, or replace
human approval.

No browser route, certified screenshot suite, or approved real-host capture is
asserted by this document merely because the rubric describes it. Before a
release claims this gate, its evidence record must link the actual tests and
approved captures and identify any rows still pending.
