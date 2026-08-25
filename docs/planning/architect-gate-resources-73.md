# Architecture — #73 Gate CPU/memory/network resource stubs to demo mode

**Slice:** #73 (child of epic #61 *Make live-state claims evidence-backed*).
**Branch:** `codex/gate-resource-stubs-issue-73`, cut from `main` @ `2285d49` ("Gate synthetic change history to demo mode (#74) (#80)"). Tree clean at authoring time; every line cited below was re-read on THIS tree.
**Binding precedents:** `architect-evidence-vocab-71.md` §D9 (`:258-263`), §D10 consumption map (`:265-284`), §Q12 (`:316`), §G-23 (`:334`); `architect-update-claims-72.md` (claim-module shape, U3 single-claim rule); `architect-gate-history-74.md` §2 Q1/Q5/Q6/Q7/Q9 (`:70-121`, `:174-186`, `:187-212`, `:213-221`, `:231-236`), §7 checklist (`:390-408`), §8 V1-V6 (`:412-423`), §9 Option A+ (`:427-443`).
**Registers:** `register-generic.md` (G-01…G-38), `register-dockermap.md` (DM-01…DM-12). Per-lesson prose is NOT re-documented here (#72 U9) — §6 names where each is discharged.

**This document is BINDING on the implementer.** Any deviation is a P1 finding unless the deviation is first amended *into this file* in the same PR (G-14, G-23). There are no open questions and no implementer product calls.

**Scope guard:** web-only. ZERO changes to `packages/contracts`, `crates/`, `apps/api`. No new endpoints, no network calls, no new fetch — the runtime stays network-quiet (DM-01). The touchable set is exactly: `apps/web/src/lib/stubs.ts`, a new `apps/web/src/lib/resources.ts`, `apps/web/src/screens/Home.tsx`, `apps/web/src/screens/ServiceDetail.tsx`, `apps/web/src/components/primitives.tsx` (`Bar` accessible name only), `apps/web/src/styles.css` (two rules, §4.6), `apps/web/src/lib/test-utils.ts` (one exported literal table), the new test files named in §8, `tests/e2e/a11y.spec.ts`, `docs/design/DESIGN.md`, `docs/design/DESIGN_LANGUAGE.md`. `lib/model.ts`, `SystemModel`, `buildModel`, `context.tsx`, `hooks/`, and `components/AppShell.tsx` are **unchanged** — #74 already shipped the provenance sidecar this slice consumes.

**No-overlap with #74/#75/#76:** #73 touches no change/causal surface and has **no exception** to that rule. `maySynthesizeHistory`, `changeFeed`, `causalChain`, both history generators, `CHANGE_TEMPLATES`, `screens/Changes.tsx`, `lib/history.ts`, and `lib/copilot.ts` are not renamed or edited. Resources get a new file-local predicate whose policy is intentionally narrower (§2 Q2.4).

**Issue-policy status:** issue #73 remains unamended. Its literal boundary controls this plan: resource samples are available **only** under the exact `(demo, demo)` pair. Daemon/API mock mode, live mode, unresolved values, and every mode/provenance mismatch are unavailable.

**Provenance of the issue text:** `gh` is unauthenticated in the authoring environment (`gh auth login` required), so issue #73's title and body are taken from the six-explorer handoff synthesis (`/tmp/dm73-architecture-handoff.md`) rather than re-fetched first-hand: title *"Gate CPU/memory/network resource stubs to demo mode"*, body *"samples ONLY in explicit demo/sample mode"*. Every other claim in §1 is verified against files on this tree. If the issue body diverges from that quote, §2 Q2 is the decision to re-check first.

---

## 1. Verified current state (file:line, re-read on this tree)

### 1.1 The synthetic source — `apps/web/src/lib/stubs.ts`

| Line | Artifact | Note |
|---|---|---|
| `:6-16` | Header doc-comment: "*Every surface that renders this data marks it as estimated (see the `STUB_NOTICE` copy) so it is never mistaken for live telemetry*" | **Already false today** at `Home.tsx:159` (bare bar, no notice). #71 G-23 (`:334`) binds #73 to rewrite it in the same commit. |
| `:18` | `export const STUB_NOTICE = "Estimated — live resource collectors not yet wired"` | Deleted by this slice (#71 Q12 `:316`, #74 Q7 `:219`). |
| `:20-28` | `interface ResourceSample` — `cpuPercent`, `memoryPercent`, `memoryMb`, `networkKbps`, `cpuSeries: number[]`, **`estimated: true` `:27`** | `estimated` is the weaker parallel vocabulary #71 D9 (`:263`) forbids extending; deleted by this slice. The other five fields survive as the claim's value shape. |
| `:30-47` | `resourceFor(service: Service): ResourceSample` — **no mode/provenance parameter at all** | The exact #73 defect: no gate exists, in contrast to the gated `changeFeed` `:108-112` / `causalChain` `:154-158`. |
| `:32,:37,:41,:43` | `service.state === "offline" ? 0 : …` on load, series, memoryPercent, networkKbps | Offline ⇒ literal `0`. Under today's ungated call this is a **live** `0` that renders as a measured "no load" (R1). |
| `:31,:33,:36,:43` | `hashString(service.id)` / `+ "mem"` / `` `${service.id}:${i}` `` / `+ "net"` | Everything is hash-derived from the service id, state and kind. Deterministic, clock-free. |
| `:100-106` | `maySynthesizeHistory(mode, modelProvenance)` — `claimAuthority(mode) !== "sample"` → false; then exact pairs `(demo,demo) \| (mock,mock)` | #74's shipped gate predicate. #73 reuses it verbatim under a new name (Q2.4). |
| `:108-128`, `:154-176` | `changeFeed` / `causalChain` returning `Claim<…>` | #74's shape, the template this slice mirrors. Bodies untouched by #73. |

**`resourceFor` calls no clock and touches no module state**: it is a pure function of `(service.id, service.state, service.kind)`.

### 1.2 Consumers — complete, repo-wide

Repo-wide grep over `apps/`, `packages/`, `tests/`, `crates/` for `resourceFor|ResourceSample|STUB_NOTICE|cpuPercent|memoryPercent|memoryMb|networkKbps|cpuSeries`:

- `apps/web/src/lib/stubs.ts:18,20,30` — the source.
- `apps/web/src/screens/Home.tsx:18` (`import { resourceFor }`), `:145` (`const res = resourceFor(service)` inside `ServiceRow`), `:159` (`<span className="svc-res"><Bar value={res.cpuPercent} state={service.state} /></span>`). `ServiceRow` receives only `{ model, service }` (`:143`).
- `apps/web/src/screens/ServiceDetail.tsx:7` (`import { resourceFor, STUB_NOTICE }`), `:211` (`const res = resourceFor(service)` inside `Resources({ service })` `:210`), `:213` (`<Panel title="Resources" icon="cpu" hint={STUB_NOTICE}>`), `:214-227` (`.res-grid` → CPU `Metric`+`Sparkline` `:216-217`, Memory `Metric`+`Bar` `:220-221`, Network `Metric`+`Icon` `:224-225`).
- **Nothing else.** Zero hits in `packages/contracts`, `apps/api`, `crates/`, `tests/`. The web-only scope claim is verified, not assumed.

Threading status: `Home.tsx:22` already destructures `{ model, modelProvenance, loading, error, evidenceMode }` — both gate inputs are in scope, and only `ServiceRow`'s props must grow. `ServiceDetail.tsx:27` destructures `{ model, loading, error, tick }` only — it **must** add `evidenceMode, modelProvenance`; without that it cannot gate at all.

### 1.3 Machinery already shipped by #71/#72/#74 (verified, reused as-is)

- `lib/evidence.ts` — `EvidenceKind` `:5`; `EVIDENCE_LABELS` `:21-27` (`demo` → label **"Sample data"**, `unavailable` → label **"Not collected"**, description "DockerMap does not collect this yet"); `evidenceLabel` `:30-39` (fail-closed `Object.hasOwn`, throws on unknown); `EvidenceMode = "live"|"mock"|"demo"` `:42`; `ModelProvenance = "demo"|"mock"|"live"` `:50` (the #74 Option A+ three-state vocabulary, G-38); `claimAuthority` `:88-92` (`live`→`host`, `demo|mock`→`sample`, `null`→`none`); `Claim<T>` `:95-97` with the `{ kind: "unavailable"; value: null; detail: string }` arm; `nonEmptyDetail` `:99-104` (throws on empty); `demoSample` `:119-121`; `unavailable` `:123-125`.
- `context.tsx:6-16` — `modelProvenance: ModelProvenance | null` `:9` and `evidenceMode: EvidenceMode | null` `:14`, both **required** fields, reaching every screen through `useApp()` `:20-24`.
- `hooks/useApiResource.ts:23` provenance field, `:53` stamped at fetch start, `:76` published with data, `:87-88` retained-with-original-stamp on refresh failure. `hooks/useSystemModel.ts:38-53` — publishes NEITHER model nor provenance unless snapshot/runtime generation **and** provenance match (`:40-41`, `:50-52`); a retained model keeps the provenance it was actually fetched with.
- Claim-module precedents to mirror exactly: `lib/updates.ts:19` (internal detail const), `:26` (single public claim object, U3), `:29` (derived label); `lib/history.ts:7-8,11,14` (`Object.freeze`d claim singletons), `:17`.
- `components/primitives.tsx` — `Panel.hint` `:63` renders `{hint && <span className="panel-hint">…}` (**falsy-suppression site**, G-19); `Metric` `:82-90`; `Sparkline` `:92-103` (`aria-hidden`); **`Bar` `:105-111`** — `role="img"` with `aria-label={`${Math.round(value)} percent`}` `:107` and `width: Math.max(2, …)%` `:108` (**a 2% sliver renders for value 0**); `EmptyState` `:113-124`.
- `lib/test-utils.ts` — `visibleText(html)` strips markup so assertions target visible text, never a `title` attribute.

### 1.4 Tests and e2e this slice moves

- **There is no resource coverage in the tree today.** Zero test files import `resourceFor`, `ResourceSample`, or `STUB_NOTICE`; zero hits for `svc-res`, `res-grid`, or `"Estimated"` in tests. This slice adds the first ones.
- Templates to port, verbatim in structure: `lib/no-synthetic-history.test.ts` (13-pair hard-coded `PROVENANCE_MATRIX` `:22-36`, clock-spy `:65-85`, G-37 literal probes `:87-94`), `screens/history-wiring.test.tsx` (hoisted mutable `state` `:24`, four `vi.mock`s `:25-30`, real `AppShell` in `MemoryRouter` `:34-36`, model-held flips `:39-125`, DM-05 sentinel `prod-secret-host` `:16-20`), `screens/history-surface.test.tsx` (`renderToStaticMarkup` + `visibleText` `:26-29`, pair tuples `:34,:51`).
- `screens/updates-surface.test.tsx:34-36` — the **scoped-numeric** assertion pattern (`html.match(/<div class="metric metric-updates">…/)` then assert no digit-only value). Home renders four legitimate numeric metrics, so any "no numbers" assertion on Home MUST be scoped this way or it is false; on a scoped-out region it would be vacuous.
- `screens/collision-graph-runtime.test.tsx:138,156`, `duplicate-list-keys.test.tsx:226,240` — prove `<ServiceDetail defaultTab="…" />` is the supported way to render a non-default tab in a static test. **`ServiceDetail`'s default tab is `overview` (`:25`, `:28`), so a Resources assertion that does not activate the tab is vacuous (R4).**
- `tests/e2e/a11y.spec.ts` — `coreRoutes` `:10-28` (includes `["home","/"]` and `["service-detail","/services/postgres"]`); per-tab axe scans `:100-110` (`for (const tab of ["Overview","Dependencies","Resources","Logs","Configuration"])`, both themes); responsive stateful cells `:425-429` (same five tabs at both widths); `attachAxe(page, testInfo, target)` `:60`; **the live-authority SSE-intercept pattern `:540-565`** (route `**/api/events/stream*`, one `event: snapshot` frame with `"mode":"docker"`, assert `.conn-mode` = "Docker Engine", `page.unroute` after); the demo init-script pattern `:567-585`.
- `tests/e2e/dockermap.spec.ts` asserts no resource values today; nothing there breaks.
- `docs/design/DESIGN.md:117-118` — "*Estimated data (resource samples, change history) is always labelled as estimated until real read-only collectors back it*". `docs/design/DESIGN_LANGUAGE.md:113-119` — the "Estimated Data" section, which **names the exact `STUB_NOTICE` string** and folds in edge health. `DESIGN_LANGUAGE.md:36,54` embed `command-center.png` / `service-detail.png`; `:121-130` documents a capture command whose spec "*is added when refreshing screenshots and is not part of the committed test suite*".

### 1.5 Decisive negative findings (checked, not assumed)

1. **Nothing real exists to gate "on".** There is no CPU/memory/network field anywhere in `packages/contracts/src/index.ts`, `apps/api/src/*`, `crates/dockermap-daemon`, `lib/model.ts`, or `lib/demoData.ts`. Every resource number in the product is produced by `stubs.ts:30-47`. So `resourceFor` is not "the mock path" for a real collector — it is the *only* path, in every mode.
2. **The daemon mock emits no resource bytes either.** Mock mode fabricates a topology; it measures nothing. This is L5's dissent and it is factually correct — see Q2 for why it does not change the ruling.
3. **The e2e stack resolves to `mock`, never `live`** (`dockermapHarness.ts:356` sets `DOCKERMAP_FORCE_MOCK: "true"` unless `useDockerAccess`; the daemon honours it at `crates/dockermap-daemon/src/main.rs:410-412`; `dockermap.spec.ts` asserts the "Mock Engine" pill; `claimAuthority("mock") === "sample"`). Any assertion written as if the default stack were live is wrong (R3). The `:540` intercept is the only in-tree way to reach live authority in a browser.
4. **`Bar` is used at exactly two sites** (`Home.tsx:159`, `ServiceDetail.tsx:221`) — both are resource sites owned by this slice. Its unqualified `aria-label` ("0 percent" / "45 percent") is therefore a #73-owned overclaim for assistive-tech users, not a cross-slice primitive concern (Q3.5).
5. **Edge health is NOT this slice's.** `model.ts:475-482` derives `RelationshipHealth` from the *observed* `target.state` — real data, `derived` kind. `DESIGN_LANGUAGE.md:115` wrongly bundles it with "estimates"; #73 corrects that sentence (docs only) and assigns the evidence-tagging of edge health to #75/#76. No code change.
6. **`resourceFor` reads no clock**, so #74's `Date.now()` re-roll problem (its R4) and its memo requirement (its R1) do not apply here. This slice adds **no `useMemo`** (Q3.5).

---

## 2. Decisions — Q1-Q9 resolved, every handoff dissent quoted and ruled on

### Q1 / dissent (a) — Gate shape: **source-gate inside `resourceFor`, taking required mode + required provenance, returning `Claim<ResourceSample>`. Option C (thin wrapper) and Option B (render-gate) are REJECTED.**

> **L6:** "Option A — gate inside `resourceFor(service, mode, prov): Claim<ResourceSample>`: exact #74 mirror… Cost: signature change; synthesizer becomes impure; when real collectors land the contract changes again. Option B — render-gate only… 'a render-gate leaves an unsafe generator callable' (G-24 fail-closed). No precedent support. Option C — thin gated wrapper: keep pure `resourceFor(service)`; add `resourceClaim(service, mode, prov)` … Cost: two functions; fail-open risk if a future dev calls `resourceFor` directly. Pros: purity boundary = the future real-telemetry swap point."
> **L2:** "Gate at claim level (new `resourceClaim` mirroring `changeFeed`) vs render-site — docs `:275-276` imply claim-level."
> **#71 D10 `:275-276`:** `stubs.ts:29 resourceFor output | demo / mock → demo`; `ServiceDetail.tsx:210-212 Resources panel, Home.tsx:167,178 CPU bar | live → unavailable; the Home bar (unqualified today) is the priority site`.

(#71's line numbers predate #72/#74's edits — G-23 drift, not a second site. On this tree the same three sites are `stubs.ts:30`, `ServiceDetail.tsx:210-213`, and `Home.tsx:145,159`; §1.1-1.2 are the authoritative citations.)

**Ruling: Option A.** D10 assigns an outcome to the *source* row as well as the two render rows; one gate satisfies all three. Three decisive arguments:

1. **G-24 fail-closed.** Option C's whole cost is its whole defect: it leaves an **exported, ungated synthesizer** in the module. The register's arrest for G-24 is "the design must name the fail-closed branch explicitly" — the only construction in which a bypass is impossible is one where no ungated synthesizer is exported. Option C's fail-open hole is not hypothetical: `resourceFor(service)` would still compile at any future call site and return numbers, and no test can prove the absence of a call that has not been written yet. Option B is worse (two render-side gates to keep in sync, and the same callable generator) and has no precedent support.
2. **One shape for one class.** `stubs.ts` already contains two gated generators with exactly this signature (`:108-112`, `:154-158`). Introducing a second gate shape for the third generator *in the same file* is the "weaker parallel vocabulary" defect #71 D9 (`:263`) rules against, one level up from field names.
3. **Purity is preserved where it matters.** Option C's stated advantage — a pure synthesizer — survives Option A intact: the private body remains a pure hash function; only the exported boundary carries the gate. Purity of an internal helper is not a product property; the *exported* contract is.

**Binding signature** (`lib/stubs.ts`), name unchanged (#74 kept `changeFeed`/`causalChain`; a rename adds churn and breaks grep continuity with the issue and #71 D10):

```ts
export function resourceFor(
  service: Service,
  mode: EvidenceMode | null,
  modelProvenance: ModelProvenance | null
): Claim<ResourceSample>;
```

Sub-decisions, all binding:

1. **Both parameters are required.** No default, no optional parameter, no `?? "demo"`. Call sites pass the two `useApp()` values straight through; they never derive, hard-code, or relabel provenance (#74 Q1.1; #71 R4).
2. **The guard is positive allow-listing** and runs **before** any hash or field read — never `mode !== "live"`, never `provenance !== "live"`, never authority alone. A future mode or provenance value inherits the unavailable arm (G-01).
3. **Return plain `Claim<ResourceSample>`.** Do not narrow with `Extract<Claim<T>, { kind: "demo" | "unavailable" }>` — it silently evaluates to `never` for the value arm (#74 R2). Call sites narrow on `kind === "unavailable"` first.
4. **The synthesis body is otherwise unmodified** — same hash seeds, same offline branches, same 24-point series. #73 gates the sample; it does not redesign it (Q6).

### Q2 / dissent (b) — Sample policy: **the only allow-listed pair is `(demo, demo)`. Mock/live/null/all mismatches are unavailable.**

> **Issue #73:** title "…to **demo mode**"; body "samples ONLY in explicit **demo/sample** mode".
> **L6:** "`claimAuthority` counts mock as `sample` (evidence.ts:90); #74 admits demo+demo **and** mock+mock (stubs.ts:102-105)… The e2e mock stack resolves to **mock**, never live — a demo-only gate silently flips the e2e product to 'Not collected' (no e2e asserts resource bars today, so nothing would catch it)."
> **L4:** "#71 plan table says resources gate on `demo/mock mode + demo provenance` (`:275`), but #74 implemented `(mock,mock)`… Either is defensible — must be explicit."
> **L5:** "daemon mock emits no resource bytes → `mock/mock` must be **unavailable** (updates-style), else synthetic bars appear in the mock path — matrix must pin this or it's a G-01 schema hole… copying #74's `mock/mock` without daemon resource bytes fabricates telemetry in the mock path."

**Ruling: `(demo, demo)` only.** The issue says explicit demo mode and remains unamended. `mock` is a daemon/API-backed path that can be entered automatically by Docker→mock fallback; it is not explicit demo selection. `claimAuthority("mock") === "sample"` is evidence vocabulary, not authorization to broaden this resource policy. #74's history rule is intentionally separate and does not amend #73. L5's factual point controls resources: the mock daemon emits no CPU, memory, or network observations, so `(mock, mock)` must report non-collection.

The resulting mixed mock screen is intentional and truthful: #74 history may show tagged sample events while #73 resources say they are not collected. Evidence kind is claim-specific; equal mode/provenance inputs do not imply every data family has the same acquisition capability. V5 must expose this default-stack outcome rather than preserve the old bars.

Sub-decisions, all binding:

1. **The other fifteen pairs are unavailable** — `(mock,mock)`, `live` with any provenance, either `null`, and every mismatch (`demo`+`live`, `mock`+`demo`, …). Sixteen pairs total, one allow-listed pair, no exceptions (§9 V1).
2. **Use one positive exact-pair check.** `mode === "demo" && modelProvenance === "demo"` is the entire resource authorization. Never infer permission from `claimAuthority`, and never express this as a negative live/mock check. A retained live or mock model under freshly selected demo authority stays unavailable (DM-06/G-38).
3. **No new provenance scheme, no new mode value, no fourth `EvidenceKind`.** #74's three-state `ModelProvenance` (`evidence.ts:50`) is final for this epic.
4. **Resource-private predicate; history untouched.** Add file-local, unexported `maySynthesizeResourceSample(mode, modelProvenance)` returning exactly the positive check above, and call it only from `resourceFor`. Do **not** rename, edit, import, or reuse #74's `maySynthesizeHistory`; do not touch either history generator or its tests. The policies differ, so sharing a predicate would be false deduplication and unauthorized #74 churn. V6 diff-reads and reruns the history suites to prove zero behavioural overlap.

### Q3 / dissent (c) — Home row: **unavailable is visibly and accessibly CPU-qualified; the bar exists only for `(demo,demo)`.**

> **L6:** "Home row (`Home.tsx:159`) is a compact bar with no label — unavailable needs a non-empty label (G-19), likely bar→'Not collected' text, layout impact."
> **L1 (Q3):** "Does the Home bar need the evidence label ('Sample data') visible, or is the unavailable EmptyState/detail enough for live?"
> **L2:** "#71 doc `:54,276` calls it priority site."

**Ruling, in six parts.**

1. **Unavailable arm: no `Bar`, no number, no `%` — exact visible text `CPU not collected`.** Build it from the evidence label (`CPU ${evidenceLabel(resources.kind).label.toLowerCase()}`), not a second hand-written evidence label. Visible text supplies the accessible name; do not hide the CPU qualifier in `title`, CSS-generated content, or an aria-only duplicate. Keeping the bar with a zero/absent value is the R1 hazard in its purest form: `primitives.tsx:108` renders a 2%-wide sliver for `0` and `:107` announces "0 percent" — a measured claim of idleness. Removing the cell entirely is also rejected (G-19).
2. **Sample arm: the bar stays only for `(demo,demo)` and gains a visible `Sample data` caption in the same cell.** The caption is one short muted line under a 96px bar (§4.6) — not a per-row `Tag`, no colour, no tone (that is #67's, #71 R8). Mock is an unavailable arm and therefore renders `CPU not collected`, never a bar.
3. **Panel-level tagging is REJECTED here** (and this is the deliberate divergence from #74 Q9). The Change Center timeline *is* the claim, so a panel hint tags exactly the claimed thing. Home's "Needs attention" panel is mostly **observed** data — names, state pills, dependent counts, drawn from the real snapshot — so a panel-level "Sample data" hint would mislabel observed identity data as sample (the inverse DM-06 error, and the exact scoping #74's own wiring test had to make at `history-wiring.test.tsx:58-63`). Its hint is also already occupied by `${attention.length} of ${summary.total}`.
4. **Repetition is bounded and correct, because the kind is a property of the pair, not of the service.** `resourceFor`'s kind depends only on `(mode, provenance)`, so every row in the list carries the same evidence state — this is not the "24 different tags" noise #74 Q9 rejected. The evidence label still exists in exactly one place (`evidence.ts`); Home only adds the metric context `CPU`.
5. **`Bar` gains a required accessible name.** `label: string` becomes a required prop; `aria-label={label}` replaces `${Math.round(value)} percent` (`primitives.tsx:107`). Both call sites pass a qualified name (§4.4-4.5). This is in scope, not creep: §1.5.4 shows both `Bar` call sites are resource sites, so the unqualified announcement is a #73-owned overclaim for AT users (G-22), and a *required* prop is the only shape that forces a future third caller to name its bar.
6. **No `useMemo` anywhere in this slice.** `resourceFor` is clock-free and produces no React keys (§1.5.6), and `Home`'s early returns at `:32-34` make a memo at the row-derivation site a rules-of-hooks trap (#74 R1). The claim is computed at render directly from context values, so no staleness carrier exists at all — DM-09/DM-12 are arrested by construction rather than by a dependency array.

### Q4 / dissent (d) — ServiceDetail Resources tab: **the tab stays; the panel renders the claim; the unavailable arm is `EmptyState`, not a zeroed grid.**

> **L3:** "Exact unavailable detail wording for live mode ('Resource collectors not wired…' analog)?"
> **L4 (Q2):** "does #73 delete `STUB_NOTICE`+`estimated` and replace with a `Claim<ResourceSample>` (unavailable arm w/ reason)…? (Deps: typecheck gate + both consumers must thread `evidenceMode`/`modelProvenance`.)"
> **L2:** "live → `unavailable`, demo/mock → `demo` claim, per `claimAuthority`."

**Ruling.**

1. **The tab is never removed or hidden**, in any mode. `a11y.spec.ts:100` and `:425` iterate all five tab names in both themes and at both widths; removing it breaks them, and hiding the tab hides the claim (the operator learns nothing about why there are no resources). The tab is where the *reason* lives.
2. **`hint={evidenceLabel(claim.kind).label}`** replaces `STUB_NOTICE` — "Sample data" under a matching pair, "Not collected" otherwise. One expression, both arms, always a non-empty string so `primitives.tsx:63`'s falsy suppression can never blank it (G-19).
3. **Unavailable body: `EmptyState`** with `icon="cpu"`, `title={evidenceLabel(claim.kind).label}`, `body={claim.detail}` — the exact shape `Home.tsx:74-77` / `Changes.tsx` use for the history claim. The `.res-grid`, all three `Metric`s, the `Sparkline`, the `Bar`, and the network `Icon` are **not rendered**. The rejected alternative — keeping the grid with three "Not collected" metric values — was considered and refused: it renders the measurement scaffolding (empty sparkline slot, empty bar slot, network glyph) that itself reads as "measured, currently nothing", repeats the label three times, and leaves three `.res-cell`s a future edit can refill with a `0`.
4. **Sample body: today's `.res-grid` verbatim** (`:214-227`), with the memory `Bar` gaining its qualified accessible name (Q3.5).
5. **`className="panel-resources"`** is added to the `Panel` as a test/e2e locator (DM-02c: Playwright strict mode breaks on shared `.panel-hint` selectors — ServiceDetail will carry several). **No CSS rule is added for it**, exactly like `.metric-updates` (#72 Q3) and `.panel-recent-change` (#74 §4.4).
6. **`ServiceDetail.tsx:27` adds `evidenceMode, modelProvenance`** to its `useApp()` destructure and passes both into `Resources` as props (matching how `Overview`/`Dependencies` receive `model`), rather than calling `useApp()` inside `Resources`. Props keep the fixture surface explicit and match the file's existing style.

### Q5 — Deletions: **confirmed, all in the one atomic implementation commit, nothing deferred.**

> **#71 G-23 (`:334`):** "**when #73 lands, the same commit must update `stubs.ts:4-14` and remove `STUB_NOTICE` and `ResourceSample.estimated`**".
> **#74 Q7 (`:219`):** "`STUB_NOTICE` and `ResourceSample.estimated` are NOT touched — they are #73's."
> **L5:** "Keeping `estimated:true` or a per-value boolean: weaker parallel vocabulary #71 D9 forbids."

Deleted in the same commit that tags the surfaces:

| Artifact | Site | Replacement |
|---|---|---|
| `STUB_NOTICE` const + its import + its `Panel.hint` use | `stubs.ts:18`, `ServiceDetail.tsx:7,213` | `hint={evidenceLabel(claim.kind).label}` |
| `ResourceSample.estimated: true` (declaration + assignment) | `stubs.ts:27`, `stubs.ts:45` | the `Claim.kind` carries provenance; locked by a G-37 probe (§9 V4) |
| Header doc-comment claiming universal estimate-labelling | `stubs.ts:6-16` | rewritten to state the demo-only resource gate without changing #74 history wording |
| "Estimated data … always labelled as estimated" | `DESIGN.md:117-118` | §4.7 wording |
| "Estimated Data" section naming the `STUB_NOTICE` string | `DESIGN_LANGUAGE.md:113-119` | §4.7 wording; edge health separated out (§1.5.5) |

The five remaining `ResourceSample` fields stay for the **demo stub only**. `estimated: true` must go because `Claim.kind` is the evidence vocabulary; keeping a parallel boolean would preserve the #71 D9 defect. Section 7 explicitly forbids treating this five-field shape as the future observed collector contract.

### Q6 — Offline `0`: **kept inside the demo-only sample arm, unreachable for mock/live/null/mismatches, and rendered only beside a visible sample label.**

> **Handoff #6:** "offline sample 0 is allowed only when visibly sample-tagged; live 0 forbidden."

The offline branches (`stubs.ts:32,37,41,43`) are **not changed**. Under `(demo,demo)`, `0%` for an offline container is a plausible tagged sample and is rendered next to "Sample data" at both sites (Q3.2, Q4.4). Under every other pair the guard returns before the body, so no `0` is produced. Routing offline to a second unavailable arm inside demo is rejected: it would make the sample arm state-dependent and teach the operator that a stopped demo container's resources are "not collected" when all demo values are synthetic.

**Made observable, not asserted in prose:** V2 renders an offline service under `(demo,demo)` and asserts `0%` **and** the "Sample data" label are both present in the same scoped region (plus the `aria-label="CPU 0% — Sample data"` on the bar); V2 also asserts that no unavailable pair renders a `0`, a `%`, a `.bar`, or a `.spark` in that region; V1 proves the same at the source, since the unavailable arm is the frozen claim singleton and carries no value at all.

### Q7 — Retained model/source transitions: **#74's final three-state provenance, unchanged; mismatch fails closed; no new scheme.**

> **Handoff #7 / G-38:** "use final three-state provenance from #74; mismatch fail-closed; no new provenance scheme."

`ModelProvenance = "demo" | "mock" | "live"` (`evidence.ts:50`) is consumed as-is. The stamp-at-fetch-start TOCTOU L4 raised (`useApiResource.ts:53` stamps from the requested mode before bytes arrive) is a **hook-layer** property already ruled on and shipped by #74 §9; #73 neither re-opens nor re-tests it beyond consuming the published pair. V3 proves live→demo with the live pair held, demo→live with the demo pair held, and the daemon's dynamic docker→mock fallback with the live pair held. Only a later, separately published `(demo,demo)` fixture may resume samples; publishing `(mock,mock)` must remain unavailable.

### Q8 — Docs and screenshots: **prose updated atomically; the two stale resource screenshots are visibly marked in this PR.**

> **Handoff Q8:** "no harness in tree (#74 doc §1.4) — who re-captures `docs/screenshots/service-detail.png` manually in this PR?"

There is still no committed screenshot harness (`DESIGN_LANGUAGE.md:121-130` documents a capture spec that is explicitly *not* in the test suite). The smallest honest action is to keep the image files but visibly disqualify their stale resource pixels:

- `DESIGN.md:117-118` and `DESIGN_LANGUAGE.md:113-119` prose are updated in the **same atomic implementation commit**, plus the Home and Service Detail section blurbs (`:31-34`, `:49-52`).
- Immediately after the `command-center.png` embed, add this visible Markdown text: **"Screenshot status — stale resource cell: captured before #73. Any CPU bar shown here is demo-only after #73; live and mock show `CPU not collected`. Do not use this image as current resource-claim evidence."**
- Immediately after the `service-detail.png` embed, add this visible Markdown text: **"Screenshot status — stale Resources panel: captured before #73. Any CPU, memory, or network values shown here are demo-only after #73; live and mock show `Not collected` with the non-collection reason. Do not use this image as current resource-claim evidence."**
- Do **not** edit either PNG, add a capture spec, add `toHaveScreenshot`, or defer the visible warning to the PR body. Future recapture may remove the warnings only when both images are regenerated from explicit demo mode.

### Q9 — Ownership / no-overlap table (copied verbatim into the PR body)

| Surface | Line | Owner | Why |
|---|---|---|---|
| Home attention-row CPU cell | `Home.tsx:159` | **#73** | Unqualified bar in live — #71 D10 `:276` "the priority site". |
| ServiceDetail Resources panel | `ServiceDetail.tsx:210-230` | **#73** | `resourceFor` + `STUB_NOTICE` hint. D10 `:276`. |
| `resourceFor` / `ResourceSample.estimated` / `STUB_NOTICE` | `stubs.ts:18,27,30-47` | **#73** | D10 `:275`, #71 Q12/G-23. |
| `Bar` accessible name | `primitives.tsx:107` | **#73** | Both call sites are resource sites (§1.5.4). |
| "Recent change" / "What happened" / Change Center | `Home.tsx:114-136,74-89`, `Changes.tsx` | **#74 — shipped, DO NOT TOUCH** | Editing re-opens `history-*.test.*` and the `:540/:567` e2e legs. |
| "Updates" metric / impact cell | `Home.tsx:57`, `ServiceDetail.tsx:100-103` | **#72 — shipped, DO NOT TOUCH** | Claim-backed via `lib/updates.ts`. |
| Edge-health tint on map edges | `model.ts:475-482`, `ServiceMap.tsx` | **#75/#76** | `derived` from observed states, not synthetic (§1.5.5). #73 only fixes the doc sentence that miscategorises it. |
| Copilot resource phrasing | `copilot.ts` | **#75** | `answer()` makes no resource claim today; adding one is #75's mode-aware pass. |
| Runtime node events, demo log timestamps, screenshot binary recapture | `Runtime.tsx:361-374`, `demoData.ts:405`, `docs/screenshots/*` | **#76** | #73 does not edit PNGs; it visibly marks the stale resource pixels in `DESIGN_LANGUAGE.md` now (Q8). |

---

## 3. Risks and mitigations (binding)

| # | Risk | Mitigation |
|---|---|---|
| R1 | **`0` reads as "no load".** Offline ⇒ literal `0` (`stubs.ts:32,37,41,43`); `Bar` renders a 2% sliver for `0` (`primitives.tsx:108`) and announces "0 percent" (`:107`). | Q3.1/Q4.3: the unavailable arm renders **no `Bar` and no number** at either site; Home renders exact `CPU not collected`. Q3.5 replaces the demo-bar announcement with a qualified name. V1/V2 assert no `0`, no `%`, no `.bar`, no `.spark` in scoped unavailable regions. |
| R2 | **Retained model/source flips** (`useSystemModel.ts:38-53` retains the old pair with its original provenance; demo→live keeps demo bytes on screen until a refetch lands). An authority-only gate relabels retained bytes (G-38/DM-06). | Q2.2's one-pair allow-list; V3 holds model+provenance fixed while flipping only mode, then publishes a separately constructed demo fixture. Docker→mock remains unavailable even after `(mock,mock)` publishes. |
| R3 | **Mock-vs-live e2e trap.** The default stack is `mock` (§1.5.3); a "live" assertion written against it is false, while treating mock as demo violates the issue. | V5 has three explicit legs: mandatory SSE-intercepted live unavailable, default mock unavailable, and explicit demo sample. The live leg has **no waiver or fallback**; instability is a bug to fix before merge. |
| R4 | **Vacuous ServiceDetail tests.** Default tab is `overview` (`:25,:28`), so a Resources assertion that never activates the tab passes on an empty panel. Re-deriving the matrix's expected kinds through `claimAuthority` is equally vacuous (G-15). | V2 renders with `defaultTab="resources"` **and** asserts the panel locator is present; V3 activates the tab by a real `role="tab"` **click** inside `act()`. V1's expected kinds are a hard-coded literal table (§8), never derived. |
| R5 | **Unqualified Home bar in the sample arm** could read as observed telemetry. | Q3.2: only explicit `(demo,demo)` gets a bar and it has a visible `Sample data` caption; mock gets `CPU not collected`. V2 asserts both shapes. |
| R6 | **G-37 gate written weakly.** A computed-string probe stays suppressed when the field returns (the exact #72 finding). | V4: template-literal type probes against `keyof ResourceSample`, plus a **manual TS2578 fire-test** recorded in the PR body, plus the claim-bypass probe. |
| R7 | **Wrapper-bypass or pre-guard synthesis** (a future edit hashes/reads fields before returning unavailable). | No ungated synthesizer is exported (Q1). The shared gated core accepts a hasher only through the `resourceForWithHasherForTest` internal test seam; V1 injects a spy and proves fifteen unavailable pairs make zero hash calls, while `(demo,demo)` makes calls. V6 forbids the seam outside `stubs.ts` and its focused test. |
| R8 | **Label drift** — a hand-written "Estimated"/"Sample"/"Not collected" string at a call site. | Every label is `evidenceLabel(claim.kind).label`; every detail is `claim.detail`. V6 greps for the literals outside `evidence.ts` in non-test app source (#71 R1). |
| R9 | **Layout/overflow regression** from the new Home cell at 320/640px. `.svc-row` is a flex row (`styles.css:748-754`) and `.svc-res` is a fixed 90px column (`:781-784`). | §4.6 pins the exact CSS (96px column, stacked, `white-space: nowrap`, 11px caption). The `#35` responsive gate re-runs: `assertUsableAtWidth` already visits `/` and `/services/postgres` for every tab at both widths (`a11y.spec.ts:337,425`). |
| R10 | **Resource policy churn leaks into #74 history.** Sharing or renaming the history predicate would silently narrow `(mock,mock)` history. | Q2.4 adds a resource-private predicate and forbids edits to `maySynthesizeHistory`, both history generators, and their tests. V6 diff-reads them and requires the #74 suites green and unweakened (G-08). |
| R11 | **The one detail string is generic in mismatch windows** ("collectors not wired" is the reason for live; during a demo→live flip the true reason is "the retained bytes don't match the declared mode"). | Accepted, exactly as #74 accepted it: the sentence is true in every window (no collector exists anywhere), and #71 P2-2 requires rendering the `detail`, never the static description. A second window-specific detail would be a provenance-shaped field on the claim — epic #68's, and a #71 R10 finding here. |
| R12 | **The axe scans or browser gate never see the new unavailable DOM under true live authority.** Static tests and the default mock stack cannot substitute for this proof. | V5's mandatory live SSE leg calls `attachAxe` on the unavailable Resources panel (dark theme) and asserts both live surfaces. There is no fallback; a broken intercept blocks merge. |
| R13 | **`Bar`'s required prop breaks a future/parallel caller.** | Only two call sites exist today (§1.5.4), both in this slice's diff; `npm run typecheck` is a required gate, so a missed caller cannot merge. |
| R14 | **A future observed collector leaks retained or stale telemetry across a source flip, or hides partial collection behind an all-or-nothing sample shape.** | §7 forbids adding observed data to `resourceFor`; a separate source-stamped provider requires `(live,live)` alignment, per-metric timestamps/freshness, and independent CPU/memory/network availability. |

---

## 4. Binding render shapes

### 4.1 `apps/web/src/lib/resources.ts` (new — mirrors `updates.ts`/`history.ts`)

```ts
import { unavailable } from "./evidence";

/**
 * DockerMap measures no per-container resource usage in ANY mode: the daemon
 * exposes no CPU/memory/network fields, the mock server invents a topology
 * without them, and demo invents containers, not telemetry. Only explicit
 * demo mode may show visibly tagged samples; mock and live report
 * non-collection.
 */

/**
 * Internal only (U3): consumers read `RESOURCE_STATS_CLAIM.detail`, never a
 * standalone exported detail string — a second source of truth drifts.
 */
const RESOURCE_STATS_DETAIL = "Resource collectors not wired — DockerMap does not measure container CPU, memory or network";

/** The single public claim object for per-service resource usage. */
export const RESOURCE_STATS_CLAIM = Object.freeze(unavailable(RESOURCE_STATS_DETAIL));
```

Binding notes: static literal, never interpolated (#71 Q9, DM-01 redaction); `Object.freeze` per #74's singleton-mutation remediation; **no exported label constant** — call sites use `evidenceLabel(claim.kind).label` inline, as `Home.tsx:75-76` already does for the history claims.

### 4.2 `apps/web/src/lib/stubs.ts`

Header comment `:6-16` is replaced by (wording binding in substance, not character-for-character):

```ts
/**
 * ──────────────────────────────────────────────────────────────────────────
 * RESOURCE SAMPLE DATA — available only under the exact `(demo,demo)`
 * mode/provenance pair, and always returned as a tagged `Claim`.
 *
 * The DockerMap daemon exposes no per-service resource usage and no change
 * history in any mode. Explicit demo mode may derive stable, plausible
 * resource samples from the fabricated topology. Mock, live, and every
 * mismatched or unresolved pair take the `unavailable` resource arm with an
 * explicit reason. History retains its separate #74 policy unchanged. See
 * `maySynthesizeResourceSample`.
 * ──────────────────────────────────────────────────────────────────────────
 */
```

```ts
export interface ResourceSample {
  cpuPercent: number;
  memoryPercent: number;
  memoryMb: number;
  networkKbps: number;
  /** Short pseudo-history for sparklines (0..1 normalised). */
  cpuSeries: number[];
}

type ResourceHasher = (input: string) => number;

function maySynthesizeResourceSample(
  mode: EvidenceMode | null,
  modelProvenance: ModelProvenance | null
): boolean {
  return mode === "demo" && modelProvenance === "demo";
}

function resourceForWithHasher(
  service: Service,
  mode: EvidenceMode | null,
  modelProvenance: ModelProvenance | null,
  hash: ResourceHasher
): Claim<ResourceSample> {
  if (!maySynthesizeResourceSample(mode, modelProvenance)) return RESOURCE_STATS_CLAIM;
  // …existing hash-derived body and seeds, using `hash` in place of
  // `hashString`, unchanged otherwise, including the offline branches…
  return demoSample({ cpuPercent, memoryPercent, memoryMb, networkKbps, cpuSeries: series });
}

export function resourceFor(
  service: Service,
  mode: EvidenceMode | null,
  modelProvenance: ModelProvenance | null
): Claim<ResourceSample> {
  return resourceForWithHasher(service, mode, modelProvenance, hashString);
}

/** @internal Test-only guard-dominance seam; never import from app code. */
export function resourceForWithHasherForTest(
  service: Service,
  mode: EvidenceMode | null,
  modelProvenance: ModelProvenance | null,
  hash: ResourceHasher
): Claim<ResourceSample> {
  return resourceForWithHasher(service, mode, modelProvenance, hash);
}
```

`maySynthesizeResourceSample` is file-local and resource-private. `resourceForWithHasher` is also private and contains the guard before its first service-field read or `hash(...)` call. The exported test seam executes that same gated core; it does not expose raw synthesis. `maySynthesizeHistory`, `changeFeed`, `causalChain`, their call sites, and their comments remain byte-for-byte unchanged. V1/V6 police both boundaries.

### 4.3 `screens/Home.tsx`

```tsx
// :143 — ServiceRow gains the two gate inputs; it never derives them.
function ServiceRow({ model, service, evidenceMode, modelProvenance }: {
  model: ReturnType<typeof useApp>["model"];
  service: Service;
  evidenceMode: EvidenceMode | null;
  modelProvenance: ModelProvenance | null;
}) {
  if (!model) return null;
  const resources = resourceFor(service, evidenceMode, modelProvenance);
  const resourceLabel = evidenceLabel(resources.kind).label;
  // …icon, name, StatePill, meta unchanged…
  <span className="svc-res">
    {resources.kind === "unavailable" ? (
      <span className="svc-res-claim">{`CPU ${resourceLabel.toLowerCase()}`}</span>
    ) : (
      <>
        <Bar
          value={resources.value.cpuPercent}
          state={service.state}
          label={`CPU ${formatPercent(resources.value.cpuPercent)} — ${resourceLabel}`}
        />
        <span className="svc-res-claim">{resourceLabel}</span>
      </>
    )}
  </span>
}
```

The call site at `:68` passes `evidenceMode={evidenceMode} modelProvenance={modelProvenance}` from the existing `useApp()` destructure at `:22`. `formatPercent` is imported from `../lib/format` (already imported for `formatRelative`; extend the import). No `useMemo` (Q3.6). Nothing else on Home changes — the metric strip, attention list ordering, causal/recent-change panels and Runtime Signals are untouched.

### 4.4 `screens/ServiceDetail.tsx`

```tsx
const { model, modelProvenance, loading, error, tick, evidenceMode } = useApp();   // :27
…
{tab === "resources" && <Resources service={service} evidenceMode={evidenceMode} modelProvenance={modelProvenance} />}   // :130

function Resources({ service, evidenceMode, modelProvenance }: {
  service: Service;
  evidenceMode: EvidenceMode | null;
  modelProvenance: ModelProvenance | null;
}) {
  const resources = resourceFor(service, evidenceMode, modelProvenance);
  return (
    <Panel className="panel-resources" title="Resources" icon="cpu" hint={evidenceLabel(resources.kind).label}>
      {resources.kind === "unavailable" ? (
        <EmptyState icon="cpu" title={evidenceLabel(resources.kind).label} body={resources.detail} />
      ) : (
        <div className="res-grid">
          <div className="res-cell">
            <Metric label="CPU" value={formatPercent(resources.value.cpuPercent)} />
            <Sparkline data={resources.value.cpuSeries} state={service.state} />
          </div>
          <div className="res-cell">
            <Metric label="Memory" value={formatMb(resources.value.memoryMb)} sub={formatPercent(resources.value.memoryPercent)} />
            <Bar
              value={resources.value.memoryPercent}
              state={service.state}
              label={`Memory ${formatPercent(resources.value.memoryPercent)} — ${evidenceLabel(resources.kind).label}`}
            />
          </div>
          <div className="res-cell">
            <Metric label="Network" value={formatKbps(resources.value.networkKbps)} />
            <Icon name="network" size={18} />
          </div>
        </div>
      )}
    </Panel>
  );
}
```

`STUB_NOTICE` is dropped from the import at `:7`. The `TABS` array (`:17-23`), the tablist (`:106-125`), and the tabpanel wiring (`:127-135`) are unchanged — the Resources tab exists in every mode (Q4.1).

### 4.5 `components/primitives.tsx`

```tsx
export function Bar({ value, state = "healthy", label }: { value: number; state?: ServiceState; label: string }) {
  return (
    <span className="bar" role="img" aria-label={label}>
      <span className={`bar-fill s-${state}`} style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
    </span>
  );
}
```

`label` is **required**. No other primitive changes; `Sparkline` stays `aria-hidden` (decorative beside a labelled `Metric`).

### 4.6 `apps/web/src/styles.css` — exactly two rules

Replace `.svc-res` (`:781-784`) and add one sibling. No other CSS changes, no new tokens, no responsive override (the `@media (max-width: 760px)` block at `:2198-2241`, which already collapses `.grid-2`/`.res-grid`/`.impact-band.wide` to one column at `:2222-2225`, needs no entry — the cell is fixed-width and its caption is nowrap-bounded at 11px):

```css
.svc-res {
  width: 96px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.svc-res-claim {
  font-size: 11px;
  line-height: 1.2;
  color: var(--muted-deep);
  text-align: right;
  white-space: nowrap;
}
```

`align-items` is left at the flex default `stretch` so `.bar`'s `width: 100%` (`:648-650`) still spans the column. `--muted-deep` is the existing token used by `.svc-meta` (`:775-779`), defined for both themes (`:18`, `:2103`).

### 4.7 Docs wording (binding in substance)

`DESIGN.md:117-118` becomes:

> - Resource usage samples are shown **only in explicit demo mode** and labelled "Sample data"; in mock and live mode DockerMap reports that resources are not collected rather than showing a number. Change history retains its separately documented demo/mock policy.

`DESIGN_LANGUAGE.md:113-119` ("Estimated Data") becomes "Sample Data" and must: (a) contain **no** occurrence of the deleted `STUB_NOTICE` string; (b) state that resource samples render only under exact `(demo,demo)` with the "Sample data" label and that mock/live/unresolved/mismatched states show non-collection; (c) state that Home uses exact `CPU not collected`, while ServiceDetail uses "Not collected" plus the exact reason; (d) restate the change-history rule as shipped by #74 without implying its mock policy applies to resources; (e) **move edge health out** — it is derived from observed container states (`model.ts:475-482`), not estimated, and its evidence tagging belongs to #75/#76. The Home (`:31-34`) and Service Detail (`:49-52`) blurbs gain the same surface-specific clauses. Add both exact visible screenshot-status warnings from Q8 immediately after their image embeds in this same edit.

**Deleted copy that must not survive anywhere in `apps/` or `docs/`:** `"Estimated — live resource collectors not yet wired"`, and "estimated" as a user-facing qualifier for resource data.

---

## 5. Resolved product questions (nothing left to implementer judgment — G-14)

1. **Does any non-demo pair ever show a resource number?** No — not a percentage, bar, sparkline, metric, or `0` on Home or ServiceDetail under mock, live, either `null`, or any mismatch.
2. **Does demo mode keep the samples?** Yes, at both sites, visibly labelled **"Sample data"**.
3. **Does mock behave like demo?** No. `(mock,mock)` is unavailable because mock is not explicit demo and emits no resource observations. The default e2e/mock stack shows no resource bars. (Q2.)
4. **What does Home show when unavailable?** The attention row's resource cell renders exact visible/accessible text **"CPU not collected"** — no detail sentence, bar, number, or `%` is required or permitted there.
5. **What does ServiceDetail show when unavailable?** The Resources tab still exists; its panel hint is **"Not collected"**, and the body is an empty state titled **"Not collected"** with the exact reason *"Resource collectors not wired — DockerMap does not measure container CPU, memory or network"*.
6. **Is the Resources tab removed or hidden in live?** No — never, in any mode.
7. **Do demo bars get a visible label on Home?** Yes — only `(demo,demo)` renders the bar, with "Sample data" as a caption in the same cell. The panel header is not used for it (Q3.3).
8. **What do screen readers hear on a bar?** A qualified name: *"CPU 42% — Sample data"* / *"Memory 61% — Sample data"*. Never a bare "42 percent". In the unavailable arm there is no bar at all.
9. **Is an offline service's `0%` still shown?** Only under `(demo,demo)`, only beside the "Sample data" label. Never under mock/live/null/mismatch (the guard returns first).
10. **Is `STUB_NOTICE` gone?** Yes, deleted, along with its import and its only use.
11. **Is `ResourceSample.estimated` gone?** Yes, and locked by a type probe (V4). The other five fields stay.
12. **Is `maySynthesizeHistory` renamed or reused?** No. #73 adds private `maySynthesizeResourceSample`; #74's predicate, history generators, and tests are untouched.
13. **Do the change/causal/updates surfaces change?** No. Touching them is a P1 (Q9 table).
14. **Does Copilot change?** No — it makes no resource claim today; adding one is #75's.
15. **What happens to stale screenshots?** PNGs are not regenerated, but both resource-bearing embeds receive the exact visible stale-status warning in Q8 in this PR; a PR-body note alone is insufficient.
16. **Any contract/daemon/API change?** None. Web-only. `npm run test:live-docker` therefore does not apply (DM-03) — state that in the PR body rather than leaving it unexplained.
17. **Exact user-visible strings (binding, no paraphrasing):** Home unavailable `CPU not collected` (constructed from `CPU` + the lower-cased evidence label); labels `Sample data` / `Not collected`, both from `evidenceLabel`, never hard-coded at a call site; ServiceDetail detail `Resource collectors not wired — DockerMap does not measure container CPU, memory or network`; panel title `Resources`; tab label `Resources`; metric labels `CPU` / `Memory` / `Network` (unchanged, demo sample arm only); bar accessible names `CPU <n>% — Sample data` / `Memory <n>% — Sample data`.

---

## 6. Arrested lessons

Per-lesson prose is deliberately **not** re-documented here — `register-generic.md` and `register-dockermap.md` are the single source of truth (#72 U9). Each id names where this slice discharges it.

**Arrested by this slice:**
**G-01** (all 16 mode/provenance pairs, including both `null`s, have an allow-listed or unavailable outcome — V1) · **G-03** (e2e asserts what each stack actually renders: live/mock unavailable and explicit demo sampled — Q2, V5) · **G-08** (#74's predicate, generators, matrix and wiring tests are untouched, diff-read, and re-run unweakened — R10, V6) · **G-12** (no unenforced baseline is added; both stale resource screenshots receive visible in-doc warnings — Q8) · **G-14** (§2 and §5 leave zero product calls) · **G-15** (every negative assertion is paired with a resumption assertion: samples come back after a matching pair publishes — V3) · **G-19** (Home renders exact visible/accessible `CPU not collected`; ServiceDetail always renders the non-empty evidence label and exact detail) · **G-22** (`Bar` gains a required, entity- and provenance-qualified accessible name — Q3.5) · **G-23** (`stubs.ts` header and all superseded design prose, including screenshot warnings, land in the same atomic gating commit; V6 greps for residue) · **G-24** (no ungated synthesizer survives; V1's injected hasher proves all fifteen unavailable pairs return before synthesis — Q1, Q2) · **G-36** (source gate, both consumers, focused tests, e2e, and docs ship atomically — checklist row 2; V3 holds the carrier fixed while only the mode flips) · **G-37** (literal-preserving template probes + a recorded manual TS2578 fire test — V4) · **G-38** (three-state provenance consumed as-is; the docker→mock dynamic fallback is a named V3 leg) · **DM-01** (no provider, endpoint, fetch or shell; the detail string is a static literal, never interpolated snapshot data; never auto-close the issue) · **DM-02** (unique `.panel-resources` / `.svc-res-claim` locators for Playwright strict mode; `domcontentloaded` + explicit waits, never `networkidle`) · **DM-05** (V3 pins separate live and demo fixtures with the same `prod-secret-host` routable identity; no model is relabelled for resumption) · **DM-06** (no bar, number or aria-label claims more than the pair proves; mock is unavailable despite #74 history's separate policy) · **DM-07** (the hook layer this diff consumes — `useApiResource`/`useSystemModel` provenance publication — is traced in §1.3 and exercised through the real `AppShell` in V3) · **DM-08** (source gate, both consumers, focused tests, e2e, CSS, and all superseded docs close in the same atomic implementation commit) · **DM-09/DM-12** (no memo, no component-state carrier: the claim is recomputed from context every render, so no mode-dependent data can survive a flip) · **DM-11** (any e2e settings payload stays single-key `{"demoMode": true}`; note that #73 adds no settings-parse change).

**N/A for this slice (no surface exists):** G-02 (no new library; React/Playwright behaviour unchanged) · G-04, G-05, G-06, G-07, G-09*, G-10, G-11, G-13, G-16, G-17, G-18 (no balance/telemetry/render-size/cache/visual-matrix surface) · G-20, G-21 (joins and occurrence-qualified keys untouched — the attention row's `key={`${service.id}-${index}`}` at `Home.tsx:68` is preserved verbatim) · G-25 … G-35 (no async/transaction/secret/env/queue/cleanup surface) · DM-03 (no daemon/API/contract change → no live-Docker release gate; say so in the PR body) · DM-04 (no Rust) · DM-10 (no release-artifact change).
*G-09 is procedurally live: review must re-run `npm run check` itself rather than citing the PR body.

---

## 7. Future real-collector fit — separate, source-aligned, freshness-aware, and partial

When read-only resource collectors land in the daemon (a separate epic; explicitly **not** started here), they **must not** add an observed arm ahead of the current stub gate or reuse `ResourceSample` as an observed transport shape. `resourceFor` remains the demo-only sample provider. Observed telemetry enters through a separate provider because its authority, lifecycle, and partial-availability contract are different.

The future contract is pinned at this level:

1. `packages/contracts` supplies a source-stamped observed payload separate from `Service`, with `sourceProvenance: "live"` and the same snapshot/runtime generation identity used to align the model. A retained resource payload may not be attached to a newly published model generation.
2. Every metric carries its own freshness envelope — `{ value, observedAtMs, expiresAtMs }` — rather than one timestamp for an all-or-nothing aggregate. The web provider accepts an injected `nowMs`; a metric is eligible only when both timestamps are finite, `observedAtMs <= nowMs <= expiresAtMs`, and its source generation matches the displayed model. Missing, future-dated, expired, or generation-mismatched metrics are unavailable. No default infinite freshness and no silent last-value retention.
3. The observed provider returns **independent claims for CPU, memory, network, and CPU history** (or an equivalent discriminated per-metric map). CPU can be observed while network is unavailable; a missing metric is never filled from `resourceFor`, zeroed, or hidden behind an all-or-nothing `ResourceSample`.
4. Observed claims are authorized only when the displayed pair is exactly `(evidenceMode, modelProvenance) === ("live", "live")`, the observed payload is stamped `sourceProvenance: "live"`, and its generation matches. Any flip to demo/mock/null or any retained-source mismatch immediately suppresses observed values before freshness/value reads.
5. Consumer composition changes in that future slice: under exact live alignment, each fresh observed metric renders independently; stale/missing metrics render their own non-collection/stale state. Under exact `(demo,demo)`, today's visibly labelled sample provider may render. Mock and every mismatch remain unavailable. Tests must hold observed payload+timestamp fixed while mode/provenance/generation/`nowMs` crosses each boundary.

Therefore today's five-field `ResourceSample` is **only the current demo stub value shape**, not a promised collector schema or stable seam. Deleting `estimated: true` still removes the forbidden parallel evidence vocabulary, but it does not pre-decide the real collector's timestamp, freshness, source, or partial-metric model.

---

## 8. Ordered implementation checklist — exact commit titles

The reconciled architecture lands as one docs-only commit before implementation. The behaviour change is one atomic commit: **no source-only, consumer-only, test-later, e2e-later, or docs-later intermediate is permitted.** Every commit leaves `npm run check` green (`check:js` = audit + typecheck + build + test:js; there is no lint step; `check:rust` is untouched). Any split of checklist row 2 is a P1 (#72 U1, G-23, G-36).

| # | Commit message (exact) | Contents | Green because |
|---|---|---|---|
| 1 | `Architect passes 1-2: gate resource samples design (#73)` | this file, including the independent Sol review reconciliation (§10) | docs only; binding plan is internally consistent before implementation |
| 2 | **`web: gate resource samples to explicit demo mode (#73)` — ATOMIC, DO NOT SPLIT** | New `lib/resources.ts`; `lib/stubs.ts` (demo-only private predicate, gated hasher core + test seam, claim return, `STUB_NOTICE`/`estimated` deletions, header correction; **zero #74 history edits**); Home + ServiceDetail; required `Bar.label`; two CSS rules; literal V1/V2 matrix; V1/V4 source tests; V2 surface tests; V3 wiring tests with pinned live/demo fixtures; mandatory V5 live/mock/demo browser legs; `DESIGN.md`; all superseded `DESIGN_LANGUAGE.md` prose plus both exact Q8 screenshot warnings. | Gate, both consumers, focused tests, mandatory live e2e, and all stale design claims appear together. The signature/`Bar` changes cannot leave an intermediate compiling-but-misleading tree; G-23/G-36 are satisfied at commit granularity. |

PR body must carry: the §2 Q9 ownership table verbatim; the accepted scope statement that **only `(demo,demo)` samples and all other pairs are unavailable**; confirmation that `maySynthesizeHistory` and both #74 generators were untouched; the recorded guard-dominance spy result (V1); the manual TS2578 fire-test result (V4); confirmation that both visible screenshot warnings landed; the mandatory live-browser V5 result with no fallback; and the DM-03 statement that the separate `npm run test:live-docker` release-host gate is not required because daemon/API/contracts are unchanged. Closure: a `## Resolution Evidence` comment (What changed / Why this resolves / How I checked / Remaining risk) — **never self-close** (DM-01).

---

## 9. Test / e2e plan

**Shared matrix constant** — added to `apps/web/src/lib/test-utils.ts` (test-only module, already in `lib/`), hard-coded and **never derived** from `claimAuthority` or from the gate (a matrix that re-derives its expectation from the predicate it tests proves nothing, G-15). One copy, two consumers (V1 and V2), so the two cannot drift:

```ts
// Mutable tuple-array type, matching no-synthetic-history.test.ts:22 — a
// `readonly` array here fights vitest's `it.each` overloads for no benefit.
export const RESOURCE_CLAIM_MATRIX: [EvidenceMode | null, ModelProvenance | null, "demo" | "unavailable"][] = [
  ["live", "live", "unavailable"],  ["live", "mock", "unavailable"],  ["live", "demo", "unavailable"],  ["live", null, "unavailable"],
  ["mock", "live", "unavailable"],  ["mock", "mock", "unavailable"],  ["mock", "demo", "unavailable"],  ["mock", null, "unavailable"],
  ["demo", "live", "unavailable"],  ["demo", "mock", "unavailable"],  ["demo", "demo", "demo"],         ["demo", null, "unavailable"],
  [null,   "live", "unavailable"],  [null,   "mock", "unavailable"],  [null,   "demo", "unavailable"],  [null,   null, "unavailable"]
];
```

Sixteen pairs — the **full** three-source cross product, deliberately stronger than #74's 13 (which omitted the three `(mode, null)` rows; `ModelProvenance | null` admits them, so G-01 requires an outcome for each).

| ID | Criterion | Discharged by |
|---|---|---|
| **V1** | **Exhaustive matrix + guard-dominance proof** | `lib/no-synthetic-resources.test.ts`: `it.each(RESOURCE_CLAIM_MATRIX)` over both running and offline fixtures. Ordinary calls assert all fifteen unavailable rows return `RESOURCE_STATS_CLAIM` by identity, with `kind === "unavailable"`, `value === null`, the exact detail, and no resource-shaped key; only `(demo,demo)` returns all five finite sample fields with `cpuSeries.length === 24`. **Ordering proof (mandatory):** for each unavailable row, wrap the service in a `Proxy` whose `get` trap throws and call `resourceForWithHasherForTest(proxy, mode, provenance, hashSpy)`, where `hashSpy` is `vi.fn(() => { throw new Error("resource synthesis reached"); })`; assert the frozen singleton returns without throwing and `hashSpy` has zero calls. Then call `(demo,demo)` with an ordinary service and a deterministic `vi.fn(() => 17)` hasher and assert it was called. This exact private-core injection proves the positive gate dominates both service-field reads and hash synthesis; singleton identity alone is not presented as ordering proof. |
| **V2** | **Split surface contracts across all 16 pairs** | `screens/resources-surface.test.tsx` (`renderToStaticMarkup` + `visibleText`, `AppContext.Provider` fixture in the `updates-surface.test.tsx:16-19` shape) runs the full matrix for `/` with `<Home />` and `/services/api` with `<ServiceDetail defaultTab="resources" />` (R4). **Home unavailable assertions (fifteen rows):** scope to the `.svc-res` region using the closing-`</li>` recipe below; `visibleText(region)` is exactly `CPU not collected`, the text is not `aria-hidden`, and the region contains no detail sentence, `.bar`, `0`, digit, or `%`. The Home test does **not** require `claim.detail`. **ServiceDetail unavailable assertions (fifteen rows):** scope to the `section.panel-resources`; visible text contains `Not collected` and the exact detail `Resource collectors not wired — DockerMap does not measure container CPU, memory or network`; the panel contains no `.metric`, `.res-grid`, `.res-cell`, `.bar`, `.spark`, percentage, memory unit, or network unit. **Only `(demo,demo)`:** Home has a bar, visible `Sample data`, and an aria-label matching `/^CPU \d+% — Sample data$/`; ServiceDetail has `Sample data` in `.panel-hint`, three `.res-cell`s, metrics, the sparkline, and the qualified memory bar. Scoping is mandatory: on Home match `` /<span class="svc-res">[\s\S]*?<\/span><\/li>/g `` (anchor on the row-closing `</li>` because nested spans make a non-greedy `</span>` vacuous); on detail match the `panel-resources` section. An offline `(demo,demo)` fixture asserts `0%`, `Sample data`, and `aria-label="CPU 0% — Sample data"` in the same Home region. Anti-vacuity: `<ServiceDetail />` at its default overview tab contains no `panel-resources`. |
| **V3** | **Model-held mode flips + dynamic fallback + tab interaction (G-36/G-38/DM-12)** | `screens/resources-wiring.test.tsx`, jsdom, real `AppShell`, hoisted mutable `state` and the four `vi.mock`s copied from `history-wiring.test.tsx:24-36`. DM-05 sentinel: use separate live and demo fixtures with the same routable identity `prod-secret-host`. The live fixture is retained during mismatch windows; the demo fixture is published only in the separate resumption act. Leakage is detected by forbidden `.bar`/`Sample data` DOM and the real-name sentinel, not by a false non-zero assumption (offline demo values may legitimately be zero). **(a) live→demo, pair held:** start `demoMode=false`, docker health, `model=liveModel`, `modelProvenance="live"`; assert `.svc-res` text is `Not collected` and `.svc-res .bar` count is 0. Inside one `act()` flip **only** `demoMode=true`; assert `.conn-mode` is "Demo Engine", `.svc-res .bar` count still 0, no `Sample data`, `Not collected` still present. In a **separate** `act()` publish `demoModel` + `"demo"`; assert bars appear and `Sample data` renders (G-15 resumption). **(b) demo→live, pair held:** the inverse; bars and the caption must disappear and `Not collected` appear. **(c) docker→mock dynamic fallback:** live pair held, health alone flips to `mock`; assert no bars and no `Sample data`; publish a matching `(mock,mock)` pair and assert resources remain unavailable (`CPU not collected` / exact panel detail), because #73 samples are explicit-demo-only; **(d) null authority:** `health=null` ⇒ unavailable. **(e) Resources-tab interaction:** the local `shell()` helper gains a third route — `<Route path="/services/:name" element={<ServiceDetail />} />` with **no `defaultTab`**, so the panel is reached only by interaction; render `/services/prod-secret-host` (the sentinel resolves through `model.byName`), **click** the `role="tab"` "Resources" button inside `act()` under a live pair, assert `.panel-resources` shows `Not collected` and contains no `.bar`/`.spark`/`%`; publish a matching sample pair, re-click/re-render, assert the `res-grid` and the `Sample data` hint appear. The test is invalid if model or provenance changes in the same `act()` as a mode flip. |
| **V4** | **G-37 type gates + fire test + tripwire** | In `lib/no-synthetic-resources.test.ts`: <br>`type EstProbe<K extends string> = \`estimate${K}\`;` with `// @ts-expect-error` on `const estimatedProbe: EstProbe<"d"> extends keyof ResourceSample ? "ok" : never = "ok";` — the directive is live only while the key is absent, so re-adding `estimated` makes it unused and `tsc` fails (TS2578). <br>`// @ts-expect-error` on `const bypass: ResourceSample = resourceFor(service, "demo", "demo");` — the claim must not be assignable to the raw sample. <br>**Manual fire test (mandatory, recorded in the PR body):** temporarily retarget one probe at an existing key (`` `cpu${"Percent"}` `` extends `keyof ResourceSample`), run `npm run typecheck`, confirm **TS2578 "Unused '@ts-expect-error' directive"** fires, then revert. A gate that has never been observed to fail is not a gate. <br>**Deep-key tripwire:** `deepKeys([model.services, summarize(model)])` must contain no key matching `/cpu|memory|kbps|bytes|percent/i` — proving no resource-shaped field has appeared in the model layer (verified zero at this HEAD; `Service.networks` deliberately does not match this vocabulary). `deepKeys` is a file-local helper at `no-synthetic-updates.test.ts:78-86` and is **not** exported: **copy it into the new test file** with a comment naming the original — do not edit or import from #72's suite, which V6 requires green and unweakened. Document the tripwire's blind spot in a comment, exactly as `no-synthetic-updates.test.ts:161-168` does: the tripwire is not the backstop, the type probes are. |
| **V5** | **E2E — mandatory live, mock, and explicit-demo legs** | `tests/e2e/a11y.spec.ts`. **(a) Live — mandatory, no fallback:** intercept `**/api/events/stream*` with a representative docker-mode frame; wait for `Docker Engine`; on `/services/postgres` open Resources and assert `Not collected` plus the exact detail with zero resource metrics/bars/sparkline; run axe; on Home assert `.svc-res-claim` is exactly `CPU not collected` with no bar. A broken intercept blocks merge. **(b) Default mock — mandatory unavailable:** assert `Mock Engine`; ServiceDetail Resources shows the same unavailable label/detail and no metrics/bars/sparkline; Home shows `CPU not collected`, never `Sample data`. This proves mock does not inherit #74 history policy. **(c) Explicit demo — mandatory sample:** fresh context with single-key `{ "demoMode": true }`; assert `Demo Engine`; ServiceDetail Resources has `Sample data`, three resource cells/sparkline/qualified bars; Home has a bar plus visible `Sample data`. Contexts are isolated and closed in `finally`; use `domcontentloaded` + explicit waits, never `networkidle`; existing tab axe/responsive tests remain unweakened. |
| **V6** | **Regression hygiene and greps at final HEAD** | `npm run check` green (re-run by the reviewer, not cited from the PR body — G-09); `npm run test:e2e` for the modified spec; `no-synthetic-history`, `history-surface`, `history-wiring`, `updates-surface`, `updates-wiring`, `change-feed-identity`, `duplicate-list-keys`, `collision-*`, `detail-identity`, `mount-keys` suites green **and unweakened** (diff-read them — G-08; the new resource-private predicate must not touch any #74 history assertion). Reviewer greps: `STUB_NOTICE` → 0 hits repo-wide; `"Estimated — live resource collectors not yet wired"` → 0 hits incl. `docs/`; `estimated` → 0 hits in `stubs.ts`, remaining hits only the deliberate G-37 probe text in the three `no-synthetic-*` tests; `resourceFor` → exactly the definition in `stubs.ts` plus `Home.tsx` and `ServiceDetail.tsx` plus tests; `resourceFor(` with a literal mode argument outside `*.test.*` → 0 hits (R7/R10 analog, P2 finding); `"Sample data"` / `"Not collected"` string literals in non-test `apps/web/src` outside `evidence.ts` → 0 hits (R8); `class="bar"`/`Bar` call sites → exactly two, both passing `label`; no resource literal (`cpuPercent`, `memoryMb`, …) anywhere outside `stubs.ts` and the tests. |

**Not run by this slice:** `npm run test:live-docker` — no daemon/API/contract change, so the DM-03 release gate does not apply (state it in the PR body rather than leaving it unexplained).

---

## 10. Independent Sol review reconciliation

Sol's independent architecture review verdict was **UNSOUND** before these amendments. Every finding is resolved here:

- **P1 mock policy:** exact `(demo,demo)` only (Q2); mock is unavailable and gets its own mandatory V5 browser leg.
- **P1 atomicity/docs:** checklist row 3 lands source gate, both consumers, focused tests, CSS, and all superseded design prose/warnings atomically.
- **P1 impossible V2 contract:** Home and ServiceDetail assertions are split by surface; Home does not require the detail sentence.
- **P2 Home context:** exact visible/accessibility contract `CPU not collected`, never an unqualified label.
- **P2 future collector leakage:** §7 requires live+live alignment, generation identity, per-metric freshness, and partial availability; current `ResourceSample` is not the observed schema.
- **P2 guard dominance:** V1 injects a throwing hasher and service proxy, proving unavailable pairs return before service/hash access.
- **P2 forbidden V5 fallback:** removed; live/mock/demo legs are mandatory and failures block merge.
- **P2 screenshots:** Q8 requires visible stale-image warnings in this PR; no PR-body-only debt.
- **P3 fixtures/helper:** offline zero is a visibly tagged sample; resumption uses separate same-identity models; resource predicate is private and #74 history code/tests are untouched.

No unresolved dissent remains. Any deviation requires a same-PR written amendment and re-review.

---

*Status: RECONCILED AFTER INDEPENDENT SOL REVIEW — Q1-Q9, all handoff dissents, and every Sol P1/P2/P3 finding are resolved. Resource samples are exact `(demo,demo)` only; live, mock, null, and all mismatches are unavailable. No open questions and no exception to the #74 no-overlap rule; the implementer makes zero product calls.*
