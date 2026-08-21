# Responsive and accessibility evidence — issue #35

## Certification boundary

- **Tested application commit:** `a6a498da016988029a9d8c913c63a5427f0999c8` (Sol final-gate remediation)
- **Evidence recorded:** 2026-08-22T03:54:22+08:00 (real 200% zoom walkthrough) / evidence updated 2026-08-22T04:07+08:00
- **Operator/environment:** Hermes Agent; Chromium 149.0.7827.55 / Playwright 1.61.0 on Linux 7.0.0-29-generic.
- **Node/npm:** v22.23.2 / 10.9.8
- **Axe:** `@axe-core/playwright` 4.13.0 / `axe-core` 4.13.0
- **Mock-stack readiness:** daemon, API, and Vite web process started by the existing `startMockStack()` harness; scans used `domcontentloaded` and an explicit loaded route heading, never `networkidle`.

This document is a **docs-only descendant** of the tested application commit. It deliberately records that tested code SHA rather than making an impossible self-reference to the commit that contains this evidence. No application, test, dependency, lockfile, CSS, or workflow change was made after the recorded matrix run.

## Commands and results at the tested commit

| Command | Result | Key evidence |
| --- | --- | --- |
| `npm run test:web` (focused during implementation) | PASS | **85 tests passed across 10 files**: model raw-occurrence preservation (dependencyOccurrences), change-feed/causal-chain identity fallbacks, ServiceMap/Runtime collision-tag renderers, Diagnostics severity-tone consistency, plus the existing empty/collision/duplicate-key regressions. |
| `npm run test:e2e:a11y` | PASS | **71 Playwright tests passed**; **64 default-rule Axe targets had 0 critical / 0 total violations**. Every one of the 64 targets is now its OWN test with a fresh browser context/page, so a violation in an early state can never skip the later scans. Raw JSON is attached per target through `testInfo.attach`. |
| `npm run check` | PASS | `npm audit --omit=dev`: 0 vulnerabilities; typecheck/build/JS tests and Rust fmt/clippy/tests passed. Rust daemon test suite: 95 passed. |
| `npm run test:e2e` | PASS | **74 passed, 5 opt-in live/production tests skipped**; the required immediate re-run passed cleanly. |

CI retains the raw Playwright/Axe attachments and reports through the `Playwright and axe evidence` artifact step. The matrix mirrors all **64 raw Axe JSON attachments** into `test-artifacts/axe/` before upload; the artifact name is `playwright-axe-${{ github.sha }}`, includes `test-artifacts/`, `test-results/`, and `playwright-report/`, and has 14-day retention. The CI run produced by this evidence-only descendant is the final-HEAD artifact reference.

## Default-rule Axe matrix

Every row below is a **separate Playwright test**, each opening its own fresh browser context and page per theme (the one shared serial mock stack is retained); a violation in one state cannot skip the scans of the remaining states. Values are **critical / total**.

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
| Service tabs: Overview, Dependencies, Resources, Logs, Configuration (one test per tab) | 0 / 0 each | 0 / 0 each |
| Service Configuration internals expanded | 0 / 0 | 0 / 0 |
| Network / Volume / Image disclosure collapsed (one test per state) | 0 / 0 each | 0 / 0 each |
| Network / Volume / Image disclosure expanded (one test per state) | 0 / 0 each | 0 / 0 each |
| Open CommandPalette | 0 / 0 | 0 / 0 |
| CommandPalette empty state (no matches) | 0 / 0 | 0 / 0 |

No Axe rules were disabled or excluded.

## Non-Axe browser assertions

- `800×900` and `640×900` sweeps covered every core route plus TokenScreen, the open CommandPalette, Map with a selected service, Runtime with a selected node and unselected, Service Configuration internals expanded, **every ServiceDetail tab, and every Network/Volume/Image disclosure expanded**; every cell asserted single-track Map/Runtime layout, document horizontal overflow `<= 1px`, AND a visible-text clipping check (no identity/heading ellipsis, no non-scrollable clipped text, no off-viewport text; sr-only text exempt; intentional compact-metadata ellipsis exempt).
- **Horizontal-rail contract at both 800px and 640px** (new in this round): the rail is the top/horizontal form (`flex-direction: row`), the nav is the SCROLLABLE element (`clientWidth < scrollWidth`, `overflow-x: auto`), the sticky overflow affordance is rendered, keyboard scrolling works (focusing the Settings item moves `nav.scrollLeft > 0`), and pointer scrolling works (horizontal wheel moves `nav.scrollLeft`). The pre-fix 760px block widened `.nav` with `flex: none`, so the rail clipped the nav with `overflow: hidden` and Settings sat unreachable off-viewport at 640px — that duplication was removed and the block now carries only phone/detail/field refinements.
- The browser-level identity fixture (real `/api/snapshot` interception — jsdom cannot prove reflow) at 640px verified a 252-char service name wraps inside the viewport without clipping/ellipsis, an empty name renders the explicit "Unavailable service name" fallback, and two redaction-collided `dup-svc` rows stay visible as distinct non-routable rows.
- The focused interaction story verified skip-link focus, route-heading focus, Map Space selection and clear focus return **twice for the SAME node** (monotonic focus-request token — a second select+clear of the same service re-triggers focus restoration), filter-hidden Map selection clearing, ARIA tab roving/manual activation, disclosure state/IDREFs, palette focus containment in BOTH directions (Tab and Shift+Tab), cancel restore, navigation, Runtime pressed state and clear focus return, **Runtime relation navigation focus preservation** (clicking an inspector relation button moves focus to the destination node's persistent runtime-node button — it never falls to BODY), and resolving `aria-controls` IDs.
- The async-heading e2e forces the RouteFocusManager MutationObserver path (localStorage default route redirect + delayed `/api/snapshot`, with the SSE stream stalled so refresh ticks cannot abort the delayed fetch): the late-mounting `h1` receives focus even when it arrives **5.5s after navigation — later than the former arbitrary 5s observer cutoff** (removed in this round), and a user Tab to the skip link before the h1 mounts is NOT stolen back when the heading finally mounts.
- The reduced-motion browser assertion found **0 visible elements** with a non-`none`, infinite computed animation under `prefers-reduced-motion: reduce`.
- Graph text alternative, semantic state dots, contrast-safe light tokens, local dark Map state palette, 0.62-opacity meaningful network tracks, and focus rings are implemented and covered by the dark/light scans plus computed browser behavior. **Collided graph occurrences are now visible on the map itself**: duplicate id/name nodes render a dashed ring plus a literal "identity collision" tag and explanatory text, are never interactive, and are named in the map's text alternative; collided Runtime rows carry the same tag/hint. The non-text contrast assertion reads the **computed `.map` background gradient** (not a hardcoded base) and blends the track color over it before asserting ≥ 3:1 against the surface.

## Real 200% browser-zoom walkthrough (performed, not proxied)

Method: real Chromium 200% browser zoom applied through the **actual browser accelerator path** (Ctrl+Shift+= injected as genuine X11 input events into the Chromium window), verified on every screen by the layout viewport halving from 1280 to **640 CSS px** (browser zoom shrinks the layout viewport; `innerWidth=640` is the proof). The walk covered every route/state in **both forced dark and forced light themes** on a 1280×900 viewport. Per screen: document horizontal overflow `<= 1px`, no off-viewport text, and no clipped/ellipsized identity or heading text (sr-only exempt; the Settings code region remains the explicit intentional scroll exception). Operator: **Hermes Agent**; date 2026-08-22T03:54:22+08:00; browser **Chromium 149.0.7827.55**; OS **Linux**; viewport 1280×900 @ 200% zoom (640 CSS px); zoom 200% (real browser zoom).

| Screen | Theme | Result | Notes |
| --- | --- | --- | --- |
| Home `/` | dark + light | PASS | h1 "Command Center"; innerWidth=640; overflow=0px; no clipped/off-viewport text |
| CommandPalette open (dialog) | dark + light | PASS | h1 "Command Center"; innerWidth=640; overflow=0px; no clipped/off-viewport text |
| CommandPalette empty state (no matches) | dark + light | PASS | h1 "Command Center"; innerWidth=640; overflow=0px; no clipped/off-viewport text |
| Map `/map` | dark + light | PASS | h1 "Service Map"; innerWidth=640; overflow=0px; no clipped/off-viewport text |
| Map `/map` (postgres selected) | dark + light | PASS | h1 "Service Map"; innerWidth=640; overflow=0px; no clipped/off-viewport text |
| Runtime `/runtime` | dark + light | PASS | h1 "Runtime Map"; innerWidth=640; overflow=0px; no clipped/off-viewport text |
| Runtime `/runtime` (node selected) | dark + light | PASS | h1 "Runtime Map"; innerWidth=640; overflow=0px; no clipped/off-viewport text |
| Changes `/changes` | dark + light | PASS | h1 "Change Center"; innerWidth=640; overflow=0px; no clipped/off-viewport text |
| Copilot `/copilot` | dark + light | PASS | h1 "Copilot"; innerWidth=640; overflow=0px; no clipped/off-viewport text |
| Networking `/networking` | dark + light | PASS | h1 "Networking"; innerWidth=640; overflow=0px; no clipped/off-viewport text |
| Network detail `/networks/application` | dark + light | PASS | h1 "application"; innerWidth=640; overflow=0px; no clipped/off-viewport text |
| Network disclosure expanded | dark + light | PASS | h1 "application"; innerWidth=640; overflow=0px; no clipped/off-viewport text |
| Storage `/storage` | dark + light | PASS | h1 "Storage"; innerWidth=640; overflow=0px; no clipped/off-viewport text |
| Volume detail `/volumes/postgres_data` | dark + light | PASS | h1 "postgres_data"; innerWidth=640; overflow=0px; no clipped/off-viewport text |
| Volume disclosure expanded | dark + light | PASS | h1 "postgres_data"; innerWidth=640; overflow=0px; no clipped/off-viewport text |
| Images `/images` | dark + light | PASS | h1 "Images"; innerWidth=640; overflow=0px; no clipped/off-viewport text |
| Image detail `/images/python:3.11-slim` | dark + light | PASS | h1 "python:3.11-slim"; innerWidth=640; overflow=0px; no clipped/off-viewport text |
| Image disclosure expanded | dark + light | PASS | h1 "python:3.11-slim"; innerWidth=640; overflow=0px; no clipped/off-viewport text |
| Logs `/logs` | dark + light | PASS | h1 "Logs"; innerWidth=640; overflow=0px; no clipped/off-viewport text |
| Compose `/compose` | dark + light | PASS | h1 "Compose"; innerWidth=640; overflow=0px; no clipped/off-viewport text |
| Diagnostics `/diagnostics` | dark + light | PASS | h1 "Diagnostics"; innerWidth=640; overflow=0px; no clipped/off-viewport text |
| Settings `/settings` | dark + light | PASS | h1 "Settings"; innerWidth=640; overflow=0px; no clipped/off-viewport text (code region intentionally scrollable) |
| Service detail Overview | dark + light | PASS | h1 "postgres"; innerWidth=640; overflow=0px; no clipped/off-viewport text |
| Service detail Dependencies | dark + light | PASS | h1 "postgres"; innerWidth=640; overflow=0px; no clipped/off-viewport text |
| Service detail Resources | dark + light | PASS | h1 "postgres"; innerWidth=640; overflow=0px; no clipped/off-viewport text |
| Service detail Logs | dark + light | PASS | h1 "postgres"; innerWidth=640; overflow=0px; no clipped/off-viewport text |
| Service detail Configuration | dark + light | PASS | h1 "postgres"; innerWidth=640; overflow=0px; no clipped/off-viewport text |
| Service detail Configuration internals expanded | dark + light | PASS | h1 "postgres"; innerWidth=640; overflow=0px; no clipped/off-viewport text |
| NotFound | dark + light | PASS | h1 "Nothing here"; innerWidth=640; overflow=0px; no clipped/off-viewport text |
| TokenScreen | dark + light | PASS | h1 "Enter your API token"; innerWidth=640; overflow=0px; no clipped/off-viewport text |

**Result: 60 / 60 rows PASS (30 screens/states × 2 themes).**

## Keyboard and visual walkthrough checklist

Observation method: Chromium keyboard-driven interaction with DOM/computed-style inspection against the real mock stack; the "200%" rows above are the **real browser-zoom** pass (the 640 CSS-px automated sweep remains the reflow proxy and is certified separately).

### Cross-screen

- [x] Both themes: first Tab exposes **Skip to main content**; Enter focuses `#main-content`.
- [x] Rail navigation lands focus on the destination heading, including asynchronous route loading without a later focus steal (covered by the async-heading e2e in both promotion — including a heading that mounts later than the former 5s cutoff — and no-steal directions).
- [x] At 800px and 640px the rail is horizontal and keyboard-scrollable, shows an overflow affordance, wraps topbar actions, and stacks Map/Runtime above inspectors; pointer (wheel) scrolling of the nav is asserted too.
- [x] At 640 CSS px AND at real 200% browser zoom, routes have no document-level horizontal overflow, no off-viewport text, and no clipped/ellipsized identity or heading text; Settings `pre` remains intentionally horizontally scrollable.
- [x] Reduced motion leaves no infinite animation and preserves state visibility.
- [x] Visible focus treatment exists for links, buttons, fields, switches, tabs, graph nodes, and palette controls.

### Route-by-route (per-screen records)

The detailed per-screen keyboard observations below were first recorded at the `c2836e1` certification and remain valid at this tested commit: every behavior they record is re-verified at THIS SHA by the automated interaction story (skip link, route-heading focus, Map/Runtime selection+clear+relation focus, tabs, disclosures, palette), the 800/640 responsive sweeps, and the real-200%-zoom walk above — the remediation round changed the axe-matrix granularity, the 760px CSS block, model dependency-occurrence preservation, change-feed identities, focus handling, collision visibility, and Diagnostics tones, all of which are covered by the updated assertions. The real-zoom per-screen records above are the binding 200% rows.

- [x] **TokenScreen:** heading/label announced; token input and Connect are the only form stops; invalid-token alert announced; usable at 800/640 and 200% zoom.
- [x] **Home `/`:** read-only map has no focusable nodes; service links are collision-safe; empty/collided change-feed events and causal-chain steps render the explicit fallback as plain non-routable text (no `/services/` link for empty or collided identities).
- [x] **Map `/map`:** pressed filters, labelled network checks, keyboard graph nodes, Space-without-scroll, qualified clear label/focus return **on every clear including repeated clears of the same node**; hidden-selection clearing; collided id/name nodes visible with the collision tag and never interactive.
- [x] **Runtime `/runtime`:** pressed provider/layer/attention states, unique node selection, unavailable duplicate nodes with the collision tag/hint, qualified clear/focus return, relation navigation keeps focus on the destination node's button, detail links truthful.
- [x] **ServiceDetail `/services/postgres`:** arrow/Home/End moves among all five tabs; Enter/Space activates; one tab selected/focusable; panel name follows the active tab; Show/Hide internals retains focus and its target ID exists in both states; ambiguous/empty dependency occurrences render as visible non-routable rows with the collision tag when the alias collides.
- [x] **Changes `/changes`:** filters announce pressed state; timeline rows for empty/collided identities stay visible as plain non-routable text; routable events link in logical order.
- [x] **Copilot `/copilot`:** input is named **Ask Copilot**; empty/collided identities cannot become matches, suggestions, references, or routes.
- [x] **Networking / Network detail:** members remain visible with fallbacks; literal **not internal**; disclosure works in both states.
- [x] **Storage / Volume detail:** duplicate and empty consumer occurrences remain distinct and non-routable when ambiguous; disclosure works in both states.
- [x] **Images / Image detail:** named controls and semantic state dots; collided/empty consumers stay plain evidence; disclosure works in both states.
- [x] **Logs `/logs`:** service/level/search/live/load-older controls are named; long row metadata reflows (no clipped text at 800/640px or 200% zoom).
- [x] **Compose `/compose`:** literal severity and origin context visible; empty service/source/target fields use explicit fallbacks.
- [x] **Diagnostics `/diagnostics`:** severity/source/service/file text explicit; summary metrics and findings rows share ONE semantic palette (info→muted, warning→warn, error/blocked→error); Export JSON named and safe.
- [x] **Settings `/settings`:** five selects and two URL fields have associated labels and hints; switches retain names/checked state; code region scrolls rather than clipping.
- [x] **NotFound:** route exposes an `h1`; return link usable.
- [x] **CommandPalette:** combobox/listbox with no nested interactive options; background inert; Tab AND Shift+Tab contained; Escape restores same-route trigger; command navigation leaves restoration to route heading focus; open dialog and no-match empty state usable at 800/640 and 200% zoom.

## Remaining risk

The suite deliberately uses the mock stack for DOM/CSS semantics, uses focused web-model/client rendering regressions for empty, duplicate, and redaction-collided contract values, and exercises the async route-heading path by delaying the snapshot through Playwright routing. It does not mutate daemon/API fixtures or expand beyond the approved web-only scope. The recorded real-200%-zoom pass, browser matrix, raw Axe attachments, and required gates are green for the exact tested application commit; a maintainer may still repeat the visual walkthrough with their local OS zoom implementation before release.
