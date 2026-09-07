# Atlas Performance and Bundle Evidence

Status: certification prerequisite for #256. This is not cutover evidence, a
production-route certification, or authority to enable Atlas by default.

The selected SVG/HTML hybrid needs two reviewed external records before a
feature-gated route can rely on it:

- `atlas-v1/hybrid-perf-baseline-1` records the 25, 100, and 250-subject
  `chain/dependency` fixtures. For both mount and selected-subject update it
  records fifteen warmed samples in each of three complete controlled runs,
  then uses the median of those three p95 values.
- `atlas-v1/hybrid-bundle-baseline-1` records the production-build Vite
  manifest, every Atlas route-entry transitive JavaScript/CSS chunk, each gzip
  size, their total, and the zero-added-runtime-dependency proof.

Projection and layout numbers may accompany the record as diagnostics; mount
and selected-subject update are the only performance promotion operations.
Neither local nor ordinary CI unit tests compare elapsed time.

## Controlled run record

Run exactly three times on the same dedicated pinned runner after a clean
production build. Record the runner class, CPU class, OS-image digest,
Chromium revision, exact browser flags, installed font environment, production
build mode, fixture revision, renderer policy version, and source revision.
A missing field, changed fixture/browser/policy/font/runner class, or runner
health failure invalidates the record; it does not justify retries until a
preferred duration appears.

The checked-in TypeScript contract in
`apps/web/src/lib/atlas/renderers/performanceEvidence.ts` validates that each
operation has 15 finite non-negative warmed samples in all three runs and
requires the exact 25/100/250 fixture × operation matrix. The artifact stores
only those raw runs: p95 and three-run medians are recomputed during review, so
a supplied summary cannot influence the result. Its environment has a closed
safe field allowlist and rejects unexpected fields or unsafe values. A candidate may
pass only when every exact fixture/operation value is at most
`max(baseline × 1.25, baseline + 2 ms)` in an equivalent controlled environment
(the source revision is intentionally allowed to differ).

The existing mounted renderer harness is the safe fixture source: it mounts
the actual selected SVG/HTML hybrid from the closed `AtlasModel`/layout input.
It fetches no API, carries no raw runtime model, and never contacts a host.

## Bundle capture

From a clean controlled checkout, build a manifest and collect the route
artifact. The command below is deliberately fail-closed: it requires a distinct
Atlas route manifest entry so that static inclusion in the main application
bundle cannot be misrepresented as an Atlas route budget.

```bash
npm ci
npm run build --workspace @dockermap/web -- --manifest
node scripts/collect-atlas-hybrid-bundle-evidence.mjs \
  --manifest apps/web/dist/.vite/manifest.json \
  --entry src/screens/AtlasOverview.tsx \
  --metadata /controlled/atlas-bundle-metadata.json \
  --package-manifest apps/web/package.json \
  --lockfile package-lock.json \
  --output /controlled/atlas-hybrid-bundle.json
```

`atlas-bundle-metadata.json` must include non-empty `sourceRevision`,
`fixtureRevision`, `rendererPolicyVersion`, `runnerClass`, and
`browserRevision`, and set `buildMode` to `production`. The collector walks
only the named entry's manifest imports/dynamic imports, computes gzip sizes
from the built chunks, and emits a closed runtime-dependency proof: sorted
package-manifest dependency allowlist plus SHA-256 digests of that allowlist
and the lockfile. It never copies arbitrary metadata or records manifest/
lockfile contents. Manifest asset names must be normalized relative POSIX paths
inside the resolved build root; traversal, absolute paths, and symlinks are
rejected before files are read or emitted.

For a candidate, pass the approved baseline artifact with
`--baseline /controlled/atlas-hybrid-bundle-baseline.json`. The collector
refuses a changed package-manifest/lockfile dependency proof or a candidate exceeding
`max(2 KiB, 10%)`; it records the compared baseline and allowed byte total in
the candidate artifact. The baseline itself must have the exact closed artifact
schema, internally consistent non-negative asset totals, the same validated
Atlas entry, and equivalent pinned metadata (only `sourceRevision` may differ).
The output target cannot be an existing symlink; evidence is written through an
exclusive, owner-only temporary file and atomically renamed in its resolved
parent directory.

Current Atlas is statically imported by the application shell, so this command
correctly refuses to emit an attributable route artifact today. That is an
unmet certification prerequisite, not permission to count the complete app
bundle or to introduce route splitting in this evidence-only slice. A later
reviewed routing/build change must create the attributable production entry;
then the reviewed candidate may increase the recorded Atlas route gzip total
by no more than `max(2 KiB, 10%)`. Any exception requires a new baseline,
measured justification, appropriate security review, and maintainer approval.

Store only the sanitized JSON evidence records with the review packet. Do not
record live host data, raw model/evidence values, credentials, or screenshots
in these artifacts. Passing these prerequisites still does not satisfy #256's
heterogeneous-host, visual, accessibility, parity/rollback, or final cutover
requirements.
