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
