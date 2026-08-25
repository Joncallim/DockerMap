# Architecture — #74 Gate synthetic change history to demo mode

**Slice:** #74 (child of epic #61 *Make live-state claims evidence-backed*).
**Branch:** `codex/gate-change-history-issue-74`, cut from `main` @ `450ae6c` ("Remove synthetic update-available claims from live mode (#72) (#79)"). Tree clean at authoring time.
**Binding precedents:** `architect-evidence-vocab-71.md` §D10 (per-surface consumption map, `:265-300`) and §"Resolved product questions" (`:301-319`); `architect-update-claims-72.md` §2 (decision format), §4 (product questions), §6 (commit granularity), §8 (verdict-chain format).
**Registers:** `register-generic.md` (G-01…G-37), `register-dockermap.md` (DM-01…DM-12).

**This document is BINDING on the implementer.** Any deviation is a P1 finding unless the deviation is first amended *into this file* in the same PR (G-14, G-23).

**Scope guard (post-review amended):** web-only. ZERO changes to `packages/contracts`, `crates/`, `apps/api`. No new endpoints, no network calls — the runtime stays network-quiet (DM-01). The provenance-race remediation may change only the web evidence/hook/context path named in §9: `lib/evidence.ts`, `hooks/useApiResource.ts`, `hooks/useSystemModel.ts`, `context.tsx`, `components/AppShell.tsx`, the two history generators/screens, and their tests/fixtures. `lib/model.ts`, `SystemModel`, and `buildModel` remain unchanged; provenance is a fetch/model-state sidecar, not daemon/domain data.

---

## 1. Verified current state (post-#72, every line re-read on THIS tree)

### 1.1 The synthetic source — `apps/web/src/lib/stubs.ts`

| Line | Artifact | Note |
|---|---|---|
| `:16` | `STUB_NOTICE = "Estimated — live resource collectors not yet wired"` | **#73's**, not #74's. Untouched here. |
| `:17` | `STUB_CHANGES_NOTICE = "Sample timeline — change collectors not yet wired"` | #74 deletes it (#71 Q12/R1: "#74 removes the change pair"). |
| `:19-27` | `ResourceSample` incl. `estimated: true` `:27` | #73's. Untouched. |
| `:29-46` | `resourceFor` (`estimated: true` `:44`) | #73's. Untouched. |
| `:48-69` | `ChangeEvent` — `kind` union `:64` = `deploy\|restart\|config\|failure\|recovery`; **no `image_update`** (died in #72); `at: number` `:67`; `estimated: true` `:68` | `estimated` is the weaker parallel vocabulary (#71 D9 `:263`); #74 removes it. |
| `:71-78` | Totality comment; explicitly states "**#74 owns the feed's emission surface**" | Direct hand-off to this slice. |
| `:79-88` | `CHANGE_TEMPLATES` — `Record` over the full kind union, 5 arms | Kept as-is; totality is a compile guarantee (#72 U7/G7). |
| `:90-105` | `changeFeed(model)` — `Date.now()` `:91`, collision-safe `routeName` `:97`, emits `failure` (needsAttention) / `restart` (`seed > 0.6`) `:98-102`, `sort desc .slice(0,24)` `:104` | **The defect: runs identically in live.** No mode parameter exists. |
| `:107-120` | `makeEvent` — `id = service:kind:at` `:109`, `estimated: true` `:118` | `id` embeds the wall-clock instant → new React keys every call. |
| `:122-130` | `CausalStep` | No timestamps. |
| `:132-149` | `causalChain(model)` — root = first `state === "offline"` `:133`, dependents `.slice(0,3)` `:140`, returns `null` when no root | Invents no timestamps but **does invent events**: "*X went offline*" (a transition never observed) and "*Y lost its upstream connection*" (no connection telemetry exists in any mode). |

### 1.2 Consumers (complete — repo-wide grep for `changeFeed|causalChain|STUB_CHANGES_NOTICE|ChangeEvent|CausalStep` over `apps/`, `packages/`, `tests/`, `crates/`)

Exactly five files: `lib/stubs.ts`, `screens/Changes.tsx`, `screens/Home.tsx`, `screens/change-feed-identity.test.tsx`, `lib/no-synthetic-updates.test.ts`. **Nothing in `packages/contracts`, `crates/`, `apps/api`, or `tests/e2e` imports them** — confirming the web-only scope claim.

- **`screens/Changes.tsx`** — `useMemo` import `:1`; `KINDS` `:9-14` = All/Restarts/Failures/Recoveries (**no Updates chip** — removed in #72; `a11y.spec.ts:536` asserts its absence); `useApp()` `:17` (destructures `model, loading, error` — **`evidenceMode` is available but not read**); `kind` state `:18`; `useMemo(() => (model ? changeFeed(model) : []), [model])` `:20` — **`evidenceMode` absent from deps (DM-12/R7 trap)**; `filtered` `:21`; early returns `:23-24`; `.filter-row` `:33-39`; `Panel … hint={STUB_CHANGES_NOTICE}` `:42`; `EmptyState "No change recorded" / "Deployments, restarts and failures will appear here."` `:44`; `ol.timeline` `:46-62`, row key `${event.id}-${index}` `:49`, `iconForKind` `:51`, `Link`/`span` `:55`, **`formatRelative(event.at)` `:56`**, detail `:58`; `iconForKind` `:69-86` exhaustive with **no default arm**.
- **`screens/Home.tsx`** — imports `:4` (`changeFeed, causalChain, STUB_CHANGES_NOTICE`), `:11` (`UPDATE_STATUS_CLAIM, UPDATE_STATUS_LABEL`); `useApp()` `:14`; **early returns `:16-18`** (`loading`, `error`, `!model`); `changeFeed(model).slice(0, 6)` `:22` — **unmemoized, re-rolls `Date.now()` on every render**; `causalChain(model)` `:23`; **Updates metric `:45` — #72-owned, rides `UPDATE_STATUS_LABEL` + `UPDATE_STATUS_CLAIM.detail`**; "What happened" causal panel `:62-73` (conditional on `chain`); "Recent change" panel `:118-140` — `hint={STUB_CHANGES_NOTICE}` `:118`, `EmptyState` `:119-120`, `ul.feed` `:122-138`, key `${c.id}-${index}` `:124`, `c.kind.replace("_", " ")` `:125` (**dead since #72 — no kind contains an underscore**), Link `:127`, plain span `:133`, **`formatRelative(c.at)` `:135`**.
- **`lib/copilot.ts`** — dispatch regex `/chang|recent|deploy|updat/` `:54`; `changeAnswer` `:168-175`: headline `"Recent and pending change"` `:171`, body `[`Update status: ${UPDATE_STATUS_LABEL} — ${UPDATE_STATUS_CLAIM.detail}.`]` `:172`. **Does not call `changeFeed`; invents no counts** (the pre-#72 defect is gone). Sole app consumer of `answer()`: `screens/Copilot.tsx:23`.

### 1.3 #71/#72 machinery available (shipped, verified)

`lib/evidence.ts` — `EvidenceKind` `:5`; `EVIDENCE_LABELS` `:21-27` (`demo` → label **"Sample data"**, description "Sample data — not from a host"; `unavailable` → label **"Not collected"**); `evidenceLabel` `:30-39` (fail-closed `Object.hasOwn`, throws on unknown); `EvidenceMode` `:42`; `resolveEvidenceMode` `:58-66` (demo first → `"demo"`; `docker` → `"live"`; `mock` → `"mock"`; else `null`); `claimAuthority` `:72-76` (`live`→`host`, `demo|mock`→**`sample`**, `null`→`none`); `Claim<T>` `:79-81`; `demoSample` `:103-105`; `unavailable` `:107-109` (non-empty detail enforced at construction).
`context.tsx:12` — `evidenceMode: EvidenceMode | null`, **required** field, reaching every screen. `AppShell.tsx:161-164` resolves it once per render.
`lib/updates.ts` — the shape #74 mirrors: internal detail constant `:19`, single public claim object `:26`, derived label `:29`, and the module header `:4-11` ("same claim under every authority level — including the null-authority window, never a mode branch").

### 1.4 Tests and e2e that this slice moves

- `screens/change-feed-identity.test.tsx` — `contextFor` pins `evidenceMode: "live"` `:71`; 3 direct-generator tests (`:89`, `:100`, `:113`) and 3 screen-render tests (`:121`, `:134`, `:142`) that **assert synthesized rows are visible under a live context** → break under gating by design.
- `screens/duplicate-list-keys.test.tsx` — shared `contextFor` `:127` pins `"live"` for 5 tests; only `:178` ("Home renders every attention row and feed row…") asserts `.feed-row` count 2 `:190` → breaks under gating.
- `lib/no-synthetic-updates.test.ts` — `for (const event of changeFeed(model))` `:103-105` → **compile break** on the new signature; `@ts-expect-error` + template-literal type probes `:110-124` are the G-37 pattern #74 copies; planted event object `:143-152` carries `estimated: true` behind `as unknown as ChangeEvent`.
- `screens/updates-surface.test.tsx` — G-15 live/mock/demo triples; `:52-54` renders `Changes` and asserts no `>Updates<` chip. Must stay green untouched.
- `screens/updates-wiring.test.tsx` — the G-36 template `#74` mirrors: real `AppShell` + `Home`, hoisted mutable mock state `:21-25`, demo→live `:42`, live→demo `:56`, generation change `:70`, **all flips inside `act()`**.
- `lib/evidence-render.test.tsx:27-29` — defers "a full unavailable-path surface render fixture … to the #72-#76 fixtures". #74 builds the history one.
- `tests/e2e/a11y.spec.ts` — mock stack via `startMockStack()` `:36`; `openRoute` `:52-57`; G2 test `:519-538` (impact cell "Not collected"; `/changes` has zero "Updates" chips `:536`); settings-injection pattern `:560-562` (`localStorage["dockermap.settings.v1"]`).
- `tests/e2e/dockermap.spec.ts:35` — nav smoke expects `h1` "Change Center"; the gated live state must keep that heading.
- `docs/design/DESIGN_LANGUAGE.md:56-63` — "Change Center" prose ("*Until daemon change collectors land, this view is clearly labelled as a sample timeline*") + `![Change Center](../screenshots/change-center.png)`. **No screenshot harness exists in the tree** (grep for `screenshot` over `scripts/`, `package.json`, `tests/e2e/` → zero hits; `zz-screenshot.spec.ts` is gone).

### 1.5 Decisive negative findings (checked, not assumed)

1. **The e2e mock stack resolves to `mock`, never `live`.** `startMockStack` runs the daemon with `DOCKERMAP_FORCE_MOCK=true`; `/api/health` reports `mode: "mock"` (`dockermap.spec.ts:29` asserts the "Mock Engine" pill), and `claimAuthority("mock") === "sample"`. **A live-authority assertion written against the default mock stack will fail** — see §3 R6.
2. **Health arrives over SSE**, not a polled endpoint: `useDaemonHeartbeat.ts:33-39` opens `EventSource("/api/events/stream")` and reads the `snapshot` event. Forcing live authority in a browser test means intercepting that stream, not `/api/health`.
3. **Runtime-Map node events are contract data, not client synthesis.** `Runtime.tsx:361-374` renders `selected.service.events` from `RuntimeMapNode` (`packages/contracts/src/index.ts:271-289`, `RuntimeEventRef.timestamp?`), documented "*Reserved — not emitted by current collectors*". The demo payload (`demoData.ts:249`) supplies events **with no `timestamp` field at all**, and `Runtime.tsx:369` guards `event.timestamp ?` before formatting. No `Date.now()` path exists. → **not a #74 surface** (Q2).
4. `demoData.ts:405` synthesizes log timestamps — demo-only transport payload on the logs surface, never reachable in live (`utils/api.ts:29-32` short-circuits every fetch in demo). Not change history. → #76.
5. `Date.now()` in `apps/web/src` outside tests exists at exactly: `AppShell.tsx:140,145` (wall clock display), `stubs.ts:91` (**this slice**), `demoData.ts:136,178,400,405,455,478` (demo payloads), `format.ts:9` (`formatRelative`'s `now` default). After #74, **`stubs.ts:91` is the only one reachable from a non-demo render path — and the gate makes it unreachable.**

---

## 2. Decisions — Q1-Q10 resolved, dissents D(a)-D(g) quoted and ruled on

### Q1 / dissent (a) — Gate mechanism (post-review amended by §9): **source-gate inside `changeFeed`/`causalChain`, taking required evidence mode plus required model provenance and returning a `Claim`.**

> **L6 (A):** "Source-gate: `changeFeed(model, authority)` returns `Claim<ChangeEvent[]>` — `demoSample(events)` when authority===\"sample\", `unavailable(\"history not collected\")` otherwise. 1 lib change; Changes.tsx:21/Home.tsx:22 narrow on claim.kind. Blast radius: 3 call sites + tests. Real feed later slots into the demo arm — call sites unchanged… (recommendation) A. Single point of truth in changeFeed… ~30 lines vs B's duplicated branches."
> **L4 (F3):** "Home.tsx has no memo at all — …a gate here is simpler" (render-side).
> **L3 (F4):** "gating in stubs.ts covers both; gating in screens duplicates."
> **#71 D10 `:277-279`:** `stubs.ts:86 changeFeed output | demo/mock → demo`; `Changes.tsx:43 timeline, Home.tsx:118 Recent change | live → unavailable — invented timestamps must not reach a live surface`.

**Decision: L6(A)'s source-gate is upheld, but its authority-only predicate is superseded by the binding Option A provenance ruling in §9.** D10 assigns an outcome to the *source* row (`stubs.ts:86`) as well as the two render rows — one gate satisfies all three. The decisive argument is G-24 (fail closed): a render-gate leaves an unsafe generator callable, while an authority-only source-gate still mistakes retained bytes for newly selected demo bytes. The source gate therefore requires both declared authority and the provenance stamped on the model's resource pair.

Binding signatures (`lib/stubs.ts`):

```ts
export function changeFeed(
  model: SystemModel,
  mode: EvidenceMode | null,
  modelProvenance: ModelProvenance | null
): Claim<ChangeEvent[]>;
export function causalChain(
  model: SystemModel,
  mode: EvidenceMode | null,
  modelProvenance: ModelProvenance | null
): Claim<CausalStep[]>;
```

Binding guard (shared private helper in `lib/stubs.ts`; both generators call it before reading `model` or `Date.now()`):

```ts
function maySynthesizeHistory(
  mode: EvidenceMode | null,
  modelProvenance: ModelProvenance | null
): boolean {
  if (claimAuthority(mode) !== "sample") return false;
  return (
    (mode === "demo" && modelProvenance === "demo") ||
    (mode === "mock" && modelProvenance === "daemon")
  );
}

if (!maySynthesizeHistory(mode, modelProvenance)) return CHANGE_HISTORY_CLAIM; // or CAUSAL_CHAIN_CLAIM
// …existing synthesis, unchanged…
return demoSample(events);
```

Sub-decisions, all binding:

1. **Both parameters are required:** `EvidenceMode | null` and `ModelProvenance | null`. No default and no optional parameter. `AppContext` carries both production values. Call sites pass `changeFeed(model, evidenceMode, modelProvenance)` directly; they do not derive, hard-code, or relabel provenance.
2. **`claimAuthority()` remains the single mode→authority mapping, but authority is necessary, not sufficient.** Demo samples require a demo-fetched model. Mock samples require a daemon-fetched model and the explicit `mode === "mock"` arm. `live`, `null`, unknown provenance, and every mode/provenance mismatch return unavailable.
3. **The guard is positive allow-listing, never `mode !== "live"`, `provenance !== "daemon"`, or an authority-only check.** A future mode/provenance value inherits the safe unavailable arm. The helper runs before any model iteration or clock read.
4. **`causalChain` returns `demoSample([])` instead of `null` only in an authorized matching sample arm.** A `Claim<CausalStep[]> | null` union is still rejected; `[]` carries identical information. The sample render keeps today's behaviour by checking `value.length > 0`.
5. **Do not narrow the return type with `Extract<Claim<T>, { kind: "demo" | "unavailable" }>`.** It silently evaluates to `never` for the non-unavailable arm (whose `kind` is a 4-member union, so it does not extend `{kind:"demo"|"unavailable"}`). Return plain `Claim<T>`; call sites narrow on `kind === "unavailable"` first.
6. **The synthesis body itself is not otherwise modified** — same emission rules, same `sort`/`slice`, same collision-safe `routeName`. #74 gates the feed; it does not redesign it. A future host collector is a separate host arm and cannot be inserted into this demo/mock synthesis arm (§9.6).

### Q2 / dissent (b) — Home ownership and the no-overlap call-out

> **Issue #74 scope:** "Home change-count/change-summary surfaces riding on sample data are covered here or by the sibling sweep slice — no overlap, call it out in the PR."
> **L1 (I6):** "#74 owns Home 'Recent change' panel (:118); Home 'Updates' metric… → sibling sweep slice (#61 §2)."
> **L3 (UQ):** "Home change-count/summary vs Runtime node events (demoData.ts:249-368) — which sweep slice owns the latter?"

**Decision — the binding ownership table. This table is the PR's no-overlap statement, copied verbatim into the PR body:**

| Home / app surface | Line | Owner | Why |
|---|---|---|---|
| "Recent change" panel | `Home.tsx:118-140` | **#74** | Renders `changeFeed` rows with `formatRelative(c.at)` — invented timestamps on a live surface. D10 `:278`. |
| "What happened" causal panel | `Home.tsx:62-73` | **#74** | Invented transition/consequence events. D10 `:279`. See Q3. |
| "Updates" metric | `Home.tsx:45` | **#72 — shipped, DO NOT TOUCH** | Already claim-backed via `lib/updates.ts`. Editing it re-opens `updates-wiring.test.tsx` and `a11y.spec.ts:507-509`. |
| Metrics `Services/Healthy/Need attention/Offline` | `Home.tsx:38-44` | out of scope | `derived` counts over the observed snapshot; D10 assigns `summarize` counts to **#75**. |
| Runtime Signals panel / Runtime "Recent events" | `Home.tsx:89-116`, `Runtime.tsx:361-374` | **#76 sweep** | Contract-sourced `RuntimeEventRef`, no client synthesis, no `Date.now()`, timestamp guarded (§1.5.3). Live values are observed; demo values arrive with the demo payload. |
| Demo log timestamps | `demoData.ts:405` | **#76 sweep** | Demo-only transport payload on the logs surface; unreachable in live. |
| Change Center timeline | `Changes.tsx:42-64` | **#74** | D10 `:278`. |

### Q3 / dissent (c) — `causalChain` "What happened": **gated to `unavailable` in live; the escape hatch is REJECTED; the panel renders unconditionally in the live arm.**

> **L4 (UQ):** "Should causalChain (Home.tsx:23) be gated too, or is it out of scope for #74?"
> **L6 (Q2):** "causalChain 'What happened' panel — tag-demo or gate too?"
> **#71 D10 `:279`:** `stubs.ts:131 causalChain → Home.tsx:63 | demo / mock demo; live unavailable (or inferred **only** if rebuilt from observed states)`.

**Ruling in three parts.**

1. **It is in scope, and it is gated.** The panel asserts two events that were never observed: "*X went offline*" claims a *transition* (the snapshot proves only that X **is** offline — cf. DM-06's `internal === false` → "externally reachable" precedent), and "*Y lost its upstream connection*" claims a connection failure for which DockerMap has no telemetry in any mode. Both are exactly the "invents … events" half of the AC, even though no timestamp is involved. Leaving it because it has no `at` field would be a fix that closes the cited site and leaves the class open (DM-08).
2. **The `inferred`-if-rebuilt escape hatch is explicitly REJECTED for #74.** Taking it means designing and shipping a real causal inference over observed state (present-tense copy, a defensible dependency-cascade heuristic, and its own evidence tagging) — new product behaviour inside a slice whose non-goals are "real event collection" and whose value is *removing* claims. It also collides with #75, which owns `inferred` tagging for `classifyKind`/`stateForStatus` (D10 `:283`) — the very predicates such a rebuild would rest on. Recorded as an available future move for #75/#76, not taken here.
3. **In the live/null arm the panel renders unconditionally**, carrying the claim; in the demo/mock arm it stays exactly as today (rendered only when the chain is non-empty). Rationale: (i) a live panel that appears only when an offline service exists makes the panel's *presence* an implicit event claim and adds a second, untested gate; (ii) it follows #72 Q3's upheld reasoning that a persistent claim tile "actively teaches the true state of the product" whereas a vanishing surface reads as "fixed / none"; (iii) it gives the G-15 live arm a stable assertion target that does not depend on whether the fixture happens to contain an offline service.

### Q4 / dissent (d) — Copilot: **one mode-independent line added to `changeAnswer`. Everything else stays with #75.**

> **L1 (R2):** "copilot 'recent change' answers hash-derived updates as live facts (copilot.ts:168-174) — gate/label even though it isn't timeline synthesis (#61 §5)."
> **L4 (F5):** "Copilot is safe — changeAnswer doesn't use changeFeed; no breakage from gating."
> **#71 D10 `:280`:** `copilot.ts:167 changeAnswer | live | unavailable for the change claim` → **#75**.
> **#72 §4 item 7 (`:382`):** "What does Copilot answer for 'what changed recently'? `Update status: Not collected — …` with no service references. **Thin by design; #74 fills it.**"

**Decision.** L4 is factually right (nothing breaks) and L1's cited defect is already dead post-#72 — but "nothing breaks" is not "nothing is wrong". Today, asking *"what changed recently"* returns **only** an update-status line. A user reads that as "the only thing to report is that update checks are missing", i.e. an implicit assertion that no change history is missing — the same *asserted-negative-by-omission* defect #72 Q7 killed in the inverse direction ("No pending updates detected."). #72's own resolved-questions table hands this to #74 by name.

The two precedents are reconciled by claim, not by file: **#74 owns the *history* claim inside `changeAnswer`; #75 owns everything else in copilot** — the mode-aware phrasing, the `observed`/`derived`/`inferred` tagging of `serviceOverviewAnswer`/`computeImpact`/`classifyKind` (D10 `:281-283`), and any change to the `:54` dispatch regex or the `"Recent and pending change"` headline (both are topics, not assertions — **do not touch them in #74**).

Binding change — `copilot.ts:172` becomes a two-element body:

```ts
body: [
  `Update status: ${UPDATE_STATUS_LABEL} — ${UPDATE_STATUS_CLAIM.detail}.`,
  `Change history: ${NOT_COLLECTED_LABEL} — ${CHANGE_HISTORY_CLAIM.detail}.`
],
```

**No `evidenceMode` parameter is added to `answer()`.** The claim is authority-independent for the same reason `updates.ts:4-11` gives: DockerMap records no change events in *any* mode — the demo timeline is sample data, not recorded history — so the sentence is true under `host`, `sample`, and `none` alike, and a mode branch would imply the answer varies by mode (itself an overclaim). Cost of the alternative is noted for #75: `answer()` has exactly one app consumer (`Copilot.tsx:23`), so mode plumbing is cheap when a mode-*dependent* copilot claim actually needs it.

### Q5 / dissent (g) — Mock mode: **mock keeps the tagged sample timeline; `none` fails closed to unavailable.**

> **L4 (UQ):** "Should mock mode also gate the synthetic feed, or is mock acceptable (it's explicitly not-live but not demo)?"
> **L5 (#7):** "'mock' mode undefined for the gate — e2e ambiguity."
> **L6:** "claimAuthority maps demo AND mock → 'sample' (evidence.ts:73-74); e2e + zz-screenshot run the mock stack, so mock must keep the sample timeline — the 'sample vs host' split is exactly the right gate, and claimAuthority(null)='none' fail-closes pre-resolution."

**Decision (post-review amended):** mock still samples, but only through the explicit matching pair `mode === "mock" && modelProvenance === "daemon"`; demo samples only through `mode === "demo" && modelProvenance === "demo"`. Authority-only gating is rejected by §9. Consequences, all binding:

- The default e2e stack (mock) shows the **sample timeline tagged "Sample data"** after its daemon-fetched model pair lands — *not* "Not collected". Any assertion written the other way for the settled mock state is wrong (§3 R6).
- **Every unresolved or mismatched window takes the unavailable arm:** `mode === null`; demo authority with retained daemon provenance (live→demo); mock authority with retained demo provenance (demo→mock); or a split snapshot/runtime provenance pair. The screens show "Not collected", zero rows/chips, and no "Sample data" until a matching same-generation pair is published. This is the correct direction (fail-closed → more information, never sample-as-observed) and is asserted by V2/V3.
- In demo, `settings.demoMode` is known synchronously, but the model provenance is asynchronous. Therefore live→demo now intentionally has a short unavailable window; the earlier statement that demo has no such window is withdrawn.
- The demo e2e leg must flip `settings.demoMode` to `true` via the `localStorage["dockermap.settings.v1"]` init-script pattern at `a11y.spec.ts:560-562`. Payload: `{"demoMode": true}` **alone** — per DM-11, absent keys merge over defaults and present-but-invalid keys are rejected, so a single-key payload is both valid and the minimal one.

### Q6 / dissent (f) — Exact strings (binding; no paraphrasing anywhere)

> **L6 (Q3):** "which detail string for the unavailable arm."
> **L1 (I3):** EmptyState copy "No change recorded…will appear here" (`:44`/`:120`) "must not imply collection happened" — L6: the "will appear here" empty state "is false in live".
> **#71 P2-2:** `detail` (never the static `description`) renders during the null-authority window; the description is reserved for permanent non-collection.

New module `apps/web/src/lib/history.ts`, mirroring `updates.ts` (internal detail constants; **one public claim object per claim**, per #72 U3 — consumers read `.detail` off the claim, never a standalone exported detail string):

```ts
const CHANGE_HISTORY_DETAIL = "Change collectors not wired — DockerMap does not record deploy, restart or failure events";
const CAUSAL_CHAIN_DETAIL   = "Event causality not reconstructed — DockerMap observes current state, not transitions";

export const CHANGE_HISTORY_CLAIM = unavailable(CHANGE_HISTORY_DETAIL);
export const CAUSAL_CHAIN_CLAIM   = unavailable(CAUSAL_CHAIN_DETAIL);
export const NOT_COLLECTED_LABEL  = evidenceLabel(CHANGE_HISTORY_CLAIM.kind).label; // "Not collected" — derive from the claim, mirroring updates.ts
export const SAMPLE_EMPTY_TITLE   = "No sample change";
export const SAMPLE_EMPTY_BODY    = "The sample topology has no change events right now.";
export const SAMPLE_FILTERED_EMPTY_BODY = "No sample change events match this filter.";
```

Wording rationale (DM-06/G-23): each unavailable detail states **what is missing** and **why it stays missing**, and claims nothing about whether changes occurred. `SAMPLE_EMPTY_BODY` is the one canonical true-empty body on both Home and Changes. `SAMPLE_FILTERED_EMPTY_BODY` is used only when `events.length > 0 && filtered.length === 0`; it says the filter has no match rather than falsely claiming the sample feed has no events. `NOT_COLLECTED_LABEL` derives from `CHANGE_HISTORY_CLAIM.kind` (not a duplicated `"unavailable"` literal), mirroring `updates.ts`, so the display label and claim cannot drift.

**Deleted copy (must not survive anywhere):** `"Sample timeline — change collectors not yet wired"`, `"No change recorded"`, `"Deployments, restarts and failures will appear here."`, `"No recent change"`, `"Deployments and restarts will appear here."` — every one of them implies that collection is happening.

**Two claims, not one**, deliberately: they describe different absences (no recorded events vs. no causality reconstruction). Collapsing them would make one of the two surfaces state a false reason.

### Q7 — `STUB_CHANGES_NOTICE` and `estimated: true`: **both removed, in the same commit that tags the surfaces.**

> **#71 Q12 (`:316`):** "#73 removes the resource pair, #74 removes the change pair, each in the same commit that tags its surfaces." **#71 R1 (`:290`):** `STUB_CHANGES_NOTICE` is a label-drift instance "scheduled for removal in #73/#74".

- **`STUB_CHANGES_NOTICE` (`stubs.ts:17`) is deleted**, along with both imports (`Changes.tsx:4`, `Home.tsx:4`). Replacement hint mechanism: **`Panel.hint={evidenceLabel(claim.kind).label}`** on every gated panel — "Sample data" under sample authority, "Not collected" otherwise. One expression covers both arms, the string exists only in `evidence.ts` (R1 discharged), and the hint is always a non-empty string so `primitives.tsx:63`'s falsy suppression can never blank it (G-19).
- **`ChangeEvent.estimated` (`stubs.ts:68`) and its assignment (`:118`) are deleted.** The `Claim` kind now carries provenance; a per-event boolean is the weaker parallel vocabulary #71 D9 `:263` forbids extending, and it is the copy-paste hazard L1 R4 flagged for a future real collector. Its removal is locked by a G-37 type probe (§7 V3).
- **`STUB_NOTICE` (`:16`) and `ResourceSample.estimated` (`:27`, `:44`) are NOT touched** — they are #73's, and deleting them here would leave the resource surfaces with no qualifier at all (#71 Q12's reasoning).
- The `stubs.ts:71-78` totality comment is updated to drop the "*#74 owns the feed's emission surface*" hand-off (now discharged) and to state the gate. `CHANGE_TEMPLATES` itself is unchanged.

### Q8 — Filter chips in live: **the `.filter-row` is not rendered under non-sample authority.**

> **L5 (⑤):** "filter-chips (Restarts/Failures/Recoveries) filter to permanently empty lists in live — doc's Updates-chip-removal reasoning (a11y:536) now applies to the surviving chips, decide hide-vs-empty."

**Decision: hide the whole row (not disabled chips, not chips over an empty list).** #72 Q8's ruling — a chip that filters to a permanently empty list reads as "no updates exist" — applies unchanged to Restarts/Failures/Recoveries once live has no events at all; a *disabled* chip still asserts that the category exists and is currently empty. The chips are controls for the sample timeline and render only with it. Binding: wrap `Changes.tsx:33-39` in `{history.kind !== "unavailable" && ( … )}`.

- The `useState` at `:18` **stays where it is** (unconditional hook; removing or conditionalising it is a rules-of-hooks violation).
- A filter selected in demo and still selected after demo→live→demo is a *user's own* UI preference, not mode-dependent data, and does not fall under DM-12. It is explicitly accepted; the wiring test asserts the rows come back after the return flip so a retained filter cannot hide them silently.

### Q9 — Demo-tagging granularity: **panel-level, through `Panel.hint`.**

> **L1 (I2):** per-event evidence label vs panel-level hint/tag — which renders "visibly tagged demo"?

**Decision: panel-level.** `hint={evidenceLabel(claim.kind).label}` renders "Sample data" as visible text in the panel header of every gated surface (`primitives.tsx:63`, `.panel-hint`), which satisfies the AC's "visibly tagged demo" and is what `STUB_CHANGES_NOTICE` occupied. Per-event tags are rejected: 24 tags in the Change Center is a design decision epic #67 owns, the per-row `Tag` would repeat one string 24 times (R1 drift surface), and the claim is a property of the *feed*, not of each event. The label is **plain text, not wrapped in `Tag`** — tone/colour per kind is #67's (#71 R8).

### Q10 — Fixture split (R9 discipline: split the arms, never weaken the assertions)

> **doc R9 (`:298`):** each fixture "must pass the mode its fixture actually intends … never a copy-pasted `demo`."

| File | Test | New mode | Why this is the intended mode, not a weakening |
|---|---|---|---|
| `change-feed-identity.test.tsx` | `:89`, `:100` (direct `changeFeed`) | `"demo"` (2nd arg) | They assert identity normalisation **inside the sample generator** (`Unavailable service name`, null `routeName`). That generator now exists only under sample authority; asserting it under live would assert nothing. Each call also unwraps the claim, which is itself a check that the demo arm is a `demo` claim. |
| `change-feed-identity.test.tsx` | `:113` (`causalChain`) | `"demo"` | Same. |
| `change-feed-identity.test.tsx` | `:121`, `:134`, `:142` (screen renders) | `contextFor(snapshot, "demo")` | They assert that empty/collided identities render as visible non-routable text **in the rendered rows**. Rows exist only in the demo arm. The live arm is not deleted — it moves to the new `history-surface.test.tsx`, where "no rows at all" is the point. |
| `duplicate-list-keys.test.tsx` | `:178` (Home feed rows) | `contextFor(fixture, runtime, "demo")` | The assertion is React-key collision safety over `.feed-row`; with zero rows the test is vacuous (G-15). |
| `duplicate-list-keys.test.tsx` | `:195`, `:215`, `:233`, `:249` | `"live"` (unchanged) | Logs/ServiceDetail/Runtime assertions are host-shaped and mode-independent. |
| `no-synthetic-updates.test.ts` | `:103-105` feed scan | `changeFeed(model, "demo")`, unwrapped | The update-vocabulary tripwire must scan the arm that **has** events; the live arm has none, so scanning it would silently become a no-op — the vacuity class G-15 arrests. A comment must record this. |

`contextFor` in both files gains an explicit `mode: EvidenceMode` parameter with **no default value** (a defaulted test helper is the same fail-open shape as a defaulted gate).

---

## 3. Risks and mitigations

### 3.1 L5's naive-fix failure modes (post-#72 adjusted), each eliminated by construction

| # | Failure mode | Eliminated by |
|---|---|---|
| ① | Gate only `Changes.tsx` → `Home.tsx:22`/`:118` and the causal panel `:62` keep leaking samples in live | Q1's source-gate: there is no un-gated way to obtain events. Q2 assigns both Home panels to #74; V1 asserts both. |
| ② | `changeFeed` stays synthesized for live consumers; `Date.now()` re-rolls per call → non-deterministic tests | The live arm returns a module-level frozen-shape constant; §1.5.5 shows `stubs.ts:91` becomes unreachable outside sample authority, and V3's clock spy proves it. |
| ③ | Rows hidden but the `STUB_CHANGES_NOTICE` hint kept → label leak | Q7 deletes the constant outright (compile error if referenced); V1's live arm asserts no `\bSample\b` anywhere on the screen. |
| ④ | DM-12/R7 model-only memo, or authority-only gating, publishes stale identifiers after a mode flip | Every memo lists `[model, evidenceMode, modelProvenance]`; the source gate requires an allow-listed mode/provenance pair. V2 holds model+provenance fixed while flipping only `demoMode` in both directions and proves the retained real sentinel never renders or acquires a Sample label. |
| ⑤ | Filter chips filtering to a permanently empty list ("no restarts exist") | Q8 hides the row under non-sample authority; e2e asserts zero `.filter-chip` in the live leg. |
| ⑥ | ~~Copilot invented counts~~ | **INVALID post-#72** — `changeAnswer` is claim-based and does not call `changeFeed`. Q4 addresses the residual omission instead. |
| ⑦ | Mock mode undefined for the gate | Q5 pins the exact allow-list: `mock` + `daemon` provenance → tagged sample; all other mock provenance and `null` → unavailable. |

### 3.2 Further risks specific to this design

| # | Risk | Mitigation (binding) |
|---|---|---|
| R1 | **Hook-order violation on Home.** `Home.tsx:16-18` early-returns *before* line 22. Adding `useMemo` at the current derivation site makes it a conditional hook — a runtime crash on the first `loading` render, and an ESLint `rules-of-hooks` error. | The two `useMemo`s are hoisted to **immediately after `useApp()` at `:14`**, above every early return, with `model ? … : CHANGE_HISTORY_CLAIM` inside. §4.2 specifies the exact placement. |
| R2 | **`Extract<Claim<T>, …>` evaluates to `never`** for the value arm (4-member `kind` union), producing a return type that accepts only the unavailable arm and failing the demo path with a confusing error. | Q1.5: return plain `Claim<T>`; narrow with `kind === "unavailable"`. |
| R3 | **Compile break in `no-synthetic-updates.test.ts:103`** (one-arg `changeFeed`) is easy to "fix" by deleting the loop, silently dropping the update-vocabulary tripwire. | Q10 requires the loop to survive with `changeFeed(model, "demo")` unwrapped, plus a comment; V6 requires the #72 suites green *and unweakened*. |
| R4 | **Demo `Date.now()` re-roll per render** → `makeEvent` ids change every render → new React keys → the whole list remounts. | The Home memo makes the demo feed stable per `[model, evidenceMode, modelProvenance]` **within one model generation**. A successful refresh publishes a new model object and intentionally re-rolls the sample feed; this pre-existing generation-to-generation behaviour is accepted for #74. |
| R5 | **Two adjacent "Not collected" panels on live Home** (Recent change + What happened) read as boilerplate. | Accepted, deliberate: they carry **different details** (no recorded events vs. no causality reconstruction), which is precisely why Q6 defines two strings. Flagged for the #67 restyle, not solved here. |
| R6 | **Mock-vs-live e2e trap.** Writing the "live" leg against `startMockStack()` and asserting "Not collected" fails: the mock stack resolves to `mock` → sample authority (§1.5.1). Conversely, asserting samples in the *demo* leg without the init-script flip tests nothing new. | §7 V4/V5 give the exact mechanism per leg (SSE interception for live; `localStorage` init-script for demo) and a named fallback if the intercept is unstable. |
| R7 | **Screenshot churn.** `DESIGN_LANGUAGE.md:63` embeds `change-center.png`, whose panel hint text changes. **No screenshot harness exists in the tree** (§1.4). | Q: **do not rebuild the harness and do not regenerate the image in #74.** The prose at `:56-61` is updated to the gated reality; the PR body records "the change-center image predates the #74 hint copy"; regeneration is assigned to #76. Rebuilding an uncommitted Playwright harness is a slice of its own and is out of #74's scope. |
| R8 | **`dockermap.spec.ts:35` nav smoke** expects `h1` "Change Center" — a gate that removed the screen or the heading breaks it. | The heading and the screen shell are outside the gated region; V4 re-asserts the `h1` in the live leg specifically. |
| R9 | **Fixture churn waved through.** Six tests change mode in one commit. | Q10's table gives a per-test justification; the reviewer's job is to check each against that table, and R9's rule stands: split the arm, never weaken the assertion. |
| R10 | **A future surface calls the gated functions with a hard-coded mode** to "just get some data". | The parameter type is `EvidenceMode | null`, so `changeFeed(model, "demo")` compiles — it is legal *only* in tests. Review grep for `changeFeed(` / `causalChain(` with a literal second argument outside `*.test.*` is a P2 finding; recorded here so pass-2 runs it. |

---

## 4. Binding render shapes

### 4.1 `screens/Changes.tsx`

```tsx
const { model, modelProvenance, loading, error, evidenceMode } = useApp();
const [kind, setKind] = useState<ChangeEvent["kind"] | "all">("all");
const history = useMemo(
  () => (model ? changeFeed(model, evidenceMode, modelProvenance) : CHANGE_HISTORY_CLAIM),
  [model, evidenceMode, modelProvenance]
);
const events = history.kind === "unavailable" ? [] : history.value;
const filtered = kind === "all" ? events : events.filter((e) => e.kind === kind);
// …early returns unchanged…

{history.kind !== "unavailable" && (<div className="filter-row">…unchanged…</div>)}

<Panel className="panel-change-timeline" title="Timeline" icon="history" hint={evidenceLabel(history.kind).label}>
  {history.kind === "unavailable" ? (
    <EmptyState icon="history" title={evidenceLabel(history.kind).label} body={history.detail} />
  ) : filtered.length === 0 ? (
    <EmptyState
      icon="history"
      title={SAMPLE_EMPTY_TITLE}
      body={events.length === 0 ? SAMPLE_EMPTY_BODY : SAMPLE_FILTERED_EMPTY_BODY}
    />
  ) : (
    <ol className="timeline">…rows unchanged…</ol>
  )}
</Panel>
```

`iconForKind` retains its exhaustive switch and **must be restored to readable multi-line form**. Immediately above the switch, restore the exact rationale comment `// No default swallow — a kind added to the union is a compile error.`; there is no `default` arm.

### 4.2 `screens/Home.tsx`

```tsx
const { model, modelProvenance, loading, error, evidenceMode } = useApp();
// Hoisted ABOVE the early returns at :16-18 — a useMemo after a conditional
// return is a rules-of-hooks violation (R1).
const history = useMemo(
  () => (model ? changeFeed(model, evidenceMode, modelProvenance) : CHANGE_HISTORY_CLAIM),
  [model, evidenceMode, modelProvenance]
);
const chain = useMemo(
  () => (model ? causalChain(model, evidenceMode, modelProvenance) : CAUSAL_CHAIN_CLAIM),
  [model, evidenceMode, modelProvenance]
);
// …early returns…
const changes = history.kind === "unavailable" ? [] : history.value.slice(0, 6);
```

"What happened" (replaces `:62-73`):

```tsx
{chain.kind === "unavailable" ? (
  <Panel className="panel-causal-chain" title="What happened" icon="pulse" hint={evidenceLabel(chain.kind).label}>
    <EmptyState icon="pulse" title={evidenceLabel(chain.kind).label} body={chain.detail} />
  </Panel>
) : chain.value.length > 0 ? (
  <Panel className="panel-causal-chain" title="What happened" icon="pulse" hint={evidenceLabel(chain.kind).label}>
    <ol className="chain">…steps unchanged…</ol>
  </Panel>
) : null}
```

"Recent change" (replaces the old panel): same three-branch shape as §4.1, `className="panel-recent-change"`, true-empty copy `SAMPLE_EMPTY_TITLE` / `SAMPLE_EMPTY_BODY` (no inline body variant), and `{c.kind}` replacing the dead `c.kind.replace("_", " ")`.

**G3 readability remediation is binding, not cosmetic:** restore `Home`'s outer return to a parenthesized multi-line JSX tree; put the header, each grid/stack, each `Panel`, each ternary arm, and each mapped row on separate indented blocks. Restore `ServiceRow` to a parenthesized multi-line `<li>` and `byState` to a multi-line function with the `order` declaration and `return` on separate lines. In `Changes`, restore the mapped `<li>`, route-title ternary, and `iconForKind` cases to multi-line blocks plus the exact exhaustive-switch comment in §4.1. Do not change behaviour while formatting; the purpose is to keep #75/#76-owned neighbors reviewable.

**`className` on the three panels is required, not cosmetic (DM-02c):** Playwright strict mode breaks on shared selectors, and both `Home` and `Changes` will carry more than one `.panel-hint`. **No CSS rule is added** for these classes — they are test locators, exactly like `.metric-updates` (#72 Q3).

---

## 5. Resolved product questions (nothing left to implementer judgment — G-14)

1. **Does live mode ever show a change event?** No — not a row, not a timestamp, not a causal step, in live or in the pre-heartbeat window.
2. **Does demo mode keep the sample timeline?** Yes, on both surfaces, tagged **"Sample data"** in the panel header.
3. **Does mock mode behave like demo or like live?** Like demo (sample authority), per #71 Q5/D10. The default e2e stack is mock.
4. **What does live show instead of the timeline?** Panel hint **"Not collected"**; empty state titled **"Not collected"** with body *"Change collectors not wired — DockerMap does not record deploy, restart or failure events"*.
5. **What does live show for "What happened"?** The panel, always, with body *"Event causality not reconstructed — DockerMap observes current state, not transitions"*.
6. **Do the filter chips exist in live?** No — the whole `.filter-row` is absent under non-sample authority.
7. **Does the Change Center screen/heading survive in live?** Yes. `h1` "Change Center" is untouched (`dockermap.spec.ts:35`).
8. **Does Copilot change?** One added line: *"Change history: Not collected — Change collectors not wired — DockerMap does not record deploy, restart or failure events."* Headline, dispatch regex, and the update line are untouched.
9. **Does the Home "Updates" metric change?** No. #72 owns it; touching it is a P1.
10. **Do Runtime-Map events / demo logs change?** No — contract-sourced or demo-only transport payloads; assigned to #76 in the §2 Q2 table.
11. **Is `STUB_CHANGES_NOTICE` gone?** Yes, deleted. `STUB_NOTICE` (resources) stays for #73.
12. **Is `estimated: true` gone from `ChangeEvent`?** Yes, and locked by a type probe. `ResourceSample.estimated` stays for #73.
13. **Is the change-center screenshot regenerated?** No — no harness exists; prose updated, staleness recorded in the PR body, regeneration assigned to #76.
14. **Any contract/daemon/API change?** None. Web-only.
15. **Exact user-visible strings (binding, no paraphrasing):** hints `Sample data` / `Not collected` (both from `evidenceLabel`, never hard-coded at a call site); details as in Q6; sample true-empty copy `No sample change` + `The sample topology has no change events right now.` on both Home and Changes; filtered-empty body `No sample change events match this filter.` on Changes only; Change Center `h1` `Change Center`; Home panel titles `Recent change`, `What happened` (unchanged).

---

## 6. Arrested lessons

Per-lesson prose is deliberately **not** re-documented here — the registers are the single source of truth (#72 U9). Each id below names where this slice discharges it.

**Arrested by this slice:**
G-01 (schema-escape: every mode/provenance pair incl. `null` has an allow-listed or unavailable outcome) · G-03 (e2e asserts real mock output — settled mock + daemon provenance shows samples) · G-08 (#72 fixes and every remediation are re-read, not assumed) · G-12 (screenshot deferral remains R7) · G-14 (§2, §5, §9 — zero implementer choices) · G-15 (negative leak assertions pair with sample resumption and exact filtered-empty truth) · G-19 (non-empty labels/copy at every render) · G-22 (visible labels) · G-23 (all superseded authority-only rules and empty-copy variants are amended in this file; V6 residual greps) · G-24 (unknown/missing/mismatched provenance blocks synthesis) · G-36 (V2 holds the carrier fixed while mode alone changes) · G-37 (literal-preserving probes + fire-test) · DM-01 (network-quiet) · DM-02 (real mock semantics, unique locators, no `networkidle`) · DM-05 (identity fallbacks preserved and a real-name sentinel proves no leak) · DM-06 (no real identifier is ever Sample-labelled during live→demo) · DM-07 (the post-review defect was found by tracing `useApiResource`/`useSystemModel`; §9 now explicitly changes and tests that layer) · DM-08 (both source generators and all consumers close together) · DM-09/DM-12 (provenance is retained with the model; `[model, evidenceMode, modelProvenance]`; model-fixed transitions) · DM-11 (single-key demo settings payload).

**N/A for this slice (no surface exists):** G-02 (no library-behaviour claim; React/Playwright behaviour is unchanged) · G-04, G-05, G-06, G-07, G-09, G-10, G-11, G-13, G-16, G-17, G-18 (no balance/telemetry/render-size/cache/visual-matrix surface) · G-20, G-21 (join/key semantics unchanged — the existing occurrence-qualified keys are preserved verbatim) · G-25, G-26, G-27, G-28, G-29, G-30, G-31, G-32, G-33, G-34, G-35 (no async/transaction/secret/env/queue/cleanup surface) · DM-03 (no daemon/API change → no live-Docker release gate; noted in the PR body) · DM-04 (no Rust) · DM-10 (no release-artifact change).

---

## 7. Ordered implementation checklist

Smallest reversible commits; **every commit leaves `npm run check` green**. One commit per atomic change — a split that produces a non-compiling intermediate is a P1 (#72 U1).

| # | Commit message (exact) | Contents | Green because |
|---|---|---|---|
| 1 | `Architect pass 1: gate change history design (#74)` — **landed as `865e2a7`** (this file only; the checklist's originally proposed title was superseded by the push title — amendment 2026-08-25) | this file | docs only |
| 2 | `web: add the change-history evidence claims (#74)` | `apps/web/src/lib/history.ts` (Q6) | new module, no consumers yet; `unavailable()` validates both details at import time |
| 3 | **`web: gate synthetic change history behind sample authority (#74)`** — **ATOMIC, DO NOT SPLIT** | `stubs.ts` (signatures + claim returns + delete `STUB_CHANGES_NOTICE` + delete `ChangeEvent.estimated` + comment refresh); `Changes.tsx` (§4.1); `Home.tsx` (§4.2); `change-feed-identity.test.tsx` + `duplicate-list-keys.test.tsx` + `no-synthetic-updates.test.ts` mode split (Q10); **new `screens/history-surface.test.tsx` (V1) and `screens/history-wiring.test.tsx` (V2)** | the signature change breaks every consumer at once; G-36 requires the behaviour locks in the same commit |
| 4 | `test: lock synthetic history out of every non-sample authority (#74)` | new `lib/no-synthetic-history.test.ts` (V3: authority matrix, clock spy, type probes) | additive |
| 5 | `web: answer change questions with the history claim (#74)` | `copilot.ts:172` (Q4) + `copilot.test.ts` assertion in the same commit (G-36) | additive |
| 6 | `e2e: assert change history is sample-tagged in demo and not collected in live (#74)` | `tests/e2e/a11y.spec.ts` legs (V4/V5) | additive |
| 7 | `docs: describe the gated change history in the design language (#74)` | `DESIGN_LANGUAGE.md:56-61` prose (G-23) | docs only |
| 8 | **`web: bind sample history to model provenance (#74)` — ATOMIC, DO NOT SPLIT** | `lib/evidence.ts`; `hooks/useApiResource.ts`; `hooks/useSystemModel.ts`; `context.tsx`; `components/AppShell.tsx`; `lib/stubs.ts`; `screens/Home.tsx`; `screens/Changes.tsx`; provenance/mismatch tests and all required typed fixtures listed in §9.4 | The type/signature/context change crosses the whole path. It lands with the V2/V3 regressions; no intermediate commit may compile with authority-only gating or relabel retained data. |
| 9 | `web: reconcile change-history empty states and readability (#74)` | G1: `lib/history.ts`, `Home.tsx`, `Changes.tsx`, exact true/filtered-empty tests; G3: restore multi-line `Home.tsx`/`Changes.tsx` and exhaustive-switch comment | Behaviour and copy remain locked by tests; formatting changes no semantics. |

Rows 8-9 are the post-review remediation sequence. Implement them in that order; do not fold provenance into `SystemModel`/`buildModel`, do not choose B/C, and do not substitute different copy.

PR body must carry: the §2 Q2 ownership table verbatim (the issue's no-overlap requirement), the accepted scope statements (live loses the causal narrative and the filter chips; demo/mock keep everything, tagged), the stale-screenshot note (R7), and the DM-03 statement that no live-Docker gate is required. Closure: a `## Resolution Evidence` comment (What changed / Why this resolves / How I checked / Remaining risk) — **never self-close** (DM-01).

---

## 8. Test / e2e plan

| ID | Criterion | Discharged by |
|---|---|---|
| **V1** | **G-15 sample/non-sample pairs per surface** | **`screens/history-surface.test.tsx`** — `renderToStaticMarkup` + `visibleText`, with explicit tuples `["live", liveSnapshot, "daemon"]`, `[null, liveSnapshot, "daemon"]`, `["demo", sampleSnapshot, "demo"]`, `["mock", sampleSnapshot, "daemon"]`. `sampleSnapshot` (offline container) is deliberately used for both sample arms because it deterministically emits feed + causal rows; this is stronger than the earlier `demoSnapshot`/`liveSnapshot` proposal. Live+null: "Not collected", both details, zero timeline/feed/filter rows, no relative time, no `Sample`; heading survives. Matching demo+mock: rows/steps present, hint "Sample data", four chips. Add mismatch tuples `["demo", liveSnapshot, "daemon"]` and `["mock", sampleSnapshot, "demo"]`: unavailable, zero rows, no sample label. Assert canonical true-empty copy with an eventless matching sample model. |
| **V2** | **G-36 model-fixed bidirectional wiring + DM-12 provenance race** | **`screens/history-wiring.test.tsx`**, real `AppShell` with hoisted `state = { demoMode, health, model, modelProvenance }`; mocked `useSystemModel` returns both model fields. Use an offline live fixture named exactly `prod-secret-host` so authority-only gating would deterministically fabricate a leaking failure row. (a) **live→demo mismatch, model held fixed:** start `demoMode=false`, fixed docker health, `model=liveModel`, `modelProvenance="daemon"`; assert no rows. Inside one `act()`, change **only** `demoMode=true` and rerender; do not change health/model/provenance. Assert Home and Changes each have zero feed/timeline rows, zero sample chips where applicable, no `Sample data`, and no `prod-secret-host`; assert "Not collected". Then, in a separate `act()`, publish `demoModel` + `modelProvenance="demo"` without changing mode; assert tagged rows resume. (b) **demo→live mismatch, model held fixed:** start `demoMode=true`, fixed docker health, `demoModel` + `"demo"`; assert rows. Flip **only** `demoMode=false`; keep model/provenance fixed; assert rows/chips/Sample label disappear and "Not collected" appears. (c) null authority and same-mode generation changes remain unavailable as before. Run both `/` and `/changes`; no `Outlet` import (AppShell owns it). This test is invalid if model or provenance changes in the same `act()` as either mode flip. Add a client interaction selecting Recoveries under matching sample state and assert the exact filtered-empty body `No sample change events match this filter.` while the unfiltered feed has events. |
| **V3** | **G-37 + provenance gate unit matrix** | **`lib/no-synthetic-history.test.ts`**: hard-code (do not re-derive through `claimAuthority`) the expected kinds for `[live,daemon]→unavailable`, `[live,demo]→unavailable`, `[null,daemon]→unavailable`, `[null,demo]→unavailable`, `[demo,demo]→demo`, `[demo,daemon]→unavailable`, `[mock,daemon]→demo`, `[mock,demo]→unavailable`; run both generators and pin unavailable singleton/details. Clock spy is restored in `afterEach`/`try-finally`; `Date.now()` is called only for authorized `changeFeed` pairs (`demo/demo`, `mock/daemon`) and not for any mismatch. Do not include the vacuous `causalChain(model, null)` clock leg or the tautological blind-spot assertion. Update literal type probes and every direct call to the required third argument, e.g. `changeFeed(model, "demo", "demo")`; retain the manual TS2578 fire-test record. |
| **V4** | **Live e2e leg** | `a11y.spec.ts`, new test *"change history reports not collected under live authority"*: intercept `**/api/events/stream*` and fulfil a `text/event-stream` body carrying one `event: snapshot` frame with `{"status":"ok","mode":"docker","dockerReachable":true,…}` so `resolveEvidenceMode` returns `"live"`; wait for `.conn-mode` = "Docker Engine"; then on `/changes`: `.panel-change-timeline .panel-hint` = "Not collected", `.timeline-row` count 0, `.filter-chip` count 0, `h1` "Change Center" visible, page text has no `Sample data`; on `/`: `.panel-recent-change` and `.panel-causal-chain` both contain "Not collected". Use `domcontentloaded` + explicit waits, never `networkidle` (DM-02b). **Named fallback (not implementer judgment):** if the intercepted stream does not yield "Docker Engine" within one debugging iteration, drop this leg, keep V5, and record in the PR body that live authority is covered by V2 (real `AppShell` + real `resolveEvidenceMode` + `health.mode: "docker"`) and V1's live arm. |
| **V5** | **Demo e2e leg** | `a11y.spec.ts`, new test *"change history renders tagged samples in demo mode"*: `context.addInitScript` setting `localStorage["dockermap.settings.v1"] = JSON.stringify({"demoMode": true})` (pattern at `:560-562`; DM-11 single-key payload); assert `.conn-mode` "Demo Engine", `/changes` shows `.timeline-row` ≥ 1 with `.panel-hint` "Sample data", `.filter-chip` count 4, and no "Not collected" inside `.panel-change-timeline`. The **default mock-stack legs** (existing `coreRoutes` a11y scans) keep passing unchanged and prove the mock arm still shows samples (§1.5.1). |
| **V6** | **Regression hygiene** | `npm run check` green (`check:js` = **audit + typecheck + build + test:js** — there is no lint step; plus `check:rust`, untouched); `npm run test:e2e` for the modified specs; `updates-surface`/`updates-wiring`/`copilot`/`evidence`/`evidence-render` suites green **and unweakened** (diff-read them, G-08); reviewer greps at final HEAD: `STUB_CHANGES_NOTICE` → 0 hits; `estimated` → hits only in the `ResourceSample` lines (`stubs.ts:27,44`) and #73-owned code; `"Sample timeline"`, `"will appear here"`, `"No change recorded"` → 0 hits; `"Sample data"`/`"Not collected"` string literals outside `evidence.ts` → 0 hits (R1); `changeFeed(`/`causalChain(` with a literal mode argument outside `*.test.*` → 0 hits (R10). |

**Not run by this slice:** `npm run test:live-docker` — no daemon/API/contract change, so the DM-03 release gate does not apply (state this in the PR body rather than leaving it unexplained).

---

## 9. Review round and remediation outcome (2026-08-25)

Eight hostile review angles produced 34 raw findings, converged to 19 unique findings (`/tmp/dm74-convergence.md`): P0=0, P1=3, P2=2, P3=14. The provenance P1 required frontier arbitration because it crossed the original hook-layer scope guard. Sol selected **Option A**; options B (clear model on flip) and C (derive authority from provenance) were rejected as documented above.

| Resolution | Commit / disposition |
|---|---|
| Option-A provenance stamped alongside the resource/model pair; positive allow-list; model-fixed mismatch matrix and G-36 transitions | `3107783` — `web: bind sample history to model provenance (#74)` |
| Canonical true-empty copy, truthful filtered-empty copy, shared label derivation, readable Home/Changes JSX, exhaustive-switch rationale | `2f83001` — `web: reconcile change-history empty states and readability (#74)` |
| Clock spy cleanup, hard-coded V3 matrix, vacuity removal | included in `3107783` |
| Claim singleton mutation risk | localized `Object.freeze` on the two history claim exports (cleanup commit) |
| V4 finite-stream hygiene | representative health `message` added and route explicitly removed after assertions (cleanup commit) |
| Screenshot pixels still contain the old sample notice | accepted deferral to #76 per R7; PR body records the debt |
| Demo feed may re-roll across successful generations; future host collector needs a new observed arm | accepted design notes (R4/Q1), not defects in #74 |
| Duplicate Not-collected title+hint and authority trust roots | accepted; #67/rest-of-epic ownership unchanged |

V1 deliberately uses `sampleSnapshot` for both sample arms because it deterministically emits feed and causal rows; this is stronger than the earlier seed-dependent fixture proposal. V6 grep scope is `apps/` + `tests/`; historical planning documents and deliberate G-37 probe text are not runtime residuals.

---

*Status: IMPLEMENTED + REMEDIATED — all ten questions, seven dissent items, and the post-review arbitration are resolved. Remaining accepted follow-ups are recorded above; anything further under-specified requires another same-PR amendment, not implementer judgment.*
