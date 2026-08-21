# Responsive and accessibility evidence — issue #35

## Certification boundary

- **Tested application commit:** `85fdd46b59cc0e38e464246c2a6021ff5d038dde`
- **Evidence recorded:** 2026-08-21T23:47:05+08:00
- **Operator/environment:** Hermes Agent; Chromium 149.0.7827.55 / Playwright 1.61.0 on Linux 7.0.0-29-generic.
- **Node/npm:** v22.23.2 / 10.9.8
- **Axe:** `@axe-core/playwright` 4.13.0 / `axe-core` 4.13.0
- **Mock-stack readiness:** daemon, API, and Vite web process started by the existing `startMockStack()` harness; scans used `domcontentloaded` and an explicit loaded route heading, never `networkidle`.

This document is a **docs-only descendant** of the tested application commit. It deliberately records that tested code SHA rather than making an impossible self-reference to the commit that contains this evidence. No application, test, dependency, lockfile, CSS, or workflow change was made after the recorded matrix run.

## Commands and results at the tested commit

| Command | Result | Key evidence |
| --- | --- | --- |
| `npm run test:web` (focused during implementation) | PASS | Model identity regression: 25 tests passed. |
| `npm run test:e2e:a11y` | PASS | **51 Playwright tests passed**; 62 default-rule Axe targets had **0 critical / 0 total violations**. Raw JSON is attached per target through `testInfo.attach`. |
| `npm run check` | PASS | `npm audit --omit=dev`: 0 vulnerabilities; typecheck/build/JS tests and Rust fmt/clippy/tests passed. Rust daemon test suite: 95 passed. |
| `npm run test:e2e` | PASS | **54 passed, 5 opt-in live/production tests skipped**; the first run had one transient mock-stack readiness failure on Images and the required immediate re-run passed cleanly. |

CI retains the raw Playwright/Axe attachments and reports through the `Playwright and axe evidence` artifact step. The artifact name is `playwright-axe-${{ github.sha }}`, includes `test-results/` and `playwright-report/`, and has 14-day retention. The CI run produced by this evidence-only descendant is the final-HEAD artifact reference.

## Default-rule Axe matrix

Every row below is a separate fresh browser context per theme. Values are **critical / total**.

| Target | Dark | Light |
| --- | ---: | ---: |
| Home `/` | 0 / 0 | 0 / 0 |
| Map `/map` | 0 / 0 | 0 / 0 |
| Runtime `/runtime` | 0 / 0 | 0 / 0 |
| Changes `/changes` | 0 / 0 | 0 / 0 |
| Copilot `/copilot` | 0 / 0 | 0 / 0 |
| Networking `/networking` | 0 / 0 | 0 / 0 |
| Network detail `/networks/application` | 0 / 0 | 0 / 0 |
| Storage `/storage` | 0 / 0 | 0 / 0 |
| Volume detail `/volumes/postgres_data` | 0 / 0 | 0 / 0 |
| Images `/images` | 0 / 0 | 0 / 0 |
| Image detail `/images/python%3A3.11-slim` | 0 / 0 | 0 / 0 |
| Logs `/logs` | 0 / 0 | 0 / 0 |
| Compose `/compose` | 0 / 0 | 0 / 0 |
| Diagnostics `/diagnostics` | 0 / 0 | 0 / 0 |
| Settings `/settings` | 0 / 0 | 0 / 0 |
| Service detail `/services/postgres` | 0 / 0 | 0 / 0 |
| Not found route | 0 / 0 | 0 / 0 |
| TokenScreen (real bearer-unauthorized event) | 0 / 0 | 0 / 0 |
| Service tabs: Overview, Dependencies, Resources, Logs, Configuration | 0 / 0 each | 0 / 0 each |
| Service Configuration internals expanded | 0 / 0 | 0 / 0 |
| Network / Volume / Image disclosure collapsed | 0 / 0 each | 0 / 0 each |
| Network / Volume / Image disclosure expanded | 0 / 0 each | 0 / 0 each |
| Open CommandPalette | 0 / 0 | 0 / 0 |

No Axe rules were disabled or excluded.

## Non-Axe browser assertions

- `800×900` and `640×900` sweeps covered every core route; both widths had document horizontal overflow `<= 1px` and Map/Runtime used one stacked grid track.
- The focused interaction story verified skip-link focus, route-heading focus, Map Space selection and clear focus return, filter-hidden Map selection clearing, ARIA tab roving/manual activation, disclosure state/IDREFs, palette focus containment/cancel restore/navigation, Runtime pressed state and clear focus return, and resolving `aria-controls` IDs.
- The reduced-motion browser assertion found **0 visible elements** with a non-`none`, infinite computed animation under `prefers-reduced-motion: reduce`.
- Graph text alternative, semantic state dots, contrast-safe light tokens, local dark Map state palette, 0.62-opacity meaningful network tracks, and focus rings are implemented and covered by the dark/light scans plus computed browser behavior.

## Keyboard and visual walkthrough checklist

Observation method: Chromium keyboard-driven interaction with DOM/computed-style inspection and the real mock stack. “200%” below records the required 640 CSS-pixel reflow proxy for a 1280px browser at 200% (the automated assertion verifies the same reflow/overflow contract); intentional Settings code scrolling remains the explicit exception.

### Cross-screen

- [x] Both themes: first Tab exposes **Skip to main content**; Enter focuses `#main-content`.
- [x] Rail navigation lands focus on the destination heading, including asynchronous route loading without a later focus steal.
- [x] At 800px the rail is horizontal and keyboard-scrollable, shows an overflow affordance, wraps topbar actions, and stacks Map/Runtime above inspectors.
- [x] At the 640px/200%-zoom proxy, routes have no document-level horizontal overflow or clipped text; Settings `pre` remains intentionally horizontally scrollable.
- [x] Reduced motion leaves no infinite animation and preserves state visibility.
- [x] Visible focus treatment exists for links, buttons, fields, switches, tabs, graph nodes, and palette controls.

### Route-by-route

- [x] **TokenScreen:** token textbox has a real API-token name; Connect/error state remains announced.
- [x] **Home:** read-only map has no focusable nodes; service links are collision-safe and states are announced.
- [x] **Map:** pressed filters, labeled network checks, keyboard graph nodes, Space-without-scroll, qualified clear label/focus return, and hidden-selection clearing all work.
- [x] **Runtime:** provider/layer/attention pressed states, unique node selection, unavailable duplicate nodes, qualified clear/focus return, and detail links behave truthfully.
- [x] **Service Detail:** manual ARIA tabs support arrow/Home/End and Enter/Space; stable panel IDREF; service internals disclosure preserves focus and target ID in both states.
- [x] **Changes:** filters expose pressed state and no ambiguous service route is emitted.
- [x] **Copilot:** input is named **Ask Copilot**; empty/collided identities cannot become matches, suggestions, references, or routes.
- [x] **Networking / Network detail:** members remain visible with fallbacks; literal **not internal** is used rather than an inferred bridge label; disclosure works in both states.
- [x] **Storage / Volume detail:** duplicate and empty consumer occurrences remain distinct and non-routable when ambiguous; disclosure works in both states.
- [x] **Images / Image detail:** named controls and semantic state dots remain available; collided/empty consumers stay plain evidence.
- [x] **Logs:** service/level/search/live/load-older controls are named; long row metadata reflows.
- [x] **Compose:** literal severity and Compose origin are visible; empty service/source/target fields use explicit fallbacks.
- [x] **Diagnostics:** literal severity/source/service/file context is present; error/blocked tones are semantic and contrast-safe.
- [x] **Settings:** five selects and two URL fields have associated labels and hint descriptions; switches retain names/checked state; code is scrollable rather than clipped.
- [x] **NotFound:** route exposes an `h1`; return link is usable.
- [x] **CommandPalette:** combobox/listbox has no nested interactive options; background is inert; Tab/Shift+Tab stay contained; Escape restores same-route trigger; command navigation leaves restoration to route heading focus.

## Remaining risk

The suite deliberately uses the mock stack for DOM/CSS semantics and uses focused web-model/client rendering regressions for empty, duplicate, and redaction-collided contract values. It does not mutate daemon/API fixtures or expand beyond the approved web-only scope. A maintainer may additionally repeat the visual walkthrough with their local OS zoom implementation before release, but the recorded browser matrix, raw Axe attachments, and required gates are green for the exact tested application commit.
