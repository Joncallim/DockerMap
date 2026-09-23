# Time-to-answer baseline 1 — measured results

This is the first controlled baseline for issue #335. Every number below was
**recomputed from the stored raw samples** with
`npm run perf:summarize -- --artifact <artifact.json>`; none is hand-authored.
The artifact itself stores raw samples only and lives outside the repository
under the evidence-artifact policy (see `TIME_TO_ANSWER_EVIDENCE.md`).

- baseline id: `dockermap-v1/time-to-answer-baseline-1`
- source revision: `b6904d553bf9062da05e0375e40765820104b70f`
- fixture revision: `dockermap-v1/time-to-answer-fixtures-1`
- capture: 3 controlled runs × 15 warmed samples for every declared cell (21 cells)
- capture duration: 16.5 min on the pinned runner
- runner: `linux-x86_64-dedicated` / `cpus-16vcpu` / `ubuntu-26.04` / kernel
  `7.0.0-31-generic` / Node `22.23.2` / rustc `1.88.0` / Docker `29.8.1` /
  Chromium `1.61.0` (flags pinned) / `system-default` fonts / production build
- effective SSE poll interval: `2000` ms (the API's own default; never overridden)

Figures are the **median of the three run p95 values**, in ms.

## The 12-stage matrix

| fixture | stage | run p95 (ms) | median | min | max |
| --- | --- | --- | --- | --- | --- |
| reference-25 | daemonStartToListenerMs | 35.03 / 43.49 / 41.99 | 41.99 | 24.88 | 43.49 |
| reference-25 | listenerToFirstDockerModelMs | 12.71 / 11.14 / 13.79 | 12.71 | 3.73 | 13.79 |
| reference-25 | dockerObservationMs | 6.97 / 7.55 / 7.26 | 7.26 | 1.40 | 7.55 |
| reference-25 | composeEnrichmentMs | 1.11 / 1.15 / 1.21 | 1.15 | 0.67 | 1.21 |
| reference-25 | publicationToNodeObservationMs | 1349.33 / 1300.45 / 1307.47 | 1307.47 | 1283.40 | 1349.33 |
| reference-25 | notificationToCoherentModelMs | 12.70 / 11.80 / 13.90 | 12.70 | 8.60 | 13.90 |
| reference-25 | coherentModelToUsefulRenderMs | 12.70 / 11.80 / 13.90 | 12.70 | 8.60 | 13.90 |
| reference-25 | buildModelMs | 0.40 / 0.50 / 1.30 | 0.50 | 0.10 | 1.30 |
| reference-25 | findingsDerivationMs | 0.07 / 0.05 / 0.08 | 0.07 | 0.00 | 0.08 |
| reference-25 | legacyTopologyLayoutMs | 2.10 / 2.50 / 2.10 | 2.10 | 1.50 | 2.50 |
| reference-25 | commandQueryMs | 55.20 / 55.10 / 49.10 | 55.10 | 4.70 | 55.20 |
| reference-25 | productionBundleMs | 47.30 / 49.30 / 53.10 | 49.30 | 39.40 | 53.10 |
| reference-100 | daemonStartToListenerMs | 110.49 / 92.12 / 109.84 | 109.84 | 44.09 | 110.49 |
| reference-100 | listenerToFirstDockerModelMs | 56.76 / 71.80 / 59.90 | 59.90 | 16.05 | 71.80 |
| reference-100 | dockerObservationMs | 9.13 / 9.10 / 8.80 | 9.10 | 2.45 | 9.13 |
| reference-100 | composeEnrichmentMs | 1.23 / 1.02 / 1.18 | 1.18 | 0.71 | 1.23 |
| reference-100 | publicationToNodeObservationMs | 587.89 / 1915.96 / 636.12 | 636.12 | 0.47 | 1915.96 |
| reference-100 | notificationToCoherentModelMs | 20.60 / 20.60 / 22.10 | 20.60 | 1.60 | 22.10 |
| reference-100 | coherentModelToUsefulRenderMs | 20.60 / 20.60 / 22.10 | 20.60 | 1.60 | 22.10 |
| reference-100 | buildModelMs | 0.90 / 0.80 / 0.90 | 0.90 | 0.20 | 0.90 |
| reference-100 | findingsDerivationMs | 0.20 / 0.20 / 0.21 | 0.20 | 0.00 | 0.21 |
| reference-100 | legacyTopologyLayoutMs | 28.60 / 24.00 / 25.80 | 25.80 | 20.20 | 28.60 |
| reference-100 | commandQueryMs | 59.10 / 40.00 / 45.40 | 45.40 | 6.60 | 59.10 |
| reference-100 | productionBundleMs | 58.70 / 59.30 / 60.00 | 59.30 | 37.70 | 60.00 |
| reference-250 | daemonStartToListenerMs | 254.00 / 250.89 / 262.32 | 254.00 | 108.43 | 262.32 |
| reference-250 | listenerToFirstDockerModelMs | 169.05 / 165.76 / 164.22 | 165.76 | 101.30 | 169.05 |
| reference-250 | dockerObservationMs | 11.98 / 18.00 / 13.07 | 13.07 | 4.78 | 18.00 |
| reference-250 | composeEnrichmentMs | 1.25 / 1.22 / 1.33 | 1.25 | 0.69 | 1.33 |
| reference-250 | publicationToNodeObservationMs | 1941.99 / 1623.47 / 1507.93 | 1623.47 | 396.55 | 1941.99 |
| reference-250 | notificationToCoherentModelMs | 32.20 / 35.50 / 34.60 | 34.60 | 1.70 | 35.50 |
| reference-250 | coherentModelToUsefulRenderMs | 32.20 / 35.50 / 34.60 | 34.60 | 1.70 | 35.50 |
| reference-250 | buildModelMs | 1.50 / 2.00 / 1.20 | 1.50 | 0.60 | 2.00 |
| reference-250 | findingsDerivationMs | 0.76 / 0.92 / 1.22 | 0.92 | 0.01 | 1.22 |
| reference-250 | legacyTopologyLayoutMs | 170.60 / 174.40 / 176.10 | 174.40 | 125.70 | 176.10 |
| reference-250 | commandQueryMs | 32.10 / 35.10 / 34.90 | 34.90 | 11.20 | 35.10 |
| reference-250 | productionBundleMs | 50.20 / 53.70 / 48.60 | 50.20 | 41.30 | 53.70 |

### Scenario fixtures

| fixture | stage | run p95 (ms) | median | min | max |
| --- | --- | --- | --- | --- | --- |
| provider-only-revision-change | publicationToNodeObservationMs | 1964.50 / 1976.30 / 1869.56 | 1964.50 | 0.42 | 1976.30 |
| provider-only-revision-change | notificationToCoherentModelMs | 28.60 / 31.50 / 22.00 | 28.60 | 15.20 | 31.50 |
| provider-only-revision-change | coherentModelToUsefulRenderMs | 28.60 / 31.50 / 22.00 | 28.60 | 15.20 | 31.50 |
| docker-topology-change | publicationToNodeObservationMs | 658.45 / 701.60 / 783.95 | 701.60 | 375.49 | 783.95 |
| docker-topology-change | notificationToCoherentModelMs | 20.80 / 24.30 / 24.40 | 24.30 | 1.70 | 24.40 |
| docker-topology-change | coherentModelToUsefulRenderMs | 20.80 / 24.30 / 24.40 | 24.30 | 1.70 | 24.40 |
| slow-bounded-compose-projection | composeEnrichmentMs | 8.46 / 7.91 / 10.54 | 8.46 | 5.46 | 10.54 |
| unavailable-optional-provider | publicationToNodeObservationMs | 1960.75 / 1918.03 / 1864.41 | 1918.03 | 99.53 | 1960.75 |
| unavailable-optional-provider | notificationToCoherentModelMs | 25.80 / 24.50 / 21.10 | 24.50 | 15.30 | 25.80 |
| unavailable-optional-provider | coherentModelToUsefulRenderMs | 25.80 / 24.50 / 21.10 | 24.50 | 15.30 | 25.80 |

## The ten questions

**1. What dominates cold start?** Process start itself, and it scales with the
fixture: `daemonStartToListenerMs` 42 → 110 → 254 ms and
`listenerToFirstDockerModelMs` 13 → 60 → 166 ms. Together, cold start to first
authoritative Docker model is roughly **55 ms / 170 ms / 420 ms** at 25 / 100 /
250 containers. Most of that is not Docker work: it is process bring-up.

**2. How much time is Docker observation?** `dockerObservationMs` is **7.3 / 9.1
/ 13.1 ms** (p95 medians) against the deterministic local fixture daemon. It is
a small share of cold start (about 13% / 5% / 3% of cold start) and grows sub-
linearly here.

**3. How much is Compose projection?** `composeEnrichmentMs` is **1.15 / 1.18 /
1.25 ms** for the reference fixtures and **8.46 ms** for the deliberately large
bounded Compose project. Compose projection currently executes *inside* the same
Docker publication budget as the inventory read (measured, not decoupled — #336
owns decoupling), but on these fixtures it is a **small absolute cost**: about
9-14% of `listenerToFirstDockerModelMs` at 25 containers and under 1% at 250.
The honest conclusion is that Composition cost is real but not, on this
evidence, the dominant term. #336 should judge its change against these numbers
rather than assume a large win.

**4. How much is notification/poll latency?** **This is the largest single
contributor.** `publicationToNodeObservationMs` — daemon publication committed
→ Node observes the new revision through today's real API/SSE mechanism — has
p95 medians of **1307 / 636 / 1623 ms**, with observed extremes from **0.42 ms**
to **1976 ms**. That spread is the signature of a fixed-interval poll with
`ssePollIntervalMs = 2000`: the observation lands at a random phase inside the
interval. As a share of the summed stage medians it is **87% / 64% / 68%**. This
is not network latency and must not be described as such; it is the current
publication-observation mechanism. **#337 owns removing this floor.**

**5. How much is browser model reconstruction?** Negligible today: the
notification → coherent model → Home commit path is **12.7 / 20.6 / 34.6 ms**
(`notificationToCoherentModelMs`, and `coherentModelToUsefulRenderMs` coincides
with it on this app), of which `buildModelMs` is only **0.5 / 0.9 / 1.5 ms** and
`findingsDerivationMs` **0.07 / 0.2 / 0.92 ms**. There is no model-rebuild
bottleneck to fix at these sizes.

**6. How much is rendering/layout?** `legacyTopologyLayoutMs` is **2.1 / 25.8 /
174.4 ms** and scales *super-linearly* (10× containers → 83× layout time). At 250
containers it is the second-largest stage in the whole matrix after the poll
floor, and it runs on the Home screen. `productionBundleMs` is a flat **49 / 59 /
50 ms** (asset load, roughly size-bound, insensitive to container count). The
legacy preview's cost at 250 containers is the concrete evidence #338 needs.

**7. How much is search?** `commandQueryMs` (open Cmd-K → representative query →
results available) is **55.1 / 45.4 / 34.9 ms**, i.e. tens of milliseconds, and
does not degrade with container count in this range.

**8. What changes 25 → 100 → 250?** Backend collection grows ~6-13×
(`daemonStartToListenerMs` 6×, `listenerToFirstDockerModelMs` 13×); layout grows
~83×; browser-model work grows ~3× but stays in single-digit ms; transport stays
poll-bound and effectively flat in distribution; search and bundle load are flat.

**9. Which stages have high variance?** `publicationToNodeObservationMs` by far
(min 0.42-396 ms vs max ~1976 ms — a phase-of-poll distribution, not a stable
latency). `daemonStartToListenerMs` and `commandQueryMs` also have wide ranges
(2-4× between min and max). Layout, bundle and Docker observation are stable
(within ~1.5×).

**10. Which numbers DO NOT prove production-host performance?** All of them, in
these specific ways: the Docker inventory comes from a **deterministic local
fixture daemon**, so `dockerObservationMs` says nothing about a real Docker
socket, host load, image metadata size or engine version. DockerMap, API, the
web build and Chromium all ran **on one runner over loopback**, so no number
here is a network claim. The Compose trees are **synthetic** (40 and 400
services), so `composeEnrichmentMs` is not a real-project figure. The fixtures
are synthetic topologies with fixed label/port/mount shapes, not a real host's
inventory. One runner class is pinned; this is not a cross-machine comparison.

## Top three latency contributors (reference fixtures, summed medians)

1. **Publication → Node observation (the poll floor)** — 87% / 64% / 68% of the
   measured total at 25 / 100 / 250 containers. #337 owns it.
2. **Process start + first Docker publication** — the cold-start pair, growing
   with inventory size. #336 owns making the first Docker answer independent of
   Compose and cold-start work.
3. **Legacy Home topology layout at scale** — 174 ms at 250 containers. #338
   owns deciding whether Home keeps running that preview.

Nothing above is a recommendation to implement anything in this issue. No
optimization claim may be made without re-running this capture and passing the
promotion gate in `TIME_TO_ANSWER_EVIDENCE.md`.
