# Architecture — #72 Remove synthetic update-available claims from live mode

**Issue:** #72 (child of epic #61 "Make live-state claims evidence-backed"), one slice per PR.
**Branch:** `codex/update-claims-issue-72` (from clean `main` @ `1a08498`).
**Author:** Architect pass 1. **Status:** IMPLEMENTED — 7 shipping commits to `3661683` (§6) plus the
review-round remediation commits G2-G9 (§8). Decisions in §2/§4 remain binding on follow-up slices;
the review-round verdict chain (§8) is the written record of every deviation (G-23).
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
| `apps/web/src/styles.css:1750` | `.k-image_update .timeline-marker { color: var(--accent); }` — the kind's only **CSS** consumer; union removal makes it dead **and** V2 forbids residual `image_update` hits under `apps/` |

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
6. `styles.css:1750` — delete the `.k-image_update .timeline-marker` rule (dead after the union removal; V2 requires zero `image_update` hits under `apps/`). **[Amended 2026-08-24:** the original §1.2/§6 inventory missed this CSS consumer; the implementer stopped on the gap per the deviations rule — this amendment authorizes the deletion.]

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

## 5. Arrested lessons — register pointers (trimmed in the review round, U9)

The full lesson-by-lesson analysis for this slice lives in the shared lesson
registers — `register-generic.md` and `register-dockermap.md` (maintained with
the slice records, as cited in the Inputs line) — and in
`architect-evidence-vocab-71.md` for the evidence vocabulary. The per-lesson
prose previously re-documented here was a second mutable source of truth
guaranteed to drift from the registers (L8/U9); it is replaced by this pointer
and the id lists below.

**Arrested by this slice** (each is addressed in §2's decisions; the register
rows carry the slice-specific detail): G-01, G-02, G-03, G-08, G-09, G-14,
G-15, G-19, G-22, G-23, G-24, G-26, G-36, DM-01, DM-02, DM-05, DM-06, DM-07,
DM-08, DM-09, DM-11 (both entries).

**N/A for this slice** (no surface existed; see the original review): G-04,
G-05, G-06, G-07, G-10, G-11, G-12, G-13, G-16, G-17, G-18, G-20, G-21, G-25,
G-27, G-28, G-29, G-30, G-31, G-32, G-33, G-34, G-35, DM-03, DM-04, DM-10.

---

## 6. Executed history (replaces the ordered implementation checklist)

The slice shipped as 7 commits on `codex/update-claims-issue-72`, **every one
leaving `npm run check` green** — including the step-2 atomicity contract (U1):
step 2 shipped as ONE atomic commit (`127f437`) that cannot be split and stay
green, exactly as the original checklist required.

| # | Step | Commit | Title | Contents |
|---|---|---|---|---|
| 1 | 1 | `4b13832` | Architect pass 1: remove synthetic update claims design (#72) | this design document |
| 2 | 1 | `9caf837` | web: add the update-status evidence claim constant (#72) | `lib/updates.ts`, `Metric` className hook |
| 3 | 2 | `127f437` | web: remove hash-derived update-available claims from every surface (#72) | model, Home, ServiceDetail, stubs, Changes, copilot, model.test — atomic |
| 4 | 2 | `228ed83` | Document styles.css image_update deletion in #72 architecture (amended checklist) (#72) | `styles.css` `.k-image_update` rule + Q8/§6 amendment |
| 5 | 3 | `d015c93` | test: lock update claims out of model and user surfaces (#72) | no-synthetic-updates, updates-surface, copilot.test, updates-wiring |
| 6 | 4 | `d39e394` | e2e: assert the Updates surface reports not-collected (#72) | a11y.spec.ts Home legs (§7 items 1-4) |
| 7 | 5 | `3661683` | test: keep removal gates outside literal claim greps (#72) | grep-surface hygiene |

Original checklist steps 5-6 (full gate, PR body, `## Resolution Evidence`
closure) were discharged by the PR. The hostile-review round that followed is
recorded in §8.

---

## 7. Test plan — executed (replaces the V1-V11 plan verbosity)

Every V-criterion is discharged by a file that now exists; the plan is not
re-documented here (U9):

| ID | Discharged at |
|---|---|
| V1 | reviewer grep + `lib/no-synthetic-updates.test.ts` key scan |
| V2 | reviewer grep: `image_update` → 0 hits under `apps/`, `tests/` |
| V3 | `screens/updates-surface.test.tsx` — visible-text label + detail, non-digit metric value, no `>Yes<`/`>No<` in the impact band |
| V4 | `lib/no-synthetic-updates.test.ts` — L1 runtime deep scan, L2 `@ts-expect-error` gates |
| V5 | N/A by Q5 — inverted lock: demo renders the same claim in `updates-surface.test.tsx` |
| V6 | `screens/updates-wiring.test.tsx` — real AppShell + Home, mode flips (both directions), generation change, digit-only absence |
| V7 | `lib/copilot.test.ts` |
| V8 | reviewer greps at final HEAD (V1/V2 commands) |
| V9 | `npm run check` + `npm run test:e2e:a11y` (a11y.spec.ts modified) |
| V10 | `updates-surface.test.tsx` live/mock/demo triples |
| V11 | PR body supersession note; #77 reconciles the #71 doc |

§7 e2e items 1-4 shipped in `d39e394`; items 5-6 (ServiceDetail impact cell +
`/changes` chip absence) shipped in the review-round commit `7d12559` (G2).
All run against the mock server — the AC3 "live API path" leg (Q10).

---

## 8. Review round + remediation (U1-U18 verdict chain)

After the 7 shipping commits, an 8-reviewer hostile review produced 30 raw
findings → 18 union findings (U1-U18), consolidated in the convergence record.
This section is the written verdict chain (G-23): each row records the finding,
its severity ruling, and the remediation commit that resolved it.

| U | Finding (severity) | Resolution | Commit |
|---|---|---|---|
| U1 | Step-2 atomicity violated — non-compiling intermediates (P1) | REBASED: `main..HEAD` folded to ONE atomic step-2 commit; every commit leaves `npm run check` green | `127f437` (history) |
| U2 | §7 e2e items 5-6 not implemented (P1) | G2: `.impact-cell-updates` contains `Not collected` and no `Yes`/`No`; `/changes` has no "Updates" filter chip | `7d12559` |
| U3 | Claim API split vs binding rendered shape (P1) | G3: `UPDATE_STATUS_CLAIM` is the single public object (kind/value/detail); `UPDATE_STATUS_DETAIL` internal; consumers read `UPDATE_STATUS_CLAIM.detail` or the derived label — zero external consumers of the standalone constant | `250e06c` |
| U4 | No-synthetic runtime scan vacuous/weak (P2) | G4: API-shaped live fixture, nested deep-key scan, renamed-claim probes (`imageRefresh`, kind `refresh`, "pulled newer image"), blind spot documented; `@ts-expect-error` gates kept as the real backstop | `e86de9c` |
| U5 | V3/V6 scoped negatives missing (P2) | G5: `.metric-updates .metric-value` never digit-only; impact band has no `>Yes<`/`>No<`; wiring test V6 digit-only absence | `516525f` |
| U6 | Copilot user-visible wiring untested (P2) | G6: e2e asserts the rendered answer carries the not-collected copy and renders no references | `ef48422` |
| U7 | Changes kind handling non-total; `deploy` silently covered (P2; dissent L2 P3 vs L5 P2) | G7: `iconForKind` is an exhaustive switch (explicit `deploy` → `up`, NO default swallow — a new kind is a compile error); `CHANGE_TEMPLATES` totality documented (Record over the full kind union makes generator-less kinds type-impossible) | `f14ffd4` |
| U8 | Stale docs still promise removed update surfaces (P2) | G8: DESIGN_LANGUAGE, ARCHITECTURE, architect-detail-pages-34 updated to the not-collected reality | `81c5705` |
| U9 | Arch doc over-engineered; duplicates review machinery (P2) | G9: this file — §5/§7 re-documentation replaced by register pointers + executed-history table + this verdict chain | *(the G9 commit)* |
| U10 | Shared `visibleText()` bypassed (P3) | INCLUDE: helper moved to `lib/test-utils.ts`; both render tests import it | `516525f` |
| U11 | Wiring test act() hygiene (P3) | INCLUDE: mode flips wrapped in `act()` | `516525f` |
| U12 | Wiring transition coverage incomplete (P3) | INCLUDE: live→demo flip + model-generation-change cases added | `516525f` |
| U13 | `Claim<T>` fields not readonly; singleton unfrozen (P3) | SKIP — theoretical only, zero mutation surface; evidence types owned by #68 | — |
| U14 | `.metric-updates` CSS orphan (P3) | SKIP — deliberate per §6 step 1.2 "No CSS is added"; the class is a test locator | — |
| U15 | Copilot change/deploy dispatch thinness (P3) | SKIP — doc-mandated thinness until #74 (Q7) | — |
| U16 | Pre-existing React 19 `<title>` array-children warning (P3) | SKIP — pre-existing, outside the diff, upstream React | — |
| U17 | Pure mock-mode render not directly asserted (P3) | INCLUDE: `evidenceMode: "mock"` cases in updates-surface tests | `516525f` |
| U18 | L5 residual P3 (text lost to truncation) (P3) | SKIP — no actionable target; L2/L3 independently verified the same paths clean | — |

**Completeness claim (Q8) restated after remediation:** the update-claim
invariant is now enforced at three levels — type removal (compile), the runtime
tripwire scans (G4), and the e2e/unit render assertions (G2/G5/G6). Other
synthetic surfaces (`resourceFor` → #73, `restart`/`failure` feed arms → #74)
remain out of scope by design.
