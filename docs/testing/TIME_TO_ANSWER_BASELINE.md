# Time-to-answer Baseline 4

Status: **accepted candidate under review in PR #346**. Baseline 4 is the intended
comparison authority for #336 and #337 once that PR is merged. It is not represented
as merged or as an unconditional authority before review completes.

- baseline id / methodology: `dockermap-v1/time-to-answer-methodology-8`
- product and capture-harness revision: `bdce6ae354d757d3318c514e10d620edb497918e`
- durable evidence root: `/srv/jonas/evidence/dockermap/time-to-answer/bdce6ae/`
  (stored outside this repository under the evidence-artifact policy)
- general raw artifact: `time-to-answer-baseline-4.json`, sha256
  `916610bdd4767fb01a4f57e29f318aa504836875cbb4d87ba615c70cb6fb7300`
- capture duration: 105.1 minutes; 44 records × 3 runs × 15 measured samples =
  1,980 raw samples

Baselines 1, 2, and 3 are **REJECTED** historical attempts and are not current
figures or authority for any comparison. Baseline 1 used an uncommitted harness and
incorrect stage boundaries; Baseline 2 retained cold data and shared a stage clock;
Baseline 3 did not sweep poll phase, retained an insufficient warm-up, and had
incorrect provenance/compatibility handling. Their measurement numbers do not appear
in this record.

## Conditioning and composite contract

Every ordinary warmed end-to-end cell uses exactly 60 fixed burn-in observations
followed by exactly 15 measured observations. Observation 61 is always the first
measured sample. Burn-in is retained for audit but excluded completely from timing
summaries and promotion comparisons. This is fixed, deterministic conditioning for
baseline and candidate; it makes **no stationarity claim**.

The composite authority has 44 rows: 38 `end-to-end` rows from
`time-to-answer-baseline-4.json`, plus 6 `controlled-poll-phase` rows from
`time-to-answer-stage5.json`. Every row records fixture, stage, measurement protocol,
source evidence file, and the checkpoint above. All 44 composite runs equal their raw
source runs; there are no duplicate cells.

Normal Stage-6 and Stage-7 timing rows are ordinary `end-to-end` measurements.
The separate `controlled-stage6-stage7-seam-isolation` control is supporting evidence
only and is **FAIL** at this checkpoint:

```
[independence] FAIL: Error: control delay did not begin after the acceptance timestamp
```

Its disclosed limitation is `publication-level causal identity unavailable` and
`validatesDaemonToBrowserAttribution: false`. It is not a timing row, its samples are
not Baseline-4 timing observations, and it is not daemon→browser attribution evidence.

## Recomputed timing table

This table is copied from the recomputed summary
`time-to-answer-baseline-4-summary.md`, derived from the composite raw sample arrays.

| fixture | stage | run p95 (ms) | reviewed aggregation | reviewed (ms) | min | max |
| --- | --- | --- | --- | --- | --- | --- |
| reference-25 | daemonStartToListenerMs | 38.22 / 37.28 / 41.97 | median-of-three-run-p95 | 38.22 | 33.77 | 41.97 |
| reference-25 | listenerToFirstDockerModelMs | 11.86 / 11.07 / 11.50 | median-of-three-run-p95 | 11.50 | 9.13 | 11.86 |
| reference-25 | dockerObservationMs | 1.74 / 1.71 / 1.84 | median-of-three-run-p95 | 1.74 | 1.19 | 1.84 |
| reference-25 | composeEnrichmentMs | 1.01 / 1.06 / 1.02 | median-of-three-run-p95 | 1.02 | 0.62 | 1.06 |
| reference-25 | notificationToCoherentModelMs | 21.20 / 22.40 / 18.00 | median-of-three-run-p95 | 21.20 | 11.20 | 22.40 |
| reference-25 | coherentModelToUsefulRenderMs | 51.00 / 37.60 / 30.20 | median-of-three-run-p95 | 37.60 | 17.60 | 51.00 |
| reference-25 | buildModelMs | 0.20 / 0.20 / 0.20 | median-of-three-run-p95 | 0.20 | 0.00 | 0.20 |
| reference-25 | findingsDerivationMs | 0.08 / 0.06 / 0.08 | median-of-three-run-p95 | 0.08 | 0.04 | 0.08 |
| reference-25 | legacyTopologyLayoutMs | 1.90 / 1.90 / 1.90 | median-of-three-run-p95 | 1.90 | 1.60 | 1.90 |
| reference-25 | commandQueryMs | 52.60 / 55.50 / 59.90 | median-of-three-run-p95 | 55.50 | 6.00 | 59.90 |
| reference-25 | productionBundleMs | 50.30 / 54.70 / 58.60 | median-of-three-run-p95 | 54.70 | 37.80 | 58.60 |
| reference-25 | publicationToNodeObservationMs | 1897.38 / 1898.20 / 1898.67 | phase-normalized-p95 | 1897.79 | 97.18 | 1898.67 |
| reference-100 | daemonStartToListenerMs | 118.14 / 129.97 / 110.31 | median-of-three-run-p95 | 118.14 | 99.22 | 129.97 |
| reference-100 | listenerToFirstDockerModelMs | 22.30 / 18.32 / 19.11 | median-of-three-run-p95 | 19.11 | 15.23 | 22.30 |
| reference-100 | dockerObservationMs | 3.24 / 4.34 / 2.79 | median-of-three-run-p95 | 3.24 | 2.16 | 4.34 |
| reference-100 | composeEnrichmentMs | 1.07 / 1.01 / 1.05 | median-of-three-run-p95 | 1.05 | 0.63 | 1.07 |
| reference-100 | notificationToCoherentModelMs | 35.90 / 37.20 / 45.80 | median-of-three-run-p95 | 37.20 | 29.10 | 45.80 |
| reference-100 | coherentModelToUsefulRenderMs | 52.40 / 53.80 / 48.20 | median-of-three-run-p95 | 52.40 | 35.10 | 53.80 |
| reference-100 | buildModelMs | 0.50 / 0.50 / 0.40 | median-of-three-run-p95 | 0.50 | 0.20 | 0.50 |
| reference-100 | findingsDerivationMs | 0.21 / 0.23 / 0.26 | median-of-three-run-p95 | 0.23 | 0.16 | 0.26 |
| reference-100 | legacyTopologyLayoutMs | 28.30 / 23.10 / 24.40 | median-of-three-run-p95 | 24.40 | 19.40 | 28.30 |
| reference-100 | commandQueryMs | 18.20 / 40.10 / 22.80 | median-of-three-run-p95 | 22.80 | 8.20 | 40.10 |
| reference-100 | productionBundleMs | 52.00 / 50.50 / 61.10 | median-of-three-run-p95 | 52.00 | 37.20 | 61.10 |
| reference-100 | publicationToNodeObservationMs | 1898.07 / 1898.53 / 1897.64 | phase-normalized-p95 | 1897.61 | 98.18 | 1898.53 |
| reference-250 | daemonStartToListenerMs | 311.26 / 325.69 / 308.36 | median-of-three-run-p95 | 311.26 | 106.85 | 325.69 |
| reference-250 | listenerToFirstDockerModelMs | 170.76 / 123.58 / 121.55 | median-of-three-run-p95 | 123.58 | 42.40 | 170.76 |
| reference-250 | dockerObservationMs | 7.26 / 6.21 / 7.46 | median-of-three-run-p95 | 7.26 | 4.42 | 7.46 |
| reference-250 | composeEnrichmentMs | 0.94 / 0.97 / 1.14 | median-of-three-run-p95 | 0.97 | 0.63 | 1.14 |
| reference-250 | notificationToCoherentModelMs | 91.00 / 91.30 / 90.90 | median-of-three-run-p95 | 91.00 | 70.30 | 91.30 |
| reference-250 | coherentModelToUsefulRenderMs | 188.00 / 191.00 / 188.70 | median-of-three-run-p95 | 188.70 | 145.40 | 191.00 |
| reference-250 | buildModelMs | 1.40 / 1.70 / 1.90 | median-of-three-run-p95 | 1.70 | 0.60 | 1.90 |
| reference-250 | findingsDerivationMs | 0.81 / 1.03 / 0.80 | median-of-three-run-p95 | 0.81 | 0.58 | 1.03 |
| reference-250 | legacyTopologyLayoutMs | 150.40 / 166.00 / 149.10 | median-of-three-run-p95 | 150.40 | 123.30 | 166.00 |
| reference-250 | commandQueryMs | 26.10 / 28.70 / 28.40 | median-of-three-run-p95 | 28.40 | 11.40 | 28.70 |
| reference-250 | productionBundleMs | 52.40 / 60.40 / 54.70 | median-of-three-run-p95 | 54.70 | 40.90 | 60.40 |
| reference-250 | publicationToNodeObservationMs | 1898.24 / 1897.54 / 1898.61 | phase-normalized-p95 | 1897.67 | 96.58 | 1898.61 |
| slow-bounded-compose-projection | composeEnrichmentMs | 6.62 / 9.55 / 11.77 | median-of-three-run-p95 | 9.55 | 5.13 | 11.77 |
| provider-only-revision-change | notificationToCoherentModelMs | 45.50 / 41.30 / 36.60 | median-of-three-run-p95 | 41.30 | 27.80 | 45.50 |
| provider-only-revision-change | publicationToNodeObservationMs | 1896.43 / 1898.67 / 1898.03 | phase-normalized-p95 | 1898.00 | 97.02 | 1898.67 |
| docker-topology-change | notificationToCoherentModelMs | 46.60 / 43.70 / 48.30 | median-of-three-run-p95 | 46.60 | 29.40 | 48.30 |
| docker-topology-change | coherentModelToUsefulRenderMs | 46.70 / 52.40 / 44.50 | median-of-three-run-p95 | 46.70 | 37.30 | 52.40 |
| docker-topology-change | publicationToNodeObservationMs | 1898.41 / 1897.48 / 1898.77 | phase-normalized-p95 | 1897.88 | 97.46 | 1898.77 |
| unavailable-optional-provider | notificationToCoherentModelMs | 44.30 / 50.10 / 48.50 | median-of-three-run-p95 | 48.50 | 26.50 | 50.10 |
| unavailable-optional-provider | publicationToNodeObservationMs | 1898.45 / 1898.15 / 1897.72 | phase-normalized-p95 | 1897.93 | 97.40 | 1898.45 |

## Stage 5 controlled poll-phase results

The dedicated `controlled-poll-phase` protocol owns arm → mark → trigger →
identity-acknowledgement. It covers all six declared
`publicationToNodeObservationMs` fixtures on ten declared phases (100 through 1900
ms) over the 2000 ms poll interval. There are 45 distinct trigger ids per fixture;
the maximum absolute observed-vs-declared phase error is at most 1.0 ms. The published
figure is phase-normalized, not user-traffic or network latency.

The recomputed phase table prints these per-phase medians for the reference and
topology fixtures:

| fixture | declared phases | observed latency median per declared phase (ms, earliest→latest) | phase-normalized p95 (ms) | span (ms) |
| --- | --- | --- | --- | --- |
| reference-25 | 10 | 1898, 1699, 1498, 1299, 1098, 899, 698, 498, 298, 97 | 1897.79 | 1801.49 |
| reference-100 | 10 | 1898, 1698, 1498, 1298, 1098, 898, 698, 498, 298, 99 | 1897.61 | 1800.34 |
| reference-250 | 10 | 1898, 1698, 1498, 1298, 1098, 898, 698, 499, 299, 97 | 1897.67 | 1802.03 |
| docker-topology-change | 10 | 1898, 1698, 1498, 1298, 1098, 899, 698, 498, 298, 99 | 1897.88 | 1801.32 |

The phase-normalized figure weights declared phases uniformly. The complete six-row
reviewed values are in the timing table above; the summary's dedicated phase table is
the source for the printed per-phase curves.

## Bucket shares

Source: `time-to-answer-baseline-4-summary.md`.

### reference-25 buckets (sum of reviewed stage figures: 2121.45 ms)
- transport-notification: 1897.79 ms (89.5%)
- rendering: 94.20 ms (4.4%)
- search: 55.50 ms (2.6%)
- backend-collection: 52.56 ms (2.5%)
- browser-model: 21.40 ms (1.0%)

### reference-100 buckets (sum of reviewed stage figures: 2228.69 ms)
- transport-notification: 1897.61 ms (85.1%)
- backend-collection: 141.78 ms (6.4%)
- rendering: 128.80 ms (5.8%)
- browser-model: 37.70 ms (1.7%)
- search: 22.80 ms (1.0%)

### reference-250 buckets (sum of reviewed stage figures: 2856.44 ms)
- transport-notification: 1897.67 ms (66.4%)
- backend-collection: 443.88 ms (15.5%)
- rendering: 393.80 ms (13.8%)
- browser-model: 92.70 ms (3.2%)
- search: 28.40 ms (1.0%)

## Burn-in audit

`time-to-answer-baseline-4.json.harness-evidence.json` proves 96 warmed cells with
complete 75-observation windows: burn-in is observations 1–60, measurement is
observations 61–75, and there are zero mismatches. Eighteen cold-start cells have no
burn-in. The retained burn-in data is audit material only and never contributes to a
timing summary.

## Pinned environment and provenance

| field | value |
| --- | --- |
| runnerClass | linux-x86_64-dedicated |
| cpuClass | cpus-16vcpu |
| osImage / kernel | ubuntu-26.04 / 7.0.0-31-generic |
| Node / Rust / Docker | 22.23.2 / 1.88.0 / 29.8.1 |
| SSE poll interval | 2000 ms |
| sourceRevision / harnessRevision | `bdce6ae354d757d3318c514e10d620edb497918e` / `bdce6ae354d757d3318c514e10d620edb497918e` |
| daemon binary SHA-256 | `862a70cac056dcdbfc0593a03050adabc14a5f7a780c3e64873bec905f772807` |
| daemon build command | `cargo build --release --locked -p dockermap-daemon --manifest-path crates/Cargo.toml` |
| cargo revision | cargo-1.88.0-873a06493-2025-05-10 |
| browser engine / revision | chromium / 1.61.0 |
| browser flags | `--disable-background-networking --disable-sync --no-first-run --no-default-browser-check` |
| font environment / build mode | system-default / production |
| fixture revision | dockermap-v1/time-to-answer-fixtures-1 |
| methodology version | dockermap-v1/time-to-answer-methodology-8 |

The daemon digest was identical before and after capture. The raw sections are
assembled with:

```
npx tsx tests/perf/assembleCompositeEvidence.ts --general <general> --stageFive <stage5> --output <composite>
```

Recompute the published summary with:

```
npm run perf:summarize -- --artifact <composite>
```

The artifact paths are external evidence-artifact-policy storage, not repository
deliverables.

## What this baseline does NOT claim

- It is not real-Docker latency: it uses a deterministic fixture daemon.
- It is not a real network or user-traffic distribution.
- Stage-5 phase-normalized timing is not network latency and does not claim
  publications occur uniformly across poll phase.
- It does not prove the model is complete: Stages 1/2 and Stage 6 end at coherence.
- It makes no daemon-publication attribution claim from the failed seam-isolation
  control.
- It grants no permission to optimise. #336, #337, and #338 must compare in a
  compatible pinned environment under `max(baseline × 1.25, baseline + 2 ms)`.
