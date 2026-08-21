# Architecture pass 1: responsive and accessibility coverage (#35)

Status: Architect pass 1 of 2. This document is the implementation contract for the responsive/accessibility pass; deviation from an arrested lesson is a P1 finding unless Architect pass 2 amends the decision explicitly.

## Goal, scope, and verdict

Make every current DockerMap screen keyboard-usable, screen-reader coherent, usable at an approximately 800 CSS-pixel viewport and at 200% browser zoom, motion-safe, and contrast-compliant. Record repeatable axe and manual evidence, then pass `npm run check` and `npm run test:e2e`.

This is a **web-only audit/fix**: expected production changes are under `apps/web`, the root test dependency/script surface, `tests/e2e`, and the issue evidence document. No daemon, API, Rust, or wire-contract change is justified. The contracts already permit the empty/colliding strings found below; the web model and renderers can preserve that evidence and fail closed without changing the payload.

The pass is deliberately broader than “make axe green”: it re-audits the defect classes learned in #34 across every screen and traces the web model used by those screens. It does not add product features, write capability, a mobile redesign, or a new backend endpoint.

## Source audit and exploratory baseline

Code audited at `b62436b`:

- Routing/shell/overlays: `App.tsx`, `main.tsx`, `AppShell.tsx`, `CommandPalette.tsx`, `TokenScreen.tsx`.
- Shared semantics/graph: `primitives.tsx`, `Icon.tsx`, `identity.tsx`, `ServiceMap.tsx`, `styles.css`.
- Every route screen: Home, Map, Runtime, ServiceDetail (all five tabs plus internals), Changes, Copilot, Networking, NetworkDetail, Storage, VolumeDetail, Images, ImageDetail, Logs, Compose, Diagnostics, Settings, and NotFound.
- Model/hooks: `lib/model.ts`, `hooks/useApiResource.ts`, `hooks/useSystemModel.ts`, and the matching web tests.
- Browser harness: `tests/e2e/dockermap.spec.ts`, `dockermapHarness.ts`, and `playwright.config.ts`.
- Tooling: root/web package manifests and lockfile. Playwright exists; axe/Lighthouse does not. `@axe-core/playwright` is installable and currently resolves to 4.13.0 with `axe-core ~4.13.0` and a compatible `playwright-core >=1.0.0` peer.

An uncommitted exploratory Playwright + axe-core 4.13.0 probe against the real mock stack established the baseline; it is diagnostic, **not acceptance evidence**:

- At 800x900 the rail remains 248px because collapse starts only at 760px. The Map stage shrinks to 168px and its 166px client width clips 292px of overlay content. At 640px the existing top/horizontal rail activates and document-level horizontal overflow was zero on the normal mock routes.
- After a rail navigation, focus remains on the old navigation link; the new `h1` is not focused.
- Settings has seven controls without associated labels (five selects and two URL inputs). Axe reports `select-name` as a **critical** violation on the five selects.
- `ServiceMap` exposes focusable node buttons inside an SVG with `role="img"`; axe reports `nested-interactive`. Non-interactive Home/detail maps still expose those no-op buttons.
- CommandPalette puts a focusable button inside every `role="option"`; axe reports `nested-interactive`. The existing open-focus, Tab trap, Escape, and trigger restoration logic otherwise exists and must be retained.
- Dark mode also exposes a CommandPalette active-group contrast failure. Light mode exposes widespread serious contrast failures: `--muted-deep` text measured by axe at 3.23:1 on the rail and 3.64:1 on panels, the warning severity tag at 1.38:1, a healthy state pill at 1.58:1, and the light accent submit button at 3.32:1.
- Direct WCAG calculations confirm every current bright state token fails as normal text on light surfaces (healthy 1.70:1, warning 1.44:1, degraded 2.04:1, offline 2.78:1, updating 2.13:1, unknown 2.44:1 against white).
- The only infinite CSS animations are pulse and spin, and both are already inside `prefers-reduced-motion: no-preference`. No third infinite animation was found.

Acceptance scans must wait for a route-specific loaded heading/marker, not merely for `<main>`: an early exploratory scan observed transient loading markup and produced false missing-main/missing-h1 reports.

## Architecture decisions by issue area

### 1. Keyboard and focus management

| Surface | Current gap | Binding implementation pattern |
| --- | --- | --- |
| Route changes in `AppShell` | No route focus reset; focus stays on the initiating rail/link control. | Add a small `RouteFocusManager` driven by `useLocation()`. Keep a ref to the previous location, skip the first paint, and on subsequent pathname/search changes use a layout effect plus one animation frame to focus the loaded route `h1` (or `#main-content` fallback) with `tabIndex={-1}` and `preventScroll`, then reset `.content.scrollTop = 0`. Give `<main id="main-content">` a stable fallback target. Add a visible “Skip to main content” link as the first shell focusable. |
| CommandPalette modal | Focus trap exists, but listbox/options contain nested buttons; successful navigation can race trigger restoration against route focus. | Keep `role="dialog"`, `aria-modal`, initial input focus, Tab wrap, Escape, and cancel-time trigger restoration. Use a canonical combobox/listbox: input owns `aria-activedescendant`; each option is the single `role="option"` click target and contains no button. Mark the shell `inert` while open. Distinguish cancel/close from command navigation so trigger focus is restored only when remaining on the same route; route focus wins after a command navigates. No other modal/overlay exists. |
| ServiceDetail tabs | Five ordinary buttons in a nav; selected state and tab relationships are not exposed, and arrow-key behavior is absent. | Implement the manual-activation ARIA tabs pattern: `role="tablist"`, `role="tab"`, `aria-selected`, roving `tabIndex`, Left/Right and Home/End navigation, Enter/Space activation, and one stable `role="tabpanel" id="service-tabpanel"` labelled by the active tab. All tabs may control the same stable panel so inactive tabs never point to an unmounted ID and hidden tabs (especially Logs) are not mounted/fetched. |
| Detail disclosures | Network/Volume/Image/Service controls are inline disclosures, not dialogs. Their subject-qualified labels, state-synced `aria-expanded`, and always-mounted controlled wrappers are correct after #34. | Preserve those patterns. Enter/Space toggles, focus remains on the button, the label flips Show/Hide, and the controlled ID remains present collapsed and expanded. Scan Service Configuration and all disclosure expanded states, not only defaults. |
| Map/Runtime dynamic inspectors | Map clear-selection removes its focused control; both screens rely on many compact controls and have no global focus style. | Qualify the clear label with the selected entity. On Map clear, restore focus to the graph node that opened the inspector. Keep focus on Runtime node/relation buttons when the inspector updates. Add a shared `:focus-visible` ring for links, buttons, form fields, tabs, graph nodes, and switches; never remove the browser outline without a replacement. |
| Repeated navigation | No skip link. | The shell skip link becomes visible on focus and targets `#main-content`; rail links keep React Router’s `aria-current="page"`. |

### 2. Screen-reader names, roles, and state

| Surface | Current gap | Binding implementation pattern |
| --- | --- | --- |
| `StateDot` / `StatePill` | `StateDot` is always `aria-hidden`; state is lost in rows/chips where no textual state follows. `StatePill` already includes text. | Make `StateDot` semantic by default with `role="img" aria-label={STATE_LABEL[state]}` and add an explicit `decorative` flag. `StatePill` and callers that immediately print the same state word (Map filters/legend) pass `decorative`; standalone dots in shell health, inventory relationships, Home, Copilot, and image/container chips remain announced. Do not use `aria-live` for heartbeat changes. |
| Tags/severity | Tag is a neutral text wrapper and icons are already `aria-hidden`; severity tags are textual. Error/blocked currently reuse accent tone, and warning contrast fails in light mode. | Keep tags text-first and role-free. Add semantic severity tone mapping (`info`, `warning`, `error/blocked`) rather than treating error as accent. Preserve literal severity text so color is never the only signal. Test accessible text and both-theme contrast. |
| Icon-only controls | Map zoom/reset are named; Map/Runtime clear controls are only generically named. | Retain names on all icon-only controls and make dynamic names target-qualified, e.g. “Clear postgres service selection”. No icon supplies the name because `Icon` is intentionally `aria-hidden`. |
| Filters/selections | Map, Runtime, and Changes filter chips expose only visual `.is-on`; Runtime node selection is likewise visual. | Add `aria-pressed` to toggle/filter buttons and `aria-current` or `aria-pressed` to selected runtime node controls as appropriate. The visible label remains the accessible name. |
| Settings/Copilot forms | FieldRow text is not a `<label>`; Copilot relies on placeholder text. | Give every select/input a stable ID and explicit `<label htmlFor>` (visually hidden only where the design has no visible label). Hints use `aria-describedby` where useful. Keep switch `role="switch"`, accessible label, and `aria-checked`. Add a real “Ask Copilot” label; placeholder is guidance, not the only name. |
| ServiceMap semantics | Interactive descendants sit inside `role="img"`; `interactive={false}` still creates no-op focus stops. | For interactive Map use SVG `role="group" aria-label="Service dependency map"` and expose unique service nodes as buttons with visible keyboard focus and Enter/Space (prevent Space scrolling). For Home/detail read-only maps use `role="img"` and remove node roles, tab stops, and listeners. Keep a textual `<title>` for edges; relationship comprehension cannot depend on color alone. |
| Landmarks/headings | Rail and Map/Runtime inspector are multiple unnamed `aside` landmarks; Map’s empty inspector jumps to `h3`; NotFound has only an `h3`. | Name complementary landmarks (`aria-label="Application navigation and status"`, “Service inspector”, “Runtime inspector”), use an `h2` in the inspector, and render route-level NotFound/error/empty headings as `h1` while preserving `h3` for panel-local EmptyState. |
| CommandPalette | Options have invalid nested interactive controls. | Use the single interactive ARIA option structure above; keep combobox `aria-controls`, `aria-expanded`, `aria-autocomplete`, and an existing listbox ID in all open states. Empty results are non-option status text. |

### 3. Responsive behavior at ~800px

Current behavior is proven unusable on Map at 800px: the 248px rail leaves a 168px graph beside a fixed 320px inspector. Move the shell/narrow composition breakpoint from 760px to **900px** and keep one coordinated breakpoint rather than per-screen exceptions:

- At `<=900px`, switch the rail to the existing top/horizontal navigation treatment, preserve keyboard scrollability, and give it a visible overflow edge/scroll affordance. Wrap topbar search/status/auth without hiding actions.
- At `<=900px`, stack Map and Runtime graph/list above the inspector, stack screen headers, and let filters wrap. The graph stage uses the available width, never less than 320px on supported viewports.
- At `<=760px`, retain the denser phone/200%-zoom refinements: one-column detail impact/resource grids and full-width controls. Do not duplicate the shell switch there.
- Add `min-width: 0` and `overflow-wrap: anywhere` to long identity/title/value containers (`detail-id`, `screen-title`, `kv-value`, chips, diagnostics files, runtime metadata). Detail headers and panel headers wrap instead of forcing page overflow.
- Reflow `.svc-row`, feed/timeline rows, Copilot input, log controls, and long relation/mount rows. At the zoom breakpoint remove ellipsis/hidden clipping from runtime relation labels and log service names; place log time/service/level as wrapping metadata while preserving `white-space: pre-wrap` for the message.
- Keep settings `<pre>` as an explicitly horizontally scrollable code region; it is not clipped text. Every other document-level route must satisfy `scrollWidth <= clientWidth` at 800 and 640 CSS px.
- Map overlays (network selector, legend, impact, controls) wrap/reposition without overlap; the graph itself may pan/zoom, but overlay text must not be clipped.

### 4. Reduced motion

No ungated third infinite animation exists. Preserve the `no-preference` gates on pulse and spin and add a defensive `@media (prefers-reduced-motion: reduce)` rule that disables nonessential animation and transitions (`animation: none`, near-zero transition duration, `scroll-behavior: auto`) without hiding state. Add a browser check that, under `page.emulateMedia({ reducedMotion: "reduce" })`, no visible element has a computed non-`none` animation with an infinite iteration count. Map state updates remain immediate rather than animated.

### 5. 200% zoom and contrast

Treat a 640 CSS-pixel viewport as the automated reflow proxy for a 1280px browser at 200% zoom, then perform the real browser-zoom manual pass. Automated checks assert no document overflow and no visible text box with hidden/ellipsis clipping unless explicitly allowlisted as an intentional scroll region.

Split light-theme state usage from the dark Map canvas rather than weakening the target:

- In light theme set general state tokens to contrast-safe values: healthy `#08783e`, warning `#7a4b00`, degraded `#984500`, offline `#b42318`, updating `#1d4ed8`, unknown `#526174`, and `--muted-deep: #596579`. These values calculate at 5.58–7.41:1 against white and 4.70–6.16:1 on their 12% pill tints.
- Keep the Map’s intentionally dark canvas locally scoped to the existing bright graph/marker state palette so light-theme token darkening does not make graph nodes disappear on the dark map.
- Add `--on-accent`: dark-on-bright in dark theme and white on `#006d9c` in light theme (5.73:1). Use it for Copilot/auth primary buttons.
- Verify all normal/small text at 4.5:1, large text at 3:1, focus indicators and meaningful state dots at 3:1 against adjacent colors. Axe `color-contrast` must be clean in forced dark and light contexts. Textual state/severity labels remain mandatory even when contrast passes.

## #34 defect-class audit across all screens

The grep/read audit did **not** find a remaining dangling `aria-controls` in the four #34 disclosures: each target wrapper stays mounted. Network/Volume/Image disclosure labels and inventory detail-action labels are entity/subject-qualified. `useApiResource` still retains last successful data on refresh failure, and `useSystemModel` still rebuilds only from a same-generation snapshot/runtime pair.

It did find remaining instances of the other classes; #35 must fix the class, not only the first listed occurrence:

| Defect class | Current findings | Required closure |
| --- | --- | --- |
| Empty schema-valid identity/status strings | `Networking.members` and `Storage.attachedTo` render direct blank spans; ServiceMap, Home, Changes, Copilot, Logs options/rows, Runtime, and Compose expose direct service/node/name/status/source/target/port values; Diagnostics conditionally drops empty service/file evidence; CommandPalette can create “Go to ” and `/services/` from an empty service name. | Extend `lib/identity.ts` with entity-specific fallbacks (service role/status/port, runtime node/ID, Compose service/source/target, log source) and use one display value on every surface. Empty values remain visible plain text and never become a route, filter value, command, or selectable ambiguous node. Preserve `null` versus `""` (anonymous versus unavailable) where the contract distinguishes them. |
| Collision-safe model/routing (model trace) | `buildIdentityIndex` protects network/volume/image names, but `byName`, `byId`, runtime `byId`, and `idByAlias` are last-wins maps that admit empty/collided service/runtime identities. All service links consume those maps. | Reuse collision-safe indexing for service name/ID and runtime ID; expose collision sets in `SystemModel`/`RuntimeModel`; skip empty aliases and fail closed on duplicate aliases. Lists/graphs retain every occurrence with a collision tag, but route commands/links and ambiguous graph/runtime selection are suppressed. Add service-detail collision state parallel to network/volume/image detail. This is a web-model correction, not a contract/daemon change. |
| Collidable React keys | Bare contract-derived keys remain in Networking members, Storage consumers, ServiceMap services/network tracks, ServiceDetail relationships/ports/logs, Home services, Logs, Runtime nodes/evidence, Changes, Compose services/diagnostics/correlations, and CommandPalette service commands. | Every contract-derived rendered occurrence gets an occurrence-qualified key. For service/runtime rows, key by a UI occurrence key rather than assuming a raw ID is unique. Regression tests use the jsdom client reconciler and assert no duplicate-key warning; SSR-only tests are not accepted. |
| Occurrence-indexed correlation | VolumeDetail’s consumer/mount correlation is fixed. Remaining name/ID maps can still correlate every duplicate reference to one last-wins service/runtime node; ServiceMap’s duplicate network tracks also reuse a key. | Carry occurrence through UI rows/tracks and use only unique collision-safe model lookups for semantic joins. Ambiguous duplicate relationships stay visible unresolved/noninteractive; counts must equal rendered occurrences. Add duplicate service/runtime/network fixture assertions. |
| Dangling ARIA IDREFs | None in existing disclosures; CommandPalette listbox target exists while open. Service tabs currently have no tab IDREF contract at all. | Preserve disclosure tests collapsed/expanded. Use the single always-mounted `service-tabpanel` target for all tabs. Assert every `[aria-controls]` resolves in every tested state. |
| Unqualified/absent accessible names | Settings controls, Copilot input, hidden standalone states, visual-only filter selection, generic inspector clear labels, invalid palette option/button nesting. | Apply the semantic patterns above. Existing #34 entity-qualified inventory/disclosure names must not regress; test both disclosure states on every detail screen. |
| Truthfulness | `Networking.tsx` still labels every `internal === false` network “bridge”, although the snapshot proves only “not internal”. | Change the list label to literal “not internal”; the driver hint separately reports `driver` (or its fallback). Spot-check every touched label/count against model provenance. Preserve ImageDetail’s “Sample consumer status” and NetworkDetail’s “not internal”. |
| Fallback parity | Detail fallbacks are stronger than the Networking/Storage relationship lists and several non-detail screens. | A fallback constant/helper is not complete until list, detail, Map, Runtime, palette, Copilot, Logs, Compose, and diagnostics render sites agree. Add empty fixtures per surface/tab. |
| Stale docs | Greps found no residual “externally reachable” or “raw aggregate” rule; #34’s historical plan carries collision-safe amendments and the guarded mount predicate. | This plan is the #35 source of truth. Any pass-2 or implementation correction must update every repeated rule here and the final evidence doc in the same commit; run a residual-wording grep before certification. Do not rewrite historical narrative merely because visible button copy remains “Open detail” with a qualified `aria-label`. |

## File-level implementation map

1. **Shell and shared semantics** — `AppShell.tsx`, a small route-focus helper/test, `CommandPalette.tsx`, `primitives.tsx`, `ServiceMap.tsx`, `styles.css`.
2. **Model/identity closure** — `lib/model.ts`, `lib/identity.ts`, `components/identity.tsx` (or a narrow service identity helper), and model/client-reconciler tests. Keep `useApiResource.ts` and `useSystemModel.ts` behavior unchanged but re-run their tests.
3. **Screen fixes** — all screens named by the defect table, with priority to ServiceDetail, Map, Runtime, Settings, Networking/Storage/Images, Logs, Compose, Diagnostics, Home/Changes/Copilot, and NotFound. Preserve all tabs and disclosure states.
4. **Responsive/contrast/motion** — one coordinated styles pass in `styles.css`, including dark/light token tests or browser assertions.
5. **Evidence** — root dev dependency/lockfile, `tests/e2e/a11y.spec.ts` plus focused interaction/responsive tests, and `docs/testing/responsive-a11y-35-evidence.md` completed at the implementation HEAD.

Small reversible helpers are preferred over a framework/design-system rewrite. No dependency beyond `@axe-core/playwright` is needed; Lighthouse is not selected because axe integrates directly with the existing multi-route Playwright stack and yields route-level rule/node evidence.

## Axe and automated evidence contract

Add root devDependency `@axe-core/playwright@^4.13.0` and a convenience `test:e2e:a11y` script. Because `a11y.spec.ts` matches the existing Playwright config, the normal `npm run test:e2e` remains the acceptance gate and cannot silently skip accessibility.

`tests/e2e/a11y.spec.ts` must:

1. Start the real `startMockStack()` once per test group; use `domcontentloaded` plus a route-specific ready heading/content marker (never `networkidle`).
2. Scan fresh forced-dark and forced-light contexts with the default AxeBuilder rules. No blanket rule exclusions. Scan the loaded state of `/`, `/map`, `/runtime`, `/changes`, `/copilot`, `/networking`, `/networks/application`, `/storage`, `/volumes/postgres_data`, `/images`, `/images/python%3A3.11-slim`, `/logs`, `/compose`, `/diagnostics`, `/settings`, `/services/postgres`, and a NotFound route.
3. Separately scan all five ServiceDetail tabs, Service Configuration collapsed/expanded, all three other detail disclosures collapsed/expanded, and CommandPalette open. Hidden/unvisited content is not certified.
4. Assert **zero axe violations** on each scanned target (stronger than the acceptance minimum of zero critical). At minimum, a failure message must include route, theme, rule, impact, and node target. Any rule exception requires an inline rationale, Architect pass-2 approval, and evidence-doc disclosure.
5. Attach the full per-target axe JSON through `testInfo.attach`; aggregate route/theme totals into a deterministic JSON/Markdown summary. CI retains raw Playwright artifacts; the committed evidence document records the tested SHA, Node/npm, Playwright/Chromium, axe versions, command, per-route critical/total counts, and CI artifact/run reference.
6. Add 800x900 and 640x900 route sweeps that assert rail mode, Map/Runtime stacking, document horizontal overflow zero, and no hidden/ellipsis-clipped visible text outside the explicit scroll-region allowlist.
7. Add focused tests for route-heading focus, skip link, CommandPalette open/trap/Escape/restore/navigation, ARIA tab arrows/Home/End/activation, disclosures, `aria-pressed`, Map Space behavior/focus return, and reduced-motion computed styles.

The existing `dockermap.spec.ts` already navigates Home plus all listed spaces except Settings, follows all four detail types, exercises Map/Runtime selection, Logs controls, and uses CommandPalette. It does **not** certify keyboard-only behavior, focus-on-route-change, Settings, tab semantics, disclosure keyboard behavior, narrow/zoom layout, reduced motion, or axe. Extend it only where a behavior belongs to the smoke story; keep the audit matrix in the dedicated spec.

Mock-only axe is valid for DOM semantics and CSS, but does not exercise schema-edge identities. Use targeted web/jsdom fixtures for empty/collided/duplicate values and client reconciliation. Do not mutate the Rust/API mock merely to make axe find those classes.

## Committed manual keyboard and visual walkthrough checklist

The implementer copies this checklist into `docs/testing/responsive-a11y-35-evidence.md`, changes boxes only after observing the behavior at the final implementation SHA, and records browser/OS, theme, viewport/zoom, result, and notes. Keyboard means no pointer after each route starts.

### Setup and cross-screen checks

- [ ] Start the mock stack and record the exact commit/tool versions; verify fixtures contain no secrets before screenshots/evidence.
- [ ] In both dark and light themes at desktop width, Tab first exposes “Skip to main content”; Enter moves visible focus to `#main-content`.
- [ ] Traverse every rail item: order follows the visible navigation, focus is never obscured, active page is announced, and each route change lands focus on the new `h1` rather than leaving it in the rail.
- [ ] Repeat at 800 CSS px: the rail is the top/horizontal form, every item remains keyboard reachable/scrollable, topbar actions remain reachable, and no page/overlay text clips.
- [ ] Repeat representative long-content/detail/log/settings routes at real browser 200% zoom: no text or control is clipped, no two-dimensional page scrolling is required, and intentional code scrolling remains operable.
- [ ] Enable OS/browser reduced motion: no pulse, spin, or other infinite animation remains; state is still readable.
- [ ] Verify a visible, contrast-compliant focus indicator on links, buttons, inputs, selects, switches, tabs, graph nodes, and palette options.

### Route-by-route keyboard walk

- [ ] **TokenScreen (authenticated production fixture):** heading/label are announced; token input and Connect are the only form stops; submit progress is understandable; invalid-token alert is announced.
- [ ] **Home `/`:** map preview has no no-op focusable nodes; Needs attention, change, update, Runtime, and Map links have clear names and route focus works.
- [ ] **Map `/map`:** filter pressed states are announced; network checkboxes, graph nodes, zoom/reset, inspector links, and clear control work with keyboard; Enter/Space selects without page scroll; clear returns focus to the node; inspector and graph do not trap focus.
- [ ] **Runtime `/runtime`:** provider/layer/attention pressed states, node selection, detail links, relation buttons, and clear behavior are announced and operable; empty/collided nodes are visible but not ambiguously selectable.
- [ ] **ServiceDetail `/services/postgres`:** arrow/Home/End moves among Overview, Dependencies, Resources, Logs, Configuration; Enter/Space activates; one tab is selected/focusable; panel name follows the active tab. In Configuration, Show/Hide service internals retains focus and its target ID exists in both states.
- [ ] **Changes `/changes`:** each filter announces pressed state; timeline service links are reachable in logical order.
- [ ] **Copilot `/copilot`:** input has the “Ask Copilot” name; Ask and suggestions work; result/reference links are announced and route focus works.
- [ ] **Networking `/networking` + `/networks/application`:** all unique network/service links are reachable and qualified; state is announced; “not internal” is literal; empty/collided evidence is visible and non-routable; network disclosure works in both states.
- [ ] **Storage `/storage` + `/volumes/postgres_data`:** filter is named; unique links and consumer state are announced; duplicate/empty consumers remain distinct; volume disclosure works in both states.
- [ ] **Images `/images` + `/images/python%3A3.11-slim`:** sort/filter are named; image/container links and states are announced; empty/collided references stay plain; image disclosure works in both states.
- [ ] **Logs `/logs`:** service, level, search, Live tail, and Load older are named and operable; filter changes do not steal focus; long lines and service names reflow at narrow/zoom widths.
- [ ] **Compose `/compose`:** every service/diagnostic/correlation remains visible with empty fallbacks; row order and text remain readable at zoom; no false route affordance is created.
- [ ] **Diagnostics `/diagnostics`:** severity/source/service/file text is explicit, contrast-compliant, and not color-only; Export JSON has a clear name and retains safe focus behavior.
- [ ] **Settings `/settings`:** every select and URL input is announced by its visible label/hint; both switches announce name and checked state; Reset works; controls reflow at 800/200% without clipping.
- [ ] **NotFound:** route has an `h1`; Back to Command Center routes and focuses correctly.
- [ ] **CommandPalette from rail and content triggers:** Ctrl/Cmd+K focuses the combobox; arrows update the active option; Enter runs it; Tab/Shift+Tab cannot leave the dialog; Escape closes and restores the same-route trigger; command navigation closes without restoring stale focus and the destination `h1` receives focus; empty results remain understandable.

## Verification and recorded evidence

Implementation completion requires, in order:

1. Focused web/model/client-reconciler tests, then `npm run test:web`.
2. `npm run test:e2e:a11y` during iteration and the full `npm run test:e2e` at the final HEAD.
3. `npm run check` at the same final HEAD.
4. Complete `docs/testing/responsive-a11y-35-evidence.md` with exact command results, per-route axe totals (zero critical and zero total), completed manual checklist, dark/light + 800px + 200% + reduced-motion observations, and remaining risk. Record failures honestly; do not call an early/transient scan a pass.
5. After any remediation commit, re-run affected tests and both full gates and regenerate/reconcile the evidence for the new SHA. A certification belongs only to the exact HEAD it scanned.

`npm run test:live-docker` and `npm run build:deploy` are not required by issue acceptance because this plan changes no daemon/API/deployment behavior. If implementation crosses that boundary, Architect pass 2 must amend scope and the live-Docker gate becomes mandatory.

## Arrested lessons

Recurring entries are first. Every disposition is binding.

### Recurring generic/project entries

- **G-01: Spec-conformance is NOT sufficient — schema-escape hatches.** Arrested by fixtures with empty, duplicate, long, and redaction-collided strings at every model/render consumer; bad-but-valid data fails closed at routing and never crashes or disappears.
- **G-02: Mock masks reality — verify library claims against the installed source.** After install, verify `@axe-core/playwright`/axe APIs and the actual browser accessibility behavior, not a mock wrapper. The exploratory probe used real Chromium and real axe.
- **G-06: Cohort-scoped numerators AND denominators.** N/A — no cohort/rate computation is introduced. Axe totals are per exact route/theme target, never a global numerator over a partial route count.
- **G-08: Fix sweeps can introduce regressions — verify prior fixes are CORRECT, not just present.** Re-run #34 empty/collision/IDREF/name/occurrence tests and re-grep all render sites after each sweep; test correct visibility/routing behavior, not only presence of a prior line.
- **G-09: Never trust implementer-reported balance/telemetry numbers.** Re-run axe/gates and record raw versions/results at final HEAD; do not copy PR prose as evidence.
- **G-12: A committed visual baseline is not a gate until proven enforced.** N/A — this pass uses layout/overflow assertions and observation, not pixel baselines. Screenshots are evidence attachments only.
- **G-14: Resolve architecture “Open questions” before dispatching the implementer.** Resolved: axe integration, route matrix, breakpoints, focus target, tab pattern, contrast values, evidence path, and backend verdict are all decided below; there are no implementer judgment calls.
- **DM-02: E2E harness quirks.** Use actual mock text, `domcontentloaded` plus explicit ready markers, unique locators/control classes, no `networkidle`, and no API/query/route patch. The audit spec starts the existing mock stack.
- **DM-04: Rust/clippy conventions are enforced by the gate.** N/A — no Rust change. Any scope crossing requires fmt-before-clippy/test and Architect pass-2 approval.
- **DM-05: Empty schema-valid identities must stay VISIBLE but NON-ROUTABLE.** Arrested across every screen/tab/model map via entity fallbacks, collision-safe service/runtime indexes, non-empty routing/filter/command gates, occurrence keys, null-versus-empty handling, and full fixture tests.

### Remaining generic entries

- **G-03: Mock-path e2e assertions must use real mock output text.** Existing smoke terms remain `traffic`/`attached`/`dependencies`; new assertions use actual fixture headings/entities.
- **G-04: Authored cost is not observed tradeoff.** N/A — no balance/tradeoff system.
- **G-05: Score saturation hides counterweights.** N/A — no scores.
- **G-07: Dense-index cycling under round-robin allocation.** N/A — occurrence indexes identify render/correlation rows, not allocation cycles.
- **G-10: A targeted policy must not co-trigger another event.** N/A — no selector-event policy.
- **G-11: Batch session ids do not seed sim RNG.** N/A — no simulation/RNG.
- **G-13: Every visual-matrix cell must genuinely exercise its gated effect.** No visual baseline matrix; dark/light, 800/640, expanded/collapsed, and reduced-motion cells each have explicit behavior assertions and ready markers.
- **G-15: Regression tests can codify the new bug.** Tests assert correct behavior resumes: route focus reaches the heading, modal cancel restores focus, modal navigation does not, tab focus/activation works, and empty evidence stays visible while routing is suppressed.
- **G-16: Derived-artifact cache keys must cover every input that changes output.** N/A — no cache. Occurrence UI keys include raw identity plus occurrence and never become semantic lookup keys.
- **G-17: Render targets must be validated at the REAL rendered size.** Automated 800/640 sweeps plus manual real 200% zoom and dark/light inspection are mandatory.
- **G-18: Nominal acceptance is not acceptance — task the reviewer with the verdict.** Observable verdicts are zero axe violations per target, focus assertions, overflow/clipping assertions, no infinite reduced-motion animation, complete manual boxes, and both gates green.
- **G-19: Falsy/empty values must have explicit fallbacks at EVERY render site.** The class audit enumerates remaining sites; list/detail/Map/Runtime/palette/Copilot/Logs/Compose/Diagnostics parity and empty fixtures are required.
- **G-20: Correlation joins must be occurrence-indexed, not name-only.** Duplicate service/runtime/relationship occurrences cannot resolve through last-wins maps; occurrence is carried through rows/tracks and counts equal evidence.
- **G-21: React keys must be collision-proof — unrestricted string IDs are not keys.** All contract-derived arrays use occurrence-qualified UI keys and client-reconciler tests; SSR-only proof is rejected.
- **G-22: Accessible names must be entity-qualified and state-synced.** Preserve #34 inventory/disclosure names; add qualified inspector names, real form labels, semantic states, pressed/selected state, and both disclosure states.
- **G-23: Spec/planning docs must not retain superseded rules after implementation corrects them.** Pass 2 and remediation update all repeated wording plus evidence in the same commit; residual greps are part of final certification.

### Remaining DockerMap entries

- **DM-01: AGENTS.md invariants are non-negotiable.** Web-only, read-only behavior; no command, filesystem scan, secret publication, daemon bind, or compose-write change. Evidence uses redacted mock data.
- **DM-03: Live-Docker evidence is the release gate.** N/A while scope remains web-only; becomes mandatory if daemon/API behavior changes.
- **DM-06: Truthfulness — labels must not claim more than the snapshot proves.** Replace Networking’s false “bridge” inference with “not internal”; preserve sample-status qualification and audit every changed label/count against provenance.
- **DM-07: Diff-scoped review must trace the MODEL/HOOK layer, and re-certify after the branch moves.** Hooks were re-read and their retention/generation fixes are preserved; model service/runtime identity gaps are in scope. Every new HEAD after a certification reruns the diff-scoped class grep, model tests, axe matrix, and gates.

## Risks and Architect pass-2 review targets

1. **Scope pressure from model identity fixes:** service/runtime collision-safe lookup is proven and web-only, but touches many consumers. Pass 2 must verify no UI occurrence becomes silently invisible and no ambiguous identity remains routable/selectable.
2. **Focus ordering race:** CommandPalette close restoration and route focus effects can fight. The two explicit navigation/cancel e2e cases are release-blocking.
3. **Axe timing:** SSE prevents `networkidle`; scanning loading markup creates false results. Every route/tab needs a deterministic ready marker.
4. **Light tokens on the dark Map:** general light-theme state colors cannot be reused blindly on the fixed dark canvas; verify the local Map palette and non-text contrast.
5. **Mock coverage:** normal mock axe proves structure/style, not schema-edge identities. Client/jsdom fixtures are mandatory and must match real contract semantics.
6. **200% automation is a proxy:** 640px catches reflow but not every browser/OS zoom behavior. The completed real-zoom manual row is mandatory evidence.
7. **Horizontal mobile rail:** keeping every route visible via horizontal scrolling is acceptable only if keyboard focus scrolls items into view and an overflow affordance is visible.
8. **Evidence drift:** raw artifacts and Markdown summary must name the exact tested SHA. Any remediation invalidates prior certification and requires re-run/reconciliation.

There are no open architecture questions for the implementer.
