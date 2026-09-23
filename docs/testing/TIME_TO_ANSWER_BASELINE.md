# Time-to-answer baseline — REJECTED historical attempts

**This document is not the authority for anything.** Baseline 1 (the first
capture) and baseline 2 (the second) were both rejected in independent review and
are retained only to explain methodology changes. Their numbers must never be
cited as current measurements and must never be used for promotion gating.

Baseline 1 was rejected because it measured Cmd-K palette-open instead of
query-to-results, phase-locked its stage-5 samples to the harness's own startup
sequence, mixed cold-start probe daemons into stages documented as warmed, and was
produced by an uncommitted harness.

Baseline 2 fixed those and was rejected for: a cold first observation still inside
the "warmed" window (so the published stage-3/4 p95 *was* the cold sample), an
unpinned daemon binary, and a stage 7 that was element-for-element identical to
stage 6 in all 180 samples.

The numbers below are baseline 2 as measured, kept for methodology comparison
only. A replacement baseline captured from a committed revision, with the
cold/warm split, binary provenance and independent stage-6/7 clocks, is the
authority once it exists and passes the promotion gate.

---

This is the corrected controlled baseline for issue #335. Every number below was
**recomputed from the stored raw samples** with
`npm run perf:summarize -- --artifact <artifact.json>`; none is hand-authored.
The artifact stores raw samples only and lives outside the repository under the
evidence-artifact policy (see `TIME_TO_ANSWER_EVIDENCE.md`).

Baseline 1 was rejected in review and is superseded. It measured Cmd-K palette
open rather than query-to-results, its publication→Node samples were phase-locked
to the harness's own startup sequence, its "warmed" stage-3/4/9 samples were
contaminated by 15 transient cold-start probe daemons sharing the bench sink, and
it was produced by an uncommitted harness so no commit could re-derive it.

- baseline id: `dockermap-v1/time-to-answer-baseline-1` (schema id unchanged;
  this is capture 2 of it)
- **product revision: `0714c87a`** (also the harness revision — the harness was
  committed before the capture, and the capture refuses a dirty worktree)
- fixture revision: `dockermap-v1/time-to-answer-fixtures-1`
- artifact sha256: `38e0c650121f81ec69c2dd1ddc18191c98c091836652bd8ecd7570fc0d006197`
- capture: 3 controlled runs × 15 warmed samples for every declared cell, **44 cells**
- capture duration: 26.2 min on the pinned runner
- runner: `linux-x86_64-dedicated` / `cpus-16vcpu` / `ubuntu-26.04` / kernel
  `7.0.0-31-generic` / Node `22.23.2` / rustc `1.88.0` / Chromium `1.61.0` (flags
  pinned) / `system-default` fonts / production build
- effective SSE poll interval: `2000` ms, derived from the API's own source and
  passed to the API explicitly, so the recorded pin cannot drift from what ran
- `dockerRevision` is recorded but **informational**: no measured stage exercises
  the host Docker daemon, so it is not a compatibility key

Figures are the **median of the three run p95 values**, in ms.

## The declared matrix

| fixture | stage | run p95 (ms) | median | min | max |
| --- | --- | --- | --- | --- | --- |
| reference-25 | daemonStartToListenerMs | 44.35 / 43.54 / 32.07 | 43.54 | 25.45 | 44.35 |
| reference-25 | listenerToFirstDockerModelMs | 14.74 / 13.51 / 9.75 | 13.51 | 3.88 | 14.74 |
| reference-25 | dockerObservationMs | 8.05 / 7.49 / 7.91 | 7.91 | 1.13 | 8.05 |
| reference-25 | composeEnrichmentMs | 1.08 / 1.22 / 1.05 | 1.08 | 0.60 | 1.22 |
| reference-25 | publicationToNodeObservationMs | 1922.63 / 1991.22 / 1971.87 | 1971.87 | 35.03 | 1991.22 |
| reference-25 | notificationToCoherentModelMs | 17.40 / 15.10 / 15.20 | 15.20 | 1.10 | 17.40 |
| reference-25 | coherentModelToUsefulRenderMs | 17.40 / 15.10 / 15.20 | 15.20 | 1.10 | 17.40 |
| reference-25 | buildModelMs | 1.90 / 0.60 / 0.50 | 0.60 | 0.10 | 1.90 |
| reference-25 | findingsDerivationMs | 0.06 / 0.08 / 0.07 | 0.07 | 0.01 | 0.08 |
| reference-25 | legacyTopologyLayoutMs | 2.30 / 2.20 / 2.20 | 2.20 | 1.50 | 2.30 |
| reference-25 | commandQueryMs | 47.10 / 51.40 / 52.50 | 51.40 | 4.80 | 52.50 |
| reference-25 | productionBundleMs | 53.10 / 48.80 / 62.10 | 53.10 | 38.60 | 62.10 |
| reference-100 | daemonStartToListenerMs | 119.47 / 108.08 / 132.75 | 119.47 | 64.76 | 132.75 |
| reference-100 | listenerToFirstDockerModelMs | 39.67 / 54.77 / 60.27 | 54.77 | 15.56 | 60.27 |
| reference-100 | dockerObservationMs | 9.51 / 8.90 / 9.36 | 9.36 | 2.50 | 9.51 |
| reference-100 | composeEnrichmentMs | 1.06 / 1.00 / 1.20 | 1.06 | 0.61 | 1.20 |
| reference-100 | publicationToNodeObservationMs | 1869.08 / 1544.41 / 1828.38 | 1828.38 | 0.34 | 1869.08 |
| reference-100 | notificationToCoherentModelMs | 21.10 / 18.00 / 19.30 | 19.30 | 1.20 | 21.10 |
| reference-100 | coherentModelToUsefulRenderMs | 21.10 / 18.00 / 19.30 | 19.30 | 1.20 | 21.10 |
| reference-100 | buildModelMs | 0.70 / 1.30 / 0.70 | 0.70 | 0.30 | 1.30 |
| reference-100 | findingsDerivationMs | 0.20 / 0.30 / 0.38 | 0.30 | 0.01 | 0.38 |
| reference-100 | legacyTopologyLayoutMs | 26.00 / 24.20 / 22.50 | 24.20 | 19.40 | 26.00 |
| reference-100 | commandQueryMs | 37.60 / 43.80 / 27.90 | 37.60 | 6.40 | 43.80 |
| reference-100 | productionBundleMs | 55.60 / 55.70 / 47.90 | 55.60 | 36.90 | 55.70 |
| reference-250 | daemonStartToListenerMs | 234.29 / 272.00 / 226.41 | 234.29 | 107.76 | 272.00 |
| reference-250 | listenerToFirstDockerModelMs | 156.83 / 127.09 / 163.28 | 156.83 | 54.39 | 163.28 |
| reference-250 | dockerObservationMs | 12.56 / 15.77 / 15.34 | 15.34 | 4.55 | 15.77 |
| reference-250 | composeEnrichmentMs | 1.22 / 1.04 / 1.08 | 1.08 | 0.62 | 1.22 |
| reference-250 | publicationToNodeObservationMs | 1819.21 / 1920.10 / 1918.79 | 1918.79 | 0.27 | 1920.10 |
| reference-250 | notificationToCoherentModelMs | 31.70 / 60.00 / 52.10 | 52.10 | 21.70 | 60.00 |
| reference-250 | coherentModelToUsefulRenderMs | 31.70 / 60.00 / 52.10 | 52.10 | 21.70 | 60.00 |
| reference-250 | buildModelMs | 1.80 / 1.80 / 1.60 | 1.80 | 0.70 | 1.80 |
| reference-250 | findingsDerivationMs | 0.91 / 1.19 / 0.86 | 0.91 | 0.01 | 1.19 |
| reference-250 | legacyTopologyLayoutMs | 174.30 / 163.60 / 164.40 | 164.40 | 115.30 | 174.30 |
| reference-250 | commandQueryMs | 28.90 / 25.20 / 26.60 | 26.60 | 10.90 | 28.90 |
| reference-250 | productionBundleMs | 63.60 / 61.50 / 45.30 | 61.50 | 38.10 | 63.60 |

### Scenario fixtures

| fixture | stage | run p95 (ms) | median | min | max |
| --- | --- | --- | --- | --- | --- |
| provider-only-revision-change | publicationToNodeObservationMs | 1753.46 / 1576.95 / 1953.99 | 1753.46 | 0.54 | 1953.99 |
| provider-only-revision-change | notificationToCoherentModelMs | 21.20 / 23.00 / 19.90 | 21.20 | 12.90 | 23.00 |
| docker-topology-change | publicationToNodeObservationMs | 1925.64 / 1900.24 / 1977.43 | 1925.64 | 4.11 | 1977.43 |
| docker-topology-change | notificationToCoherentModelMs | 21.10 / 20.30 / 20.30 | 20.30 | 13.80 | 21.10 |
| docker-topology-change | coherentModelToUsefulRenderMs | 21.10 / 20.30 / 20.30 | 20.30 | 13.80 | 21.10 |
| slow-bounded-compose-projection | composeEnrichmentMs | 7.19 / 8.86 / 6.70 | 7.19 | 5.08 | 8.86 |
| unavailable-optional-provider | publicationToNodeObservationMs | 1970.25 / 1808.82 / 1916.09 | 1916.09 | 47.13 | 1970.25 |
| unavailable-optional-provider | notificationToCoherentModelMs | 26.20 / 24.50 / 26.30 | 26.20 | 14.50 | 26.30 |

`coherentModelToUsefulRenderMs` is declared only for the four fixtures whose
published change demonstrably repaints Home. A provider-only or
provider-unavailable revision is not guaranteed to repaint it, so measuring it
there would be an empty number. The harness asserts each scenario's premise: the
provider-only fixture fails if its Docker inventory changed during the run, and
the unavailable-provider fixture fails if no optional provider was non-fresh.

## The ten questions

**1. What dominates cold start?** Process bring-up, and it scales with the
fixture: `daemonStartToListenerMs` 43.5 → 119.5 → 234.3 ms and
`listenerToFirstDockerModelMs` 13.5 → 54.8 → 156.8 ms. Cold start to first
authoritative Docker model is roughly **57 / 174 / 391 ms**. Almost none of that
is Docker work.

**2. How much time is Docker observation?** `dockerObservationMs` is **7.9 / 9.4
/ 15.3 ms** against the deterministic local fixture daemon — about 14% / 5% / 4%
of cold start. It grows sub-linearly with container count here.

**3. How much is Compose projection?** `composeEnrichmentMs` is **1.08 / 1.06 /
1.08 ms** on the reference fixtures and **7.19 ms** on the deliberately large
bounded project. It still executes *inside* the same Docker publication budget as
the inventory read — measured, not decoupled; **#336 owns decoupling**. On this
evidence Compose is a real but small absolute cost (≈8% of
`listenerToFirstDockerModelMs` at 25 containers, under 1% at 250). #336 should be
judged against these numbers rather than an assumed large win.

**4. How much is notification/poll latency?** **The largest single contributor,
and now measured across the interval rather than at one phase.**
`publicationToNodeObservationMs` medians are **1971.9 / 1828.4 / 1918.8 ms**, and
the observed range now spans nearly the whole interval: **35.0–1991.2**,
**0.34–1869.1**, **0.27–1920.1** ms. Baseline 1 reported 1283–1349 ms for
reference-25 — a 66 ms band — because the harness triggered each sample from a
fixed startup sequence, locking the phase between the daemon's 2 s refresh loop
and the API's 2 s poller. This capture jitters every trigger by a uniform
sub-interval delay, so the numbers describe the wait a reader actually
experiences. The two fixed cycles still exist and are unchanged: this de-correlates
the *measurement*, not the mechanism. **#337 owns removing the floor.**

**5. How much is browser model reconstruction?** Small: stage 6 is **15.2 / 19.3
/ 52.1 ms**, of which `buildModelMs` is **0.60 / 0.70 / 1.80 ms** and
`findingsDerivationMs` **0.07 / 0.30 / 0.91 ms** (the latter now correctly
recorded as backend-collection work that runs in the daemon during publication).
The fixture topology derives no findings, so that stage measures the
empty-derivation path at its resolution floor. There is no model-rebuild
bottleneck at these sizes.

**6. How much is rendering/layout?** `legacyTopologyLayoutMs` is **2.2 / 24.2 /
164.4 ms** and scales super-linearly (10× the containers costs ~75× the layout
time). At 250 containers it is the second-largest stage in the matrix and it runs
on the Home screen. `productionBundleMs` is a flat **53.1 / 55.6 / 61.5 ms**,
insensitive to container count. #338 owns the legacy-preview decision.

**7. How much is search?** `commandQueryMs` — palette open, a query with a known
expected result typed, and the filtered list observed to change and still contain
that result — is **51.4 / 37.6 / 26.6 ms**. Baseline 1's 55/45/35 ms measured
palette open only.

**8. What changes 25 → 100 → 250?** Backend collection grows ~3-12×
(`daemonStartToListenerMs` 5.4×, `listenerToFirstDockerModelMs` 11.6×); layout
grows ~75×; model acceptance grows ~3.4×; transport stays poll-bound; search and
bundle load are flat.

**9. Which stages have high variance?** `publicationToNodeObservationMs` by far —
its samples now span the full interval (0.27 ms to ~1991 ms). `commandQueryMs`
(4.8–52.5 ms at 25 containers) and `daemonStartToListenerMs` (25.5–44.4; 64.8–
132.8; 107.8–272.0) are also wide. Tight: `composeEnrichmentMs` (0.60–1.22),
`findingsDerivationMs` (0.01–0.08 at 25), `legacyTopologyLayoutMs` (1.50–2.30 at
25; 19.4–26.0 at 100; 115.3–174.3 at 250), `productionBundleMs`.

**10. Which numbers DO NOT prove production-host performance?** All of them:
the Docker inventory comes from a **deterministic local fixture daemon**, so
`dockerObservationMs` says nothing about a real Docker socket, host load, image
metadata or engine version; DockerMap, the API, the web build and Chromium all
ran **on one runner over loopback**, so no number is a network claim; the Compose
trees are **synthetic** (40 and 400 services); the fixtures are synthetic
topologies; and one runner class is pinned. Stage 5 measures the *current*
publication-observation mechanism including its poll wait — it is **not** a
generic network-latency figure.

## Top three latency contributors (reference fixtures)

| bucket (sum of stage medians) | 25 | 100 | 250 |
| --- | --- | --- | --- |
| transport-notification | 1971.87 (90.6%) | 1828.38 (84.3%) | 1918.79 (71.4%) |
| backend-collection | 66.11 (3.0%) | 184.97 (8.5%) | 408.44 (15.2%) |
| rendering | 70.50 (3.2%) | 99.10 (4.6%) | 278.00 (10.4%) |
| search | 51.40 (2.4%) | 37.60 (1.7%) | 26.60 (1.0%) |
| browser-model | 15.80 (0.7%) | 20.00 (0.9%) | 53.90 (2.0%) |

1. **Publication → Node observation (the poll floor)** — 90.6 / 84.3 / 71.4 % of
   the summed stage medians. #337 owns it.
2. **Process start plus first Docker publication** — the cold-start pair, growing
   with inventory size. #336 owns making the first Docker answer independent of
   Compose and cold-start work.
3. **Legacy Home topology layout at scale** — 164.4 ms at 250 containers. #338
   owns whether Home keeps running that preview.

No optimization is claimed or recommended here, and nothing in this document
justifies changing Compose coupling or the SSE poll interval. A future
optimization may only be called an improvement by re-running this capture and
passing the promotion gate in `TIME_TO_ANSWER_EVIDENCE.md`.
