# Atlas Screenshot Governance

Atlas screenshots are an opt-in reviewer aid, not a CI pixel-baseline gate.
They exercise the feature-gated preview route only against named, redacted
fixture responses. Default Playwright and live-Docker runs neither enable the
route nor create Atlas image artifacts.

## Creating a review packet

From the repository root, run:

```bash
DOCKERMAP_ATLAS_CAPTURE=1 npm run test:e2e -- atlas-visual-capture.spec.ts
```

The capture test starts a mock stack with the closed `atlasOverview: true`
harness option. That option passes a fixed `VITE_ENABLE_ATLAS_OVERVIEW=true`
to Vite; every ordinary mock stack explicitly passes `false`, regardless of the
parent shell environment. The browser receives only the named fixture responses
listed in each artifact's sidecar, including the named deterministic heartbeat
event. A catch-all API interceptor aborts and records any request outside that
allowlist, so it cannot fall through to the mock stack.

Artifacts are written below Playwright's ignored `test-results/` directory:

- `atlas-<class>-<profile>.png` is a locator shot of `.atlas-screen`, not a full-page
  shot.
- `atlas-<class>-<profile>.json` is its small, safe sidecar: synthetic class,
  route, profile, viewport, color/motion settings, fixture inventory (including
  the heartbeat), served fixture names, and artifact filename. It must not
  contain raw runtime payloads, IDs, paths, source URLs, credentials, evidence,
  trace data, or host metadata.

Reviewers should retain or attach only the PNG plus its sidecar. Do not add a
`toHaveScreenshot` assertion, commit a pixel baseline, or use a live-Docker or
production endpoint for this lane.

## Current approval matrix

The opt-in runner currently produces three deterministic Chromium profiles:

| Profile | Viewport | Color | Motion |
| --- | --- | --- | --- |
| desktop-light | 1440 × 960 | light | no preference |
| desktop-dark | 1440 × 960 | dark | no preference |
| narrow-light-reduced | 390 × 844 | light | reduced |

Each profile is produced for exactly three named synthetic classes:

| Class | Safe modeled condition | It does not establish |
| --- | --- | --- |
| compose-heavy | Docker declarations plus recorded network/storage context | traffic, reachability, or host exposure |
| mixed-docker-host-native | distinct Docker and stale Systemd records | label-based cross-provider correlation |
| sparse-unusual | collision, unsupported record, and daemon-risk context | confidence, causality, or a real daemon condition |

The opt-in lane also performs one narrow synthetic keyboard, pointer, and Axe
check under the narrow dark reduced-motion profile. This supplements neither
the default accessibility suite nor the manual review requirements below.

This is an intentionally limited review sample, **not** a 12-cell visual
certification matrix. Any unlisted viewport, theme, browser, device scale,
motion mode, zoom level, localization, data-density, routing/congestion state,
or operating-system rendering cell is unavailable until it has its own
redacted fixture, profile, reviewer approval, and sidecar.

Browser zoom at 200%, real-host review, production-image evidence, live-Docker
evidence, human visual approval, and cutover remain separate pending work.
The synthetic packet must never be presented as evidence for any of those
claims. A reviewer must perform the manual accessibility work separately before
making a zoom or approval claim.

## Approval and change control

For a meaningful Atlas presentation change, reviewers compare the new packet
with the prior approved packet and record the decision in the associated issue
or pull request. They verify that the page is the gated `/atlas` route, the
sidecar profile matches the image, all fixture names are recognized redacted
fixtures, and no prohibited data is visible. A changed fixture, profile, or
capture CSS invalidates the prior comparison and requires a new review packet.

This process is deliberately visual review rather than automatic pixel
comparison: browser rendering differs across supported environments, while the
authoritative functional, accessibility, and semantic behavior remains covered
by deterministic unit and Playwright tests.
