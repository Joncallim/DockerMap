# Atlas Golden Governance (V1 foundation)

This directory deliberately freezes pure semantic and logical-layout behavior
before any Atlas renderer exists.

1. `__goldens__/two-container-semantic.json` is the exact `AtlasModel` golden.
2. `__goldens__/two-container-layout.json` is the exact logical-coordinate
   golden. It is independent of viewport, theme, and camera.
3. Property tests cover permutations, caps, collisions, source authority,
   state/freshness/attention separation, and local-layout stability.
4. Once #253/#257 introduce a renderer, add numeric browser geometry tests
   first (clipping, overlap, focus, keyboard order), then a small representative
   screenshot matrix. Screenshot changes require human approval and cannot
   authorize semantic or source-authority changes.

Goldens change only with an explicit projection/layout policy review. Do not
replace them with snapshots of live host data, screenshots, timestamps, or
model revisions.

`__goldens__/policy-versions.json` is the byte-exact manifest binding each
checked-in artifact to its named internal Atlas policy. It is intentionally
separate from DockerMap's release/API version. The currently frozen values are:

- projection: `atlas-v1/projection-1`;
- logical layout: `atlas-v1/local-lanes`;
- visual grammar: `atlas-v1/visual-grammar-1`; and
- renderer spike: `atlas-v1/renderer-spike-1`.

The semantic and logical-layout goldens are tied to their respective projection
and layout entries in that manifest. The selected-local attachment policy is
tied to the projection and visual entries. A changed value without the matching
manifest and exact-golden migration is a failed change-control review, not a
snapshot update.

Atlas V1 has selected no third-party graph/layout dependency. The dependency
decision is `none`; a future selection must pin the exact package version in
the manifest/change record and add lockfile review evidence before it may
produce a coordinate or golden change.

The version decision and required migration record are defined in
`docs/architecture/ATLAS_VERSIONING.md`.
