# Architecture — #72 Remove synthetic update-available claims from live mode

**Issue:** #72 (child of epic #61 "Make live-state claims evidence-backed"), one slice per PR.
**Branch:** `codex/update-claims-issue-72` (from clean `main` @ `1a08498`).
**Author:** Architect pass 1. **Status:** BINDING on the implementer. Deviating from a decision in
§2/§4/§6/§7 without a written amendment in this file is a P1 finding.
**Inputs:** issue #72 body (read from GitHub), the 6-explorer synthesis, `docs/planning/architect-evidence-vocab-71.md`
(#71, merged), `register-generic.md` + `register-dockermap.md`.

**Scope guard.** Web-only. **ZERO** changes to `packages/contracts`, `crates/`, `apps/api`. No new
endpoints, no registry/advisory lookups, no network calls of any kind — the runtime stays
network-quiet (issue non-goal). No styling redesign; the one primitive change (§2 Q3) is a
class hook, not a visual change.

---

## 1. Verified current state (every line read at branch HEAD, working tree clean)

### 1.1 The synthetic source

| Site | Content | Note |
|---|---|---|
| `apps/web/src/lib/model.ts:94-95` | `/** True when an update is available (stub-derived; see lib/stubs). */` + `updateAvailable: boolean;` on `Service` | The doc-comment is itself **false**: the value is not stub-derived, it is hash-derived in `buildModel`. Doc drift already shipped (G-23). |
| `apps/web/src/lib/model.ts:179` | `updatesAvailable: number;` on `SystemSummary` | |
| `apps/web/src/lib/model.ts:241-249` | `hashString(value: string): number` — FNV-1a → `[0,1)`; comment "used by stub generators so derived data never flickers" | **Stays.** Also used by `layout.ts:34` and `stubs.ts:30,32,35,42,90`. Only the `+ "update"` call site dies in #72. |
| `apps/web/src/lib/model.ts:251` | `export function buildModel(snapshot: DockerSnapshot, runtimeMap: RuntimeMap): SystemModel` | **No mode parameter.** Confirmed. |
| `apps/web/src/lib/model.ts:321` | `const updateAvailable = hashString(c.id + "update") > 0.74;` | The single live-assert vector. Deterministic per container id → a fixed live host always reports the same ~26% of its containers as "update available", which reads as stable host truth. |
| `apps/web/src/lib/model.ts:347` | `updateAvailable` assigned onto every `Service` | |
| `apps/web/src/lib/model.ts:550-568` | `summarize()`; `:560` `updatesAvailable: 0` zero-init; `:565` `if (service.updateAvailable) summary.updatesAvailable += 1;` | |

### 1.2 Consumers (complete — repo-wide grep over `apps/`, `packages/`, `tests/`, `dist/` excluded as build artifact)

| Site | Content |
|---|---|
| `apps/web/src/screens/Home.tsx:21` | `const updates = model.services.filter((s) => s.updateAvailable);` |
| `apps/web/src/screens/Home.tsx:45` | `<Metric label="Updates" value={summary.updatesAvailable} />` — **bare integer**, no qualifier |
| `apps/web/src/screens/Home.tsx:142-158` | `{updates.length > 0 && (<Panel title="Updates available" icon="up" hint={`${updates.length}`}> … )}` — lists each flagged service with `StateDot`, name link, and `imageRepo:imageTag` tag |
| `apps/web/src/screens/ServiceDetail.tsx:99-102` | impact-band cell: `<strong>{service.updateAvailable ? "Yes" : "No"}</strong><span>update available</span>` |
| `apps/web/src/lib/stubs.ts:64` | `kind: "deploy" \| "image_update" \| "restart" \| "config" \| "failure" \| "recovery";` |
| `apps/web/src/lib/stubs.ts:75-78` | `image_update` template — summary `"<name> image updated"`, detail `"<repo>:<tag> pulled and redeployed"` |
| `apps/web/src/lib/stubs.ts:90` | `const seed = hashString(service.id + "change");` |
| `apps/web/src/lib/stubs.ts:94-96` | `if (service.updateAvailable) { events.push(makeEvent(service, "image_update", …)); }` — **the only generator of `image_update` events** |
| `apps/web/src/lib/stubs.ts:97-101` | `failure` (real state) / `restart` (`seed > 0.6`, invented) arms — **out of scope, see §2 Q8 boundary note** |
| `apps/web/src/lib/copilot.ts:167-177` | `changeAnswer(model, q)`; `:168` `filter((s) => s.updateAvailable)`; `:171` `"N service(s) have an update available:"`; `:172` per-service bullets; `:174` `"No pending updates detected."`; `:176` `references: updates.map(…)` |
| `apps/web/src/lib/copilot.ts:53-55` | dispatch `if (/chang\|recent\|deploy\|updat/.test(lower)) return changeAnswer(model, q);` |
| `apps/web/src/screens/Changes.tsx:11` | `{ id: "image_update", label: "Updates" }` filter chip in `KINDS` |
| `apps/web/src/screens/Changes.tsx:22` | `events.filter((e) => e.kind === kind)` |
| `apps/web/src/screens/Changes.tsx:70-85` | `iconForKind` — `case "image_update": return "up";` at `:72-73` |

### 1.3 Tests that codify the claim

| Site | Content |
|---|---|
| `apps/web/src/lib/model.test.ts:254-256` | `// updateAvailable is hash-derived per container; assert the range, not exact counts.` + two range asserts on `summary.updatesAvailable` — a **vacuous** pair (`0 ≤ x ≤ total` holds for any implementation) that also codifies the synthetic behavior post-merge |
| `tests/e2e/a11y.spec.ts:500-502` | Comment only: `// … (the hash-based "Updates available" panel may also list one of them, so scope to this list).` The assertion at `:503-504` scopes to `.svc-list` **first** (the attention list) and is unaffected by the panel's removal — but the comment becomes false. |
| `apps/web/src/screens/change-feed-identity.test.tsx:64-74` | `contextFor()` builds an `AppContextValue` with `evidenceMode: "live"` and renders `Home` + `Changes`; asserts identity/route behavior only, never update claims |
| `apps/web/src/screens/change-feed-identity.test.tsx:109-110` | `const apiEvent = changeFeed(model).find(e => e.serviceId === "c_api"); if (apiEvent) expect(apiEvent.routeName).toBe("api");` — conditional (already G-15-soft); stays green either way |

### 1.4 #71 machinery available (shipped, verified)

- `apps/web/src/lib/evidence.ts:5` `EvidenceKind`; `:26` `unavailable: { label: "Not collected", description: "DockerMap does not collect this yet" }`;
  `:30-39` `evidenceLabel()` (fail-closed via `Object.hasOwn`); `:42` `EvidenceMode`; `:58-66` `resolveEvidenceMode`;
  `:72-76` `claimAuthority` (live→`host`, demo|mock→`sample`, null→`none`); `:79-81` `Claim<T>` with the
  `unavailable` arm `{ value: null; detail: string }`; `:83-88` `nonEmptyDetail` throws on empty; `:90-109` constructors.
- `apps/web/src/context.tsx:12` `evidenceMode: EvidenceMode | null` on `AppContextValue`; `useApp()` at `:18-22`.
- `apps/web/src/components/AppShell.tsx:20-31` `modeLabel()` → `"Demo" | "Docker" | "Mock" | "Unknown"`;
  `:161-164` resolves `evidenceMode` on **every** render (never memoized); `:177-185` feeds it into `AppContext`;
  `:225` renders `{modeLabel(evidenceMode)} Engine` in `.conn-mode`.
- `apps/web/src/hooks/useSystemModel.ts:23-30` generation-guarded `useMemo` around `buildModel`; retains `lastModel.current`
  on a mismatched snapshot/runtime pair.
- `apps/web/src/utils/api.ts:29-32` `fetchJson` → `if (isDemoMode()) return getDemoResponse<T>(path);` — the single demo boundary
  for snapshot, runtime map, and health.
- `apps/web/src/components/primitives.tsx:63` `{hint && <span className="panel-hint">{hint}</span>}` — the G-19 falsy-suppression site.
  `:82-90` `Metric({ label, value, sub })` renders `<div className="metric">` with **no** `className` prop today.
- Test harnesses that exist and are reusable: `AppShell.test.tsx:1-133` (jsdom + `createRoot` + `vi.mock` on
  `useSettings`/`useDaemonHeartbeat`/`useSystemModel`/`useApiResource`, `rerenderAppShell()` for mode flips),
  `evidence-render.test.tsx:6-11` (`visibleText()` markup-stripping helper), `change-feed-identity.test.tsx:76-86`
  (`renderToStaticMarkup` + `AppContext.Provider` + `MemoryRouter`).
- Routing: `App.tsx:24-30` `Landing` renders `<Home/>` at the index route inside `AppShell`'s `<Outlet/>` (`AppShell.tsx:257`).

### 1.5 Contract surface (decisive for scope)

`packages/contracts/src/index.ts:63-69` — `DockerSnapshot` = containers/images/networks/volumes/lastUpdated. **No update field.**
The only update-shaped member in the whole contract is `RuntimePackageEntity.update: RuntimePackageUpdate | null`
(`:305-310`, `:317-319`), carrying an explicit `/** Reserved — not emitted by current collectors. */` comment and belonging to the
package-provider kind; it is never read in `apps/web`. **Removing `Service.updateAvailable` touches no public contract.**
The claim is 100% web-fabricated, so #72 is entirely web-local (confirms explorer L3).

---

## 2. Decisions (Q1-Q10) — with the dissent items quoted and ruled on

### Q1 — Field fate: **REMOVE `Service.updateAvailable` and `SystemSummary.updatesAvailable` entirely.**

> **Dissent (b), L2:** "Should `updateAvailable` become `Claim<boolean>` everywhere, or just live-gated at render time?"
> **Dissent (b), L4:** "Should `buildModel` accept an `EvidenceMode` param to gate synthetic derivation (cleanest boundary) or should
> `Service.updateAvailable` become `Claim<boolean>` with `unavailable("Registry/advisory lookups not yet wired")` in live mode?"
> **Dissent (b), L6 S1:** "(a) delete line+type+count: cheapest, no `buildModel` signature change (Q7 param becomes unnecessary)";
> L6 risk: "Over-engineering trap: D10/Q7/G-26 presume the mode param; removal obviates it — resist the architecture's momentum."

**Decision: delete the field, the summary counter, and the hash line.** L6 S1 is upheld; the `Claim<boolean>`-in-model variant is
rejected. Rationale:

1. **A `Claim<boolean>` needs a value in some mode. There is none in any mode.** There is no update-evidence source in live
   (no registry lookups — issue non-goal), none in mock (the mock server emits the same `DockerSnapshot`, contract has no update
   field), and none in demo (`demoData.ts` invents containers, not update state). A per-mode claim whose `value` is *never*
   populated is a `Claim<never>` wearing a boolean's clothes.
2. **AC1 is discharged at its strongest form.** The issue's AC1 is "source line gone **or** provably live-gated". Removal takes the
   first branch, which is a total property over all inputs and all modes; live-gating is a conditional property that a future
   refactor can silently break.
3. **It deletes an entire failure class rather than defending against it.** Keeping a mode-gated model field requires threading the
   mode into `buildModel` inside the generation-checked memo (`useSystemModel.ts:24-30`); getting that wrong is the P1-1 class that
   already bit #71 (stale demo data rendering under live authority). A model that has no update field cannot leak an update claim
   across a mode flip — by construction, not by discipline.
4. **The compiler becomes the completeness proof (DM-08).** Removing the field breaks all 5 consumers at compile time
   (`Home.tsx:21`, `ServiceDetail.tsx:100`, `stubs.ts:94`, `copilot.ts:168`, `model.test.ts:255`). There is no "missed consumer" mode.

**Explicit override of a binding #71 row.** `architect-evidence-vocab-71.md:271-272` (D10) assigns `model.ts:321` → live
`unavailable` / demo+mock `demo`. **This document supersedes those two rows for #72.** Source removal satisfies the rows' intent
("this site must never assert an update in live") strictly more strongly than tagging would, and the `demo` half is separately
rejected in Q5. The divergence is a doc-drift obligation, not a licence: see §6 step 6 (PR body) and V11 (#77 reconciles).
D10's `Home.tsx:45` and `ServiceDetail.tsx:100` rows are **honored, not overridden** (Q3, Q4).

### Q2 — Mode plumbing: **`buildModel` gains NO parameter. `useSystemModel` is not touched.**

> **Handoff §1:** "Q7/G-26 bind #72 to threading mode into `buildModel`'s generation-checked memo."
> **#71 doc `:253`:** "`buildModel`'s signature is **not** changed in this slice. #72 is the first consumer that needs the mode inside
> the model layer and owns that parameter change."

**Decision: no mode parameter, no new memo dependency, zero diff in `apps/web/src/hooks/useSystemModel.ts`.** #71 correctly reserved
the parameter *for whichever slice first needs mode inside the model layer*. After Q1, #72 does not need it: the model layer no
longer produces a mode-dependent value. Adding an unused `EvidenceMode` argument would ship widened, untested surface area — the
exact thing #71 declined to do — and would create the mismatch hazard it was meant to manage. Q7/G-26's arrest is satisfied
**vacuously and permanently**: there is no derived input to pin because there is no derivation.

If a later slice (#73 resources) does need mode inside `buildModel`, it owns the parameter and the memo change, and the discipline
in `architect-evidence-vocab-71.md:358` (capture it in the *same* generation-checked memo at `useSystemModel.ts:24-30`) applies then.
**#72 must not pre-build it.**

### Q3 — Home surface: **KEEP the "Updates" `Metric`, rendering the `unavailable` claim. REMOVE the "Updates available" panel.**

> **Dissent (a), L1 (D10, binding):** "Home:45/143 → live `unavailable` with 'Not collected' label, **not** `0`"; invariant I3:
> "live surfaces become `unavailable` claims (kind+label+non-empty detail), **never** `0`/`No`/absent".
> **Dissent (a), L2:** "Should live mode render `unavailable` or simply omit the Updates metric/panel?"
> **Dissent (a), L6 S2:** "(a) remove both: smallest, avoids G-19 '0 reads as no updates' trap entirely; (b) unavailable `Metric`
> (value null→'Not collected', drop panel): keeps a slot for #70 but adds fixture+detail handling".

**Decision: L6 S2(b), which is also D10's `Home.tsx:45` row.** Split verdict on the two surfaces, because they make different claims:

- **`Home.tsx:45` Metric — keep, re-render as the claim.** A user who has seen "Updates 3" and now sees nothing will infer "fixed" or
  "none". A persistent tile reading **`Updates` / `Not collected` / `<detail>`** actively teaches the true state of the product: DockerMap
  does not check for updates. It also holds the slot #70 will fill. G-19 is satisfied by construction — the rendered value is a
  non-empty string constant, never `0`, never blank, and the `sub` line carries the reason.
- **`Home.tsx:142-158` Panel — remove entirely.** The panel does not make a *count* claim, it makes a **per-service** claim ("these
  named services have updates"). There is no evidence source for a per-service update claim in any mode, so there is nothing to
  re-render truthfully; a panel titled "Updates available" containing a not-collected notice is a worse artifact than no panel,
  because the title itself is the assertion. Its informational content is fully carried by the Metric. Note L1's invariant I3
  ("never absent") is written about *claims*; after removal there is no claim at this location, and the surface-level obligation is
  discharged by the Metric one section above it in the same screen.

**Rendered shape (binding):**

```tsx
<Metric
  className="metric-updates"
  label="Updates"
  value={UPDATE_STATUS_LABEL}      // "Not collected"
  sub={UPDATE_STATUS_CLAIM.detail} // the Q6 string
/>
```

**Primitive change (required, minimal):** `primitives.tsx:82-90` `Metric` gains an optional `className?: string`, rendered as
``className={className ? `metric ${className}` : "metric"}``. Reason: DM-02(c) — every control/assertion target the e2e touches needs
its own class or Playwright strict mode breaks on the shared `.metric`. No visual change (no CSS rule is added for `.metric-updates`).

### Q4 — ServiceDetail cell: **KEEP the cell, render the claim label; retitle the sub-label.**

> **Q4 (handoff §5):** "remove the 2-line cell, or `unavailable` claim keyed on `AppContext.evidenceMode` (render concern, no model
> plumbing)?" **#71 D10 `:274`:** "`ServiceDetail.tsx:100` update cell | live | `unavailable` — replaces the flat `"No"`, which today
> asserts 'no update exists'". **#71 `:338`:** `ServiceDetail.tsx:100`'s flat `"No"` and `Home.tsx:45`'s bare integer are "the two
> clearest current violations".

**Decision: D10's row is honored.** `ServiceDetail.tsx:99-102` becomes:

```tsx
<div className="impact-cell impact-cell-updates">
  <strong>{UPDATE_STATUS_LABEL}</strong>
  <span>update status</span>
</div>
```

Two sub-decisions: (i) the sub-label **must** change from `"update available"` to `"update status"` — `Not collected` under
`update available` still reads as a claim about availability (DM-06); `update status` is a topic, not an assertion. (ii) The cell
renders the **label only**, not the detail: the impact band is a fixed 4-cell numeric strip with no sub-slot, and putting the detail in
a `title` attribute is forbidden (`architect-evidence-vocab-71.md:378` — "an evidence label placed only in a `title` attribute is not
an accessible name", G-22). Both surfaces read the **same exported constant**, so the visible values cannot drift (G-19's
"list AND detail must agree", DM-05's "ONE derived display value"); the fuller reason lives on Home's metric `sub`, and this is asserted
by the surface tests in §7 V3/V10. **No `evidenceMode` read is required** — see Q6 for why this claim is mode-independent.

### Q5 — Demo/mock sample: **NO sample. All three modes render the same "Not collected" claim.**

> **Issue #72 scope:** "Demo mode **may** keep a sample, explicitly tagged as demo."
> **Dissent (c), L1 U3:** "demo/mock keeps hash sample (kind `demo`) or also 'Not collected' until #75?"
> **Dissent (c), L3:** "Should `image_update` events survive as demo-kind samples, or does the whole kind die in live mode (affects
> Changes.tsx filter tab UI)?"
> **Dissent (c), L6:** "demo loses the fake sample, which AC permits: 'may keep'… defer unless demo richness is a product requirement
> (#76 sweep can restore it tagged `demo`)."

**Decision: L6 upheld — no demo sample in #72.** "May" is permission, not obligation, and keeping one costs more than it buys:

1. A demo sample requires the field to survive on `Service` (or a parallel demo-only field), which re-opens every hazard Q1 closes —
   most importantly the demo→live window where a demo-built model renders under live authority (#71 P1-1 class).
2. Demo mode is a **product tour**, and the honest tour of this feature is "DockerMap does not check for updates yet". A tagged
   sample would advertise a capability that does not exist in the product at all — arguably a *worse* overclaim than the one being
   removed, since demo is what a prospective user sees first.
3. Nothing is foreclosed: when #70 ships a real update collector, demo can gain a real `demoSample()` claim with real semantics. #76
   may restore a tagged sample if product wants one; this decision does not bind #76.

**Consequence (state it plainly):** demo mode loses the "Updates available" panel and its `image_update` timeline entries. That is
accepted, deliberate product scope reduction, and it must be listed in the PR body.

### Q6 — P2-2 detail string: **`"Update checks not wired — DockerMap does not query registries"`**, rendered in every authority state.

> **Dissent (d), L1 U4:** "exact `unavailable` detail string for updates (non-empty, DM-06 wording)."
> **Dissent (d), L6:** "S3 claim's P2-2 detail string during null-authority window — pick reason ('Docker daemon unreachable')."
> **Dissent (d), L4 (variant):** `unavailable("Registry/advisory lookups not yet wired")`.
> **#71 P2-2 (`:112`, binding):** "during the null-authority window … a site renders the `unavailable` claim's **`detail`** …, NOT the
> static `description`… The description is reserved for **permanent non-collection** (no collector exists for the surface); the detail
> is for **temporary authority absence** (a collector exists, but no snapshot has arrived)."

**Decision.** Exact string, exported once:

```
Update checks not wired — DockerMap does not query registries
```

Wording rationale (DM-06): it states what is missing (the check), and *why it will stay missing* (the product does not query
registries — the network-quiet invariant, DM-01), without claiming anything about whether updates exist. It matches the house voice at
`stubs.ts:16-17` (`"Estimated — live resource collectors not yet wired"`, `"Sample timeline — change collectors not yet wired"`).
L4's variant is close but leans on "advisory", which drags in the security-advisory feature that is an explicit non-goal.

**P2-2 ruling — this surface is PERMANENT non-collection, not temporary authority absence.** L6's suggested `"Docker daemon
unreachable"` is **rejected**: the daemon's reachability has nothing to do with why update status is missing, so it would be a false
reason. Because no collector exists in any mode, the claim is **authority-independent**: the same `detail` renders under
`claimAuthority` `"host"`, `"sample"`, and `"none"` alike. This complies with P2-2 *a fortiori* — the rule forbids falling back to the
static description during the null window, and this design never renders the description at all. The implementer must **not** add an
`evidenceMode` branch to these two claim sites; a branch would imply the answer varies by mode, which is itself an overclaim.

### Q7 — Copilot slice boundary: **fixed in #72, minimally. Both branches of the updates block die.**

> **Dissent (e), L1 U2:** "`copilot.ts:168-176` is D10-assigned to #75, but field removal force-touches it in #72 — slice boundary?"
> **Dissent (e), L3 risk:** "`copilot.ts` 'No pending updates detected.' becomes a lie-by-omission if only the positive branch is removed."

**Decision: #72 owns it — there is no choice, and leaving half of it would be worse than touching all of it.** `copilot.ts:168` does not
compile after Q1, so the file is in #72's blast radius regardless. Deleting only the positive branch would leave
`"No pending updates detected."` as the unconditional answer — an *asserted negative* with zero evidence, i.e. the same lie inverted.
Binding replacement:

```ts
function changeAnswer(q: string): CopilotAnswer {
  return {
    question: q,
    headline: "Recent and pending change",
    body: [`Update status: ${UPDATE_STATUS_LABEL} — ${UPDATE_STATUS_DETAIL}.`],
    references: []
  };
}
```

- The `model` parameter is dropped (it becomes unused); update the call site at `copilot.ts:54` to `changeAnswer(q)`.
- `references` becomes `[]` — the old value enumerated hash-flagged services as the answer's evidence.
- **#72 does NOT make `changeAnswer` enumerate the change feed.** That answer belongs to #74 (history), and wiring the feed in here
  would pull `stubs.ts`'s invented restarts into Copilot answers — trading one synthetic claim for another. The resulting answer is
  deliberately thin; #74 fills it. Note this in the PR body as a known, accepted gap.
- **#75 (Copilot) is not pre-empted:** #72 touches *only* `changeAnswer`. `unhealthyAnswer`, `dependentsAnswer`, `whyOfflineAnswer`,
  `portAnswer`, `serviceOverviewAnswer`, and `suggestions()` are untouched and remain #75's scope.

### Q8 — Changes feed/tab: **the `image_update` kind dies completely in #72 (arm, union member, template, icon case, filter chip).**

> **Dissent (e), L1 U5:** "image_update arm of changeFeed — #72 or #74?"
> **Dissent (e), L3:** "G-23 assigns feed-notice cleanup to #74, but this gate is #72's blast radius"; "stubs.ts:94 is the ONLY generator
> of `image_update` feed events; removing the field empties the Changes 'Updates' filter and the feed's update entries."

**Decision: #72, in full.** Five coupled edits, all forced by Q1:

1. `stubs.ts:94-96` — delete the `if (service.updateAvailable)` arm.
2. `stubs.ts:64` — remove `"image_update"` from `ChangeEvent["kind"]`. **Required, not optional:** an unreachable kind left in the
   union is a loaded gun for #74 (it looks like a supported event type with a ready-made template) and it keeps `updat`-shaped strings
   alive in the grep surface (V1/V8).
3. `stubs.ts:75-78` — delete the `image_update` template. Its detail string `"<repo>:<tag> pulled and redeployed"` is the most
   explicit fabricated operational claim in the file.
4. `Changes.tsx:11` — delete the `{ id: "image_update", label: "Updates" }` chip. **A chip that filters to a permanently empty list is
   the R3 trap in filter form:** selecting "Updates" would render `EmptyState "No change recorded"`, which a user reads as "no updates
   exist" — precisely the assertion #72 removes. (The `kind` state at `Changes.tsx:19` starts at `"all"` and can only be set by a chip,
   so removing the chip cannot strand the filter in an unreachable state.)
5. `Changes.tsx:72-73` — delete `case "image_update": return "up";` (the union removal makes it a type error; `default:` covers the rest).

**Slice boundary with #74 (explicit, binding):** #72 does **not** touch `STUB_CHANGES_NOTICE` (`stubs.ts:17`), the `failure`/`restart`
arms (`stubs.ts:97-101`), `causalChain`, or the feed's provenance tagging. Those remain #74's.

**Stated concern, then proceeding (issue AC1 reads broader than the slice).** AC1's literal wording — "No random/hash-generated
operational claim exists in live mode" — would also cover `stubs.ts:99-101`'s `seed > 0.6` invented **restart** events and
`resourceFor`'s hash-derived CPU/memory (`stubs.ts:29-46`). Those are hash-generated operational claims that will still exist in live
mode after this PR. They are **out of #72's scope** per the issue's own Goal sentence ("Stop hash-derived `updateAvailable` … from
appearing as live truth"), per epic #61's one-slice-per-PR rule, and per D10, which assigns resources to #73 and history to #74.
**#72's completeness claim is scoped to update claims and must be stated that way in the PR body and in the Resolution Evidence
comment** — do not claim "no synthetic claims remain in live mode".

### Q9 — Mock mode + test fixtures: **no mode-specific behavior exists to decide; fixtures need no mode changes.**

**Decision.** With the field gone, mock mode has no update claim to keep or replace — the hash *function* survives untouched for
`layout.ts` and `resourceFor` (both out of scope), and only the `hashString(c.id + "update")` call site dies. Fixture rulings:

- `change-feed-identity.test.tsx:64-74` — **no change required.** Its `evidenceMode: "live"` fixture asserts identity/routing on
  `failure` events, which survive. Its `:109-110` conditional (`if (apiEvent)`) is soft but pre-existing; #72 must **not** silently
  weaken or strengthen it. (Flagged for #76's sweep.)
- `model.test.ts:254-256` — **delete all three lines** including the comment (the asserts are vacuous *and* codify the removed
  behavior). The surrounding `summarize` test keeps its real state-count assertions, so the file still locks correct behavior (G-15).
- New fixtures are additive only, and every rendering fixture ships as a **demo/live pair** (G-15/V10) — see §7.

### Q10 — What AC3's "live API path" test actually proves.

> **Handoff Q10:** "what exactly does AC3's focused test cover, given `api.ts:30` short-circuits demo before any fetch?"

**Decision — AC3 is discharged by a three-leg proof, and the reasoning is binding on the test author.** The premise behind the
question ("exercise a live fetch") is not the strongest available proof and is not reachable in unit scope: `api.ts:29-32` means demo
mode never fetches, so a "live fetch" test would differ from the demo test only in *which bytes arrive*. After Q1 the model is
**mode-blind and update-free**, so the property "no synthetic update claim can reach any surface" is **total over all inputs** —
strictly stronger than exercising one transport path. The three legs:

- **L1 — Source (runtime, total).** For a live-shaped snapshot *and* for demo-derived containers, no `Service` object and no
  `SystemSummary` object has any own key matching `/update/i`, and no `changeFeed` event's `summary`/`detail` matches `/updat/i`.
  Key-scanning (not property access) is used deliberately: it keeps failing if someone re-adds the field under a different name.
- **L2 — Type boundary (compile-time).** A `@ts-expect-error` gate asserting `Service` has no `updateAvailable` and `SystemSummary` has
  no `updatesAvailable`, plus the standing fact that `DockerSnapshot` (`contracts:63-69`) carries no update field — so nothing can
  re-enter through the contract or the model type without a deliberate, visible change. (This mirrors #71's test 9 technique.)
- **L3 — Render + transport (e2e, real fetch).** The Playwright run uses the **mock server** — a real `fetch` through
  `api.ts`'s non-demo path — and asserts the Home Updates metric reads "Not collected" and no "Updates available" panel exists. Mock
  mode is not demo mode; this leg is the genuine "API path" evidence.

---

## 3. Risks and mitigations

### 3.1 The five naive-fix failure modes (from L5, verbatim) — each eliminated, not merely defended

| # | Failure mode (verbatim) | Why this design eliminates it | Verification |
|---|---|---|---|
| 1 | "`undefined` consumers — remove `updateAvailable` but leave `Home.tsx`, `ServiceDetail.tsx`, `stubs.ts`, or `copilot.ts` reading it" | Type removal (Q1) makes all 5 read sites **compile errors**; `npm run typecheck` cannot pass with a survivor. | V1, V8, `npm run check` |
| 2 | "stale Home counts — `summary.updatesAvailable` becomes `0`, metric renders `0` instead of an explicit unavailable state (G-19 …)" | The counter is **deleted**, so no number exists to render. The Metric renders a non-empty string constant. | V3, V10 |
| 3 | "copilot answering from stubs in live — `changeAnswer` continues enumerating `updateAvailable` services in live mode" | Both branches deleted (Q7); `changeAnswer` no longer takes the model. | V7, new `copilot.test.ts` |
| 4 | "missed gating paths — `changeFeed` still emits `image_update` in live; ServiceDetail still flat Yes/No" | The kind is removed from the union (Q8) so no `makeEvent` call can produce it; the ServiceDetail cell is rewritten (Q4). | V1, V3, V7 |
| 5 | "**P1-1-class mode mismatch** — `buildModel` receives `evidenceMode` but `useSystemModel.ts` does not thread it inside the generation-checked memo" | **Cannot occur:** `buildModel` receives no mode (Q2) and produces no mode-dependent value. `useSystemModel.ts` has a zero-line diff. | V6 wiring test (stale-demo-model-under-live-authority render) |

### 3.2 Further risks

| Risk | Mitigation |
|---|---|
| **Re-overclaim by inversion** (L1 R1): a live-gated `Claim<boolean>` with `value:false` would read as "no updates". | Structurally impossible after Q1 — there is no boolean anywhere in the path. |
| **"Not collected" mistaken for an error state** by users. | The `sub` detail (Q6) names the cause and the product policy; the ServiceDetail sub-label is a topic (`update status`), not an error. |
| **Unused-import breakage** — removing Home's panel orphans `StateDot` (`Home.tsx:9`, used only at `:147`) and `UNAVAILABLE_IMAGE` (`Home.tsx:6`, used only at `:152`); removing the stubs template orphans `UNAVAILABLE_IMAGE` in `stubs.ts:2` (used only at `:77`). | Named explicitly in §6 step 2. `Tag` (`Home.tsx:111`), `identityText`/`UNAVAILABLE_SERVICE` (`Home.tsx:173`), and `identityText`/`UNAVAILABLE_SERVICE` in `stubs.ts` all stay. `npm run typecheck` catches misses. |
| **Merge-order collision** with #74/#75 on `stubs.ts`/`copilot.ts` (L6). | Removal-first shrinks both siblings. #72 touches only the `image_update` template/arm/kind in `stubs.ts` and only `changeAnswer` in `copilot.ts` — boundaries stated in Q7/Q8 so the sibling diffs do not overlap. |
| **Doc drift** (G-23): D10 rows `:271-272` are superseded; `a11y.spec.ts:500-502`'s comment describes a panel that no longer exists; `model.ts:94`'s "stub-derived" comment disappears with the field. | The a11y comment is fixed **in this PR** (§6 step 4). The #71 doc is **not** edited (it is the historical record of a merged slice); the divergence is recorded in the PR body and handed to #77 (V11). |
| **e2e strict-mode collision** on the shared `.metric`/`.impact-cell` classes (DM-02c). | `metric-updates` and `impact-cell-updates` classes added (Q3, Q4). |
| **No existing copilot tests** (L5) → high regression risk on a file being edited. | A new `copilot.test.ts` ships in the same PR, covering `changeAnswer` **and** one untouched answer path (G-15 resumption). |
| **Scope creep into #73/#74** via "while I'm here" cleanup of `resourceFor`/restart events. | Q8's boundary note is binding; §6's checklist enumerates the exact files and hunks. |
| **Over-claiming completeness in the closure evidence.** | Q8 requires the Resolution Evidence comment to scope its claim to update claims and to name the surviving synthetic surfaces with their assigned slices. Never self-close (DM-01, AGENTS.md). |

---

## 4. Resolved product questions (nothing left to implementer judgment — G-14)

1. **Does live mode ever assert update availability?** No. Neither positively nor negatively, on any surface.
2. **Does the Home "Updates" tile stay?** Yes — as `Updates / Not collected / Update checks not wired — DockerMap does not query registries`.
3. **Does the Home "Updates available" panel stay?** No. Deleted in all modes.
4. **Does the ServiceDetail impact cell stay?** Yes — `Not collected` over the sub-label `update status` (was `Yes`/`No` over `update available`).
5. **Does demo mode keep a sample?** No. Demo shows the same "Not collected" claim. Accepted, deliberate scope reduction; #70/#76 may revisit.
6. **Does mock mode differ from live here?** No. The claim is identical in live, mock, and demo — and identical before the heartbeat arrives.
7. **What does Copilot answer for "what changed recently"?** `Update status: Not collected — Update checks not wired — DockerMap does not query registries.` with no service references. Thin by design; #74 fills it.
8. **Does the Changes "Updates" filter chip stay?** No. The chip, the event kind, its template, and its icon case are all removed.
9. **Is there any `image_update` event anywhere, in any mode?** No.
10. **Is a registry/advisory lookup added?** No — not now, not behind a flag. The runtime stays network-quiet.
11. **Is any contract/daemon/API file touched?** No. Web-only.
12. **Exact user-visible strings (binding, no paraphrasing):** label `Not collected` (from `evidenceLabel("unavailable")`, never hard-coded at the call site); detail `Update checks not wired — DockerMap does not query registries`; Home metric label `Updates`; ServiceDetail sub-label `update status`.

---

## 5. Arrested lessons (register-generic + register-dockermap)

**G-01 — spec-conformance is not sufficient / schema-escape hatches.** Arrested by deletion: the field being removed is exactly a
"schema-valid but semantically empty" value (a boolean whose true/false both lie). The replacement has **no** value domain to abuse —
`unavailable`'s arm is `{ value: null, detail: string }` and `nonEmptyDetail` (`evidence.ts:83-88`) throws on empty/whitespace, so the
one remaining input (the detail string) fails at construction, never at render.

**G-02 — mock masks reality; verify library claims against installed source.** N/A for library behavior (no new dependency, no
library semantics relied on). The *spirit* is arrested in the test plan: the render fixtures use the **real** `Metric`/`Panel`
primitives (`evidence-render.test.tsx` precedent), not stand-ins, so `primitives.tsx:63`'s falsy-hint suppression is exercised for real;
and V6 renders the real `AppShell` + real `Home`, not `modeLabel` in isolation.

**G-03 — mock-path e2e assertions must use real mock output text.** Arrested. The new e2e assertions match on strings this design
*defines* (`Not collected`, `Updates`) plus the absence of `Updates available`; the implementer must read the rendered mock output
before asserting and must **not** invent search terms (no "running", no log-line assumptions).

**G-04, G-05, G-07, G-10, G-11, G-13, G-16, G-17, G-18** — **N/A**: no balance/tradeoff model, no score distribution, no round-robin
allocation, no selector tags, no RNG seeding, no visual matrix cells, no derived-artifact cache key, no pixel-size rendering gate, and no
acceptance criterion that can be met merely nominally (AC1 is discharged by *absence of a source line*, verified by grep + compile +
runtime key scan, not by inspection).

**G-06 — cohort-scoped numerators AND denominators.** N/A — no rates or per-cohort telemetry. The one count being removed
(`updatesAvailable`) is deleted rather than re-scoped.

**G-08 — fix sweeps introduce regressions; verify prior fixes are CORRECT, not just present.** Arrested with named line targets. Every
file in this diff carries earlier hardening: `Home.tsx:148-150` and `:172-174` (dual `byId`/`byName` link gate), `stubs.ts:93`
(collision-safe `routeName`), `stubs.ts:111` (`identityText` normalization), `model.ts:345` (occurrence-safe `dependsOn`),
`Changes.tsx:49-56` (non-routable timeline rows). The implementer must leave all of them untouched, and the guard suites
(`change-feed-identity`, `collision-identity`, `detail-identity`, `mount-keys`, `duplicate-list-keys`) must stay green **with their
assertions intact** — a fixture weakened to make a suite pass is a P1.

**G-09 — never trust reported numbers.** Arrested procedurally: §7's verification commands must be **re-run** by the reviewer; citing
this document or the PR body is not evidence.

**G-12 — a committed visual baseline is not a gate until proven enforced.** N/A — no visual/screenshot baseline is added or regenerated.

**G-14 — resolve open questions before dispatching the implementer.** Arrested: Q1-Q10 all carry explicit decisions, §4 restates them
as product decisions, and §2 Q6/§4.12 fix the exact strings so no wording is left to judgment. The implementer must **refuse to guess**;
anything genuinely underspecified is an amendment request against this file, not a judgment call.

**G-15 — regression tests can codify the new bug.** Arrested at three points. (a) `model.test.ts:254-256` is *deleted*, not adapted —
it is both vacuous and a codification of the lie. (b) Every new test asserts the **correct behavior that resumes** (the "Not collected"
label and its detail are present, real feed events still render, an untouched Copilot answer path still answers correctly), not merely
that the old symptom is gone. (c) Every render assertion ships as a **demo/live pair** (V10) so "it disappeared in live" cannot pass while
demo silently keeps the lie.

**G-19 — falsy/empty values need explicit fallbacks at EVERY render site.** Arrested, and this is the class the old code failed:
`Home.tsx:45` rendered a bare integer that reads `0` as "no updates". Defences: the count is deleted (no `0` can exist); the rendered
value is a non-empty constant derived from `evidenceLabel`; `Panel.hint`'s falsy-suppression site (`primitives.tsx:63`) is no longer fed
by an update count anywhere; both surfaces read the **same** exported constant so they cannot disagree; and V3 asserts the label in
**visible text** (markup stripped, via the `visibleText()` helper) on both surfaces in both modes.

**G-20 — occurrence-indexed joins.** N/A — no correlation join is added or changed; `model.ts:327-330`'s occurrence discipline is untouched.

**G-21 — collision-proof React keys.** N/A for new code — #72 **removes** a list (`Home.tsx:145`, already `${service.id}-${index}`) and
adds none. Note for the implementer: do not "tidy" the surviving keys.

**G-22 — accessible names entity-qualified and state-synced.** Arrested by prohibition: no interactive control is added, one is removed
(the Changes chip), and the evidence label **must not** be placed in a `title`/`aria-label`-only position — it must be visible text in
both new render sites. V3 asserts on stripped markup precisely so an attribute-only label fails.

**G-23 — docs must not retain superseded rules.** Arrested with a named split: what this PR owns is fixed **in** this PR
(`a11y.spec.ts:500-502`'s comment; `model.ts:94`'s false "stub-derived" comment vanishes with the field). What belongs to the historical
#71 record (D10 rows `:271-272`) is **not** silently edited; the supersession is declared in §2 Q1, restated in the PR body, and handed
to #77 (V11). Reviewers must grep the whole diff for residual "Updates available"/"update available"/"image_update" wording in comments
as well as code.

**G-24 — derived/destructive operations must fail CLOSED when authoritative state is missing.** Arrested and made total: previously the
absence of an update collector failed **open** (a hash invented an answer). Now the missing authority produces `unavailable` — the
fail-closed value — in every mode and in the null-authority window, with no lenient default anywhere on the path.

**G-25 — structural mutations are not idempotent.** N/A — no mutation, no retry, no external write; #72 is a pure read-path removal.

**G-26 — multi-step transactions must pin all derived inputs at start.** Arrested vacuously and permanently: after Q2 there is no
derived mode input to pin inside `useSystemModel.ts:24-30`, because the model produces no mode-dependent value. The #71 discipline at
`architect-evidence-vocab-71.md:358` remains binding on whichever future slice first threads a mode into `buildModel` — **not this one**.

**G-27 — async API contracts.** N/A — no async function is added or changed; `changeAnswer` is synchronous and total.

**G-28 (guard-flag ownership), G-29 (foreground flows await freshness), G-30 (blank env values), G-31 (low-entropy secrets),
G-32 (read paths settle journals), G-33 (write verification enforced), G-34 (retry classification), G-35 (cleanup removes only what it
recreates)** — **N/A**: no shared mutable flag, no freshness promise, no env parsing, no secret comparison, no transaction journal, no
write path, no retry policy. On G-35 specifically: this PR removes surfaces (`Home` panel, Changes chip, `image_update` kind) that
**nothing else recreates**, which is the point — no guard or protection is being removed, only fabricated claims.

**G-36 — new wiring shipped without regression locks survives any number of review passes.** Arrested as a **required commit-level
obligation**: the new user-visible behavior (the Updates metric, the ServiceDetail cell, the Copilot line) ships **with** V6's
wiring-level test in the same PR — the real `AppShell` rendering the real `Home`, asserting `.conn-mode` reads `Docker Engine` while
`.metric-updates` reads `Not collected`. Pure-function unit tests do not discharge this. A review round that finds no wiring test for
these sites must file it as a P2 minimum.

**DM-01 — AGENTS.md invariants are non-negotiable.** Arrested. The invariant this slice satisfies is **network-quiet by default**: no
registry/advisory lookup, no new endpoint, no new fetch call — enforced structurally (the diff adds zero network code; V8 greps for it).
Read-only providers, bounded discovery, redaction, loopback binding are untouched (no daemon/API change). Closure: post a
`## Resolution Evidence` comment and **recommend** closure — never auto-close.

**DM-02 — e2e harness quirks.** Arrested item-by-item in §7: (a) assert on real mock output text (G-03); (b) `domcontentloaded` +
explicit waits, **never** `networkidle` (the SSE heartbeat never settles it); (c) unique classes for every assertion target —
`metric-updates`, `impact-cell-updates` (this is why `Metric` gains `className`); (d) query params handled at the route boundary — N/A,
no new route/param; (e) re-grep route registrations after patches — N/A, no route file patched.

**DM-03 — live-Docker evidence is the release gate.** N/A for this PR: no daemon/API/contract change, so nothing destined for the
release gate. `npm run check` + `npm run test:e2e` are the gates here. If the release manager bundles this into a release, the standard
DM-03 evidence block applies to the release, not to this slice.

**DM-04 — Rust/clippy conventions.** N/A — zero Rust files touched. `npm run check` still runs `check:rust`; if it is run locally, the
fmt-then-clippy order applies unchanged.

**DM-05 — empty schema-valid identities stay VISIBLE but NON-ROUTABLE.** Arrested twice: (a) the design's core mechanism is DM-05's own
arrest applied to a *claim* — ONE derived display value (`UPDATE_STATUS_LABEL`) used at ALL locations, with the "unavailable" fallback
being the only value; (b) the surviving identity handling in the touched files (`identityText`, `UNAVAILABLE_SERVICE`,
`UNAVAILABLE_IMAGE`, the `byId`/`byName` link gates, `routeName: null`) must be preserved exactly — see G-08. **Review every tab**: the
ServiceDetail change is in the always-visible impact band, above the tab strip, so Overview *and* Configuration are both affected.

**DM-06 — labels must not claim more than the snapshot proves.** Arrested as the slice's entire purpose. #71 named
`ServiceDetail.tsx:100`'s flat `"No"` and `Home.tsx:45`'s bare integer as "the two clearest current violations"
(`architect-evidence-vocab-71.md:338`); both are fixed here, plus three the map did not enumerate: Copilot's
`"No pending updates detected."` (an asserted negative), the `image_update` feed entries (`"<repo>:<tag> pulled and redeployed"` —
a fabricated *action*), and the Changes "Updates" filter chip (an implied capability). Every new string in §4.12 was chosen so the data
supports it literally.

**DM-07 — diff-scoped review must trace the MODEL/HOOK layer, and re-certify after the branch moves.** Arrested. The diff is
model-layer-first by design, and the review targets are named: `model.ts:95,179,321,347,560,565`, `useSystemModel.ts:23-30`
(**must be a zero-line diff — verify, do not assume**), `context.tsx:12`, `AppShell.tsx:161-164,177-185`. A no-findings certification is
valid only for the exact HEAD reviewed; any fix round that moves the branch requires re-certification.

**DM-08 — a fix must close EVERY consumer of the invariant.** Arrested by construction (type removal → compile-enforced completeness)
**and** by process: the pass-2 greps from #71 (`updateAvailable|updatesAvailable`, `resourceFor`, `changeFeed`, `causalChain`, `STUB_`,
plus `image_update` and `hashString`) are re-run at final HEAD (V8), and §1.2's consumer table is the checklist. The completeness claim
is scoped per Q8 — update claims only.

**DM-09 — derived UI state must be re-derived or invalidated on live-data refresh.** Arrested by elimination: the claim is a module-level
constant with no dependency on model data, mode, or refresh, so there is no derived state to invalidate. `evidenceMode` continues to be
re-resolved every render at `AppShell.tsx:161-164` (untouched). No `useMemo`/`useState` carries an update claim anywhere after this PR.

**DM-10 — release-artifact CI gap.** N/A — no Dockerfile, build-step, deploy-bundle, or lockfile-layout change. The artifact surface is
unchanged, so the existing CI image job needs no update.

**DM-11 (first entry — settings-parse gates vs harness payloads).** Arrested as a **prohibition**: #72 must not touch
`settingsStore.ts`, `useSettings`, or any parse boundary. The `a11y.spec.ts:512` `defaultRoute` initScript remains a hidden dependency of
that gate; since this PR *does* modify `a11y.spec.ts` (comment + new assertions), the a11y spec must be run before push (V9) and any
timing/focus failure must be attributed by bisect/isolated run — never by the plausible-pattern jump.

**DM-11 (second entry, duplicate id — mode-dependent data held in COMPONENT STATE survives mode flips).** Arrested by construction: the
update claim is held in **no** carrier that can survive a mode flip — not component state, not a ref, not a memo, not the model. V6's
transition test proves it: a model built from demo containers rendered under live authority still shows "Not collected", never a count.
*(Register hygiene note for the maintainer: two distinct entries share the id `DM-11`; both are addressed above.)*

---

## 6. Ordered implementation checklist

Smallest reversible commits; **every commit must leave `npm run check` green**. Do not reorder, do not merge steps 2 and 3.

**Step 1 — the claim constant (additive, green).**
1. Create `apps/web/src/lib/updates.ts`:
   ```ts
   import { evidenceLabel, unavailable } from "./evidence";

   /**
    * DockerMap has no update-evidence source in ANY mode: live never queries a
    * registry (the runtime is network-quiet by design), the mock server emits the
    * same update-free DockerSnapshot, and demo invents containers, not update
    * state. This is PERMANENT non-collection, so the same claim renders under
    * every authority level — including the null-authority heartbeat window
    * (#71 P2-2): the detail below, never the static "does not collect this yet"
    * description, and never a mode branch.
    */
   export const UPDATE_STATUS_DETAIL = "Update checks not wired — DockerMap does not query registries";

   export const UPDATE_STATUS_CLAIM = unavailable(UPDATE_STATUS_DETAIL);

   /** ONE derived display value, used at EVERY update surface (G-19, DM-05). */
   export const UPDATE_STATUS_LABEL = evidenceLabel(UPDATE_STATUS_CLAIM.kind).label; // "Not collected"
   ```
2. `apps/web/src/components/primitives.tsx:82-90` — add `className?: string` to `Metric` and render
   ``className={className ? `metric ${className}` : "metric"}``. No CSS is added.
3. Commit: `web: add the update-status evidence claim constant`.

**Step 2 — remove the synthetic claim and close every consumer (one atomic commit; it cannot be split and stay green).**
1. `model.ts` — delete `:94-95` (doc comment + field), `:179` (`updatesAvailable`), `:321` (hash line), `:347` (assignment),
   `:560` (zero-init), `:565` (increment). **Do not touch `hashString` (`:241-249`)** — `layout.ts:34` and `stubs.ts` still use it.
   **Do not change `buildModel`'s signature (`:251`).**
2. `Home.tsx` — delete `:21` (`updates` const) and `:142-158` (the panel). Replace `:45` with the `Metric` block from §2 Q3.
   Remove the now-unused imports `StateDot` (`:9`) and `UNAVAILABLE_IMAGE` (`:6`); **keep** `Tag`, `identityText`,
   `UNAVAILABLE_SERVICE`. Add `import { UPDATE_STATUS_CLAIM, UPDATE_STATUS_LABEL } from "../lib/updates";`.
3. `ServiceDetail.tsx:99-102` — replace with the impact cell from §2 Q4 (`impact-cell impact-cell-updates`, `UPDATE_STATUS_LABEL`,
   sub-label `update status`).
4. `stubs.ts` — delete the `image_update` arm (`:94-96`), the `image_update` template (`:75-78`), and `"image_update"` from the kind
   union (`:64`). Remove the now-unused `UNAVAILABLE_IMAGE` import (`:2`); **keep** `identityText` and `UNAVAILABLE_SERVICE`.
   **Do not touch** `:17` `STUB_CHANGES_NOTICE`, `:29-46` `resourceFor`, `:97-101` failure/restart arms, or `causalChain`.
5. `Changes.tsx` — delete the `{ id: "image_update", label: "Updates" }` chip (`:11`) and `case "image_update":` (`:72-73`).
6. `copilot.ts` — replace `changeAnswer` (`:167-177`) with the §2 Q7 body, drop its `model` parameter, and update the call site
   (`:54`) to `changeAnswer(q)`. Import the constants from `./updates`. **Touch no other answer function.**
7. `model.test.ts` — delete `:254-256` (comment + both asserts). Leave the rest of the `summarize` test intact.
8. Run `npm run check`. Commit: `web: remove hash-derived update-available claims from every surface (#72)`.

**Step 3 — regression locks (G-36; same PR, separate commit).**
1. Add `apps/web/src/lib/no-synthetic-updates.test.ts` (AC3 legs L1+L2 — §7 V4).
2. Add `apps/web/src/screens/updates-surface.test.tsx` (demo/live render pairs for Home + ServiceDetail — §7 V3/V10).
3. Add `apps/web/src/lib/copilot.test.ts` (`changeAnswer` + one untouched answer path — §7 V7).
4. Add `apps/web/src/screens/updates-wiring.test.tsx` (real `AppShell` + real `Home`, mode-flip — §7 V6).
5. Run `npm run test:web`. Commit: `web: lock the no-synthetic-update invariant across modes`.

**Step 4 — e2e (same PR, separate commit).**
1. `tests/e2e/a11y.spec.ts:500-502` — rewrite the comment: the "Updates available" panel no longer exists, so the `.svc-list` scoping is
   now about the attention list only. Do **not** change the assertion at `:503-504`.
2. Add the Home update-surface assertions (§7 V3/V6-e2e) using `.metric-updates`, `domcontentloaded`, and explicit waits.
3. Run `npm run test:e2e` (at minimum `npm run test:e2e:a11y`, plus `dockermap.spec.ts` if the new assertions land there).
   Commit: `e2e: assert the Updates surface reports not-collected`.

**Step 5 — full gate.** `npm run check` (js + rust) and `npm run test:e2e` from a clean tree. Record versions/output for the PR body.

**Step 6 — PR body (required content).**
- No public-contract change; web-only; no new endpoint; runtime stays network-quiet.
- **Supersession notice (G-23/V11):** `architect-evidence-vocab-71.md:271-272` (D10 `model.ts:321` rows, live `unavailable` /
  demo+mock `demo`) are superseded by §2 Q1 (source removed instead of tagged); `:273-274` (Home/ServiceDetail rows) are honored.
  Hand the doc reconciliation to **#77**.
- **Scope statement (Q8):** update claims only. `resourceFor` (#73) and the `restart`/`failure` feed arms (#74) remain synthetic in
  live and are assigned to their slices. Do **not** claim "no synthetic claims remain in live mode".
- **Product scope reduction (Q5):** demo mode loses the Updates panel and `image_update` timeline entries.
- **Known gap (Q7):** Copilot's "what changed recently" answer is deliberately thin until #74.
- Closing comment uses the `## Resolution Evidence` format from `AGENTS.md:61-71`, lists the exact screens/claims audited and the
  tested commit SHA, and **recommends** closure — never performs it (DM-01).

---

## 7. Test / e2e plan (V1-V11 → specific files)

**Harness rules that bind every e2e line here (DM-02/G-03):** assert on real mock output text; `domcontentloaded` + explicit waits,
never `networkidle`; unique class per assertion target (`.metric-updates`, `.impact-cell-updates`); query params handled at the route
boundary (N/A here); re-grep route registrations after route-file patches (N/A here).

| ID | Criterion | Where it is discharged |
|---|---|---|
| **V1** | `grep -rn "updateAvailable\|updatesAvailable" apps/web/src` (excluding `dist/`) → **0 hits**, tests included. | Manual gate in §6 step 5; re-run by the reviewer (G-09). Backed at runtime by V4's key scan. |
| **V2** | `grep -rn 'hashString(c.id + "update")' apps/web/src` → absent; `grep -rn "image_update" apps tests` → **0 hits** outside `dist/`. | Same gate. `hashString` itself must still be present (used by `layout.ts:34`, `stubs.ts`). |
| **V3** | Surviving live surfaces render the `Not collected` label **in visible text** plus a non-empty detail; never `0`, blank, `-`, or a suppressed hint. | `screens/updates-surface.test.tsx`: `renderToStaticMarkup` + `AppContext.Provider` (pattern from `change-feed-identity.test.tsx:76-86`) + the `visibleText()` markup-stripper (`evidence-render.test.tsx:6-11`). Asserts: Home contains `Not collected` **and** `Update checks not wired — DockerMap does not query registries`; the `.metric-updates` value is not `"0"`; `Updates available` is absent from the markup; ServiceDetail (routed via `MemoryRouter` to `/services/<name>`) contains `Not collected` + `update status` and neither `>Yes<` nor `>No<` in the impact band. Both surfaces asserted to render the **same** label string. |
| **V4** | Focused AC3 test: synthetic update data cannot reach a live model or live API path; `model.test.ts:254-256` deleted. | `lib/no-synthetic-updates.test.ts` — **L1 (runtime, total):** for a live-shaped snapshot *and* for demo-derived containers, `Object.keys(service)` and `Object.keys(summarize(model))` contain no key matching `/update/i`; `changeFeed(model)` yields no event whose `summary + (detail ?? "") + kind` matches `/updat/i`. **L2 (compile-time):** `@ts-expect-error` gates on `service.updateAvailable` and `summary.updatesAvailable` (technique from `evidence.test.ts` test 9), exercised by `npm run typecheck`. Deletion of `model.test.ts:254-256` is part of step 2. |
| **V5** | Demo/mock sample tagged `demo` **if kept**. | **N/A by decision Q5 — no sample is kept.** Replaced by the inverse lock: `updates-surface.test.tsx` asserts demo mode renders the *same* `Not collected` claim and contains **no** `image_update`, no per-service update list, and no `demo`-kind update tag. |
| **V6** | G-36 wiring test: after a demo→live flip, within one render cycle no "Updates available" claim renders under `modeLabel === "Docker"`; a mock-server snapshot with real container ids cannot yield an update claim. | `screens/updates-wiring.test.tsx` — jsdom + `createRoot` + `vi.mock` harness copied from `AppShell.test.tsx:1-133`; renders the **real** `AppShell` with a nested index route rendering the **real** `Home` (`App.tsx:24-30` shape, `AppShell.tsx:257` `<Outlet/>`). Case 1: `demoMode: true` + demo health → `.conn-mode` is `Demo Engine`, `.metric-updates` reads `Not collected`. Case 2 (**the P1-1 lock**): flip `demoMode` to `false` with `health.mode = "docker"` while `useSystemModel` still returns the **demo-built model**, `rerenderAppShell()` → `.conn-mode` is `Docker Engine` **and** `.metric-updates` still reads `Not collected`, and `host.textContent` contains neither `Updates available` nor a digit-only Updates value. e2e leg: the mock-server run in V9 covers "real container ids through a real fetch". |
| **V7** | `changeFeed` + Copilot degrade gracefully — no `image_update` in live; "update status not collected"-style copy. | `lib/copilot.test.ts` (**new file — none existed**): `answer(model, "what changed recently")` → headline `Recent and pending change`, body is exactly the update-status line containing `Not collected` and the detail, `references` is `[]`, and the body contains neither `have an update available` nor `No pending updates detected`. **G-15 resumption:** the same file asserts one untouched path still answers correctly (`answer(model, "show everything using port 443")` → `portAnswer` output) so a broken dispatch cannot pass. Feed side covered by V4's `/updat/i` scan and by `change-feed-identity.test.tsx` staying green unmodified. |
| **V8** | #71 pass-2 greps re-run → zero unassigned consumers; no registry/advisory endpoints added. | Reviewer re-runs `updateAvailable`, `updatesAvailable`, `image_update`, `resourceFor`, `changeFeed`, `causalChain`, `STUB_`, `hashString` at final HEAD against §1.2's table. Network-quiet proof: `git diff main -- apps/web/src \| grep -nE "fetch\(\|axios\|registry\|advisory\|https?://"` → no new call site. `packages/contracts`, `crates/`, `apps/api` must show a **zero-line diff**. |
| **V9** | `npm run check`; affected vitest; `npm run test:e2e` since the Home surface changes. | `npm run check` (includes typecheck/build/`test:js`/rust gates). Affected vitest files: `lib/model.test.ts`, `lib/no-synthetic-updates.test.ts`, `lib/copilot.test.ts`, `lib/evidence.test.ts`, `lib/evidence-render.test.tsx`, `screens/updates-surface.test.tsx`, `screens/updates-wiring.test.tsx`, `screens/change-feed-identity.test.tsx`, `components/AppShell.test.tsx`, `hooks/useSystemModel.test.tsx`. e2e: `npm run test:e2e` full, with `test:e2e:a11y` mandatory before push (DM-11 first entry — `a11y.spec.ts` is modified). |
| **V10** | G-15 demo/live regression pairs for every claim site. | Pairs, all in `screens/updates-surface.test.tsx` unless noted: **model** — V4's key scan runs over live-shaped *and* demo-derived containers; **Home** — `evidenceMode: "live"` and `"demo"` fixtures; **ServiceDetail** — same two fixtures; **Changes** — both fixtures assert no `Updates` filter chip and no `image_update` timeline row; **Copilot** — `lib/copilot.test.ts` runs `changeAnswer` against a live-shaped and a demo-derived model, asserting identical output. Each pair asserts the **positive** label text, not only the absence of the old symptom. |
| **V11** | Stale-doc note in the PR body (D10 rows, `a11y.spec.ts:501` comment); #77 reconciles. | §6 step 6. The `a11y.spec.ts` comment is fixed **in this PR** (§6 step 4.1); only the #71 doc rows are deferred to #77. |

### e2e specifics (new assertions)

Target file: `tests/e2e/a11y.spec.ts` (the Home surface is already loaded there and the responsive/a11y sweep covers Home), or
`dockermap.spec.ts` if the implementer prefers to keep a11y-scoped assertions pure — either is acceptable, but **not both**.

1. Load `/` with `waitUntil: "domcontentloaded"` and an explicit wait for the Home `h1` ("Command Center") — never `networkidle`.
2. `await expect(page.locator(".metric-updates")).toContainText("Not collected");`
3. `await expect(page.locator(".metric-updates")).toContainText("Update checks not wired");`
4. `await expect(page.getByText("Updates available")).toHaveCount(0);`
5. Navigate to a service detail route that the mock server actually serves (read the mock output; do not invent a name) and assert
   `.impact-cell-updates` contains `Not collected` and does not contain `Yes`/`No`.
6. `/changes`: assert the filter row has no chip labelled `Updates` — `await expect(page.locator(".filter-chip", { hasText: "Updates" })).toHaveCount(0);`

These run against the **mock server** (a real `fetch` through `api.ts`'s non-demo path), which is the AC3 "live API path" leg per §2 Q10.
