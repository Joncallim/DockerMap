# Atlas Renderer Spike Decision (#253)

Status: fixture-only comparison; no Atlas route or production renderer ships in
this slice.

## Candidates

| Candidate | Added runtime dependencies | Deterministic SVG topology | Semantic keyboard directory | Decision |
| --- | ---: | --- | --- | --- |
| Native SVG | 0 | Yes | SVG button semantics only | Baseline retained |
| SVG/HTML hybrid | 0 | Yes | Yes, from canonical `AtlasModel` order | Selected for the next prototype |

The hybrid is selected because its HTML directory provides the clearest native
keyboard, focus and text alternative while SVG stays a simple visual layer.
It does not introduce a graph library, worker, WASM, telemetry, remote assets,
external fetch, or new package dependency.

## Frozen spike policy

`policy.ts` versions the renderer spike and fixes 80 relation, attachment, and
aggregate visual budgets, 250 interactive subjects, bounded display text, and
focus-ring width.
Both candidates render capped non-causal attachment lines; high-degree detail
continues through the bounded aggregate text rather than extra connector lines.
The comparison harness reports these counts from an `AtlasModel`/`AtlasLayout`
only; no renderer derives topology from raw APIs or legacy `ServiceMap` data.

## Promotion gate

`renderer-mounted.test.tsx` is the controlled, route-free test-only artifact:
it mounts both candidates against 25/100/250 fixtures, checks actual SVG glyph,
relation, and attachment node counts (the hybrid HTML directory is checked
separately), geometry/order, state-only stability, keyboard/focus, and
collision/long-label handling. For every candidate/size cell it records fifteen
warmed `performance.mark/measure` samples for projection, layout, mount, and
selected-subject update. Durations must be finite but deliberately have no
pass/fail threshold.

## Checked-in comparison result table

The following bounded structural results are asserted by the mounted harness;
they are checked in because they are deterministic. The corresponding timing
records are generated during the test run (15 finite samples per stage and
cell), rather than committed as machine-specific duration values.

| Fixture / candidate | SVG subject glyphs | SVG relations | SVG attachments | Timing record |
| --- | ---: | ---: | ---: | --- |
| chain/dependency, 25 / native and hybrid | 25 | 24 | 0 | 15 × projection, layout, mount, update |
| chain/dependency, 100 / native and hybrid | 100 | 80 (cap) | 0 | 15 × projection, layout, mount, update |
| chain/dependency, 250 / native and hybrid | 250 | 80 (cap) | 0 | 15 × projection, layout, mount, update |
| outbound-star/network, 100 / native and hybrid | 100 | 0 | 8 fixture-backed; 80 in hostile cap regression | 15 × projection, layout, mount, update |

This is not a screenshot baseline. A legitimate browser screenshot baseline
remains deferred until a test-only or feature-gated renderer route exists; this
spike therefore cannot close visual-approval work on its own.

Before an implementation route may use this candidate, #257/#268 must freeze
visual grammar and congestion behavior; #260/#270 must add browser geometry,
keyboard/Axe, and representative screenshot evidence. Intentional visual
changes require human review. This spike is not evidence of production UI
quality or cutover readiness.
