# Architecture pass 1: shared evidence-kind vocabulary for live user-facing claims (#71)

Status: pass 1 of 2, binding scope for the implementer. Part of epic #61 (Make live-state claims evidence-backed). Deviation from an arrested lesson in the "Arrested lessons" section is a P1 finding in pass 2.

## Goal and non-goals

Ship the smallest web-layer vocabulary that lets every user-facing claim declare what it is worth: **observed / derived / inferred / demo / unavailable**. This slice ships the primitive only — it does not re-tag a single existing claim site. The sibling slices #72-#76 do the tagging.

Non-goals, explicitly:

- **No public-contract change.** `packages/contracts/src/index.ts` is untouched. The canonical provenance model belongs to a later epic (#68); putting a kind on the wire now would freeze a vocabulary before its consumers exist and would force the Rust daemon (`crates/dockermap-core`) to mirror a shape that only the web layer currently needs. The vocabulary is a rendering-truthfulness primitive, not a transport concern.
- **No provenance framework.** No claim graphs, no evidence chains, no source attribution beyond a single kind plus, for `unavailable`, a plain reason sentence. Richer provenance lands in a later epic.
- **No styling.** The helper returns text and a kind; it emits no markup, className, tone, colour token, or icon name. Epic #67 (Hearth DS) restyles this class of surface later, and public DockerMap must not acquire a private design-system dependency.
- **No claim-site rewrites.** `model.ts:321`, `stubs.ts:29`, the Change Center, and Copilot keep their current behavior in this slice.

## Verified current state

Every line below was read at the cited location on the current working tree.

### The three data-source modes (this is the load-bearing finding)

There are **three** modes, not two, and they do not compose the way the code reads at first glance.

| Mode | Where it is decided | What the browser gets | Travels the live code path? |
| --- | --- | --- | --- |
| `demo` | Client, `apps/web/src/lib/settingsStore.ts:18` (`demoMode: boolean`, persisted to `localStorage` key `dockermap.settings.v1` at `settingsStore.ts:36`) | `apps/web/src/utils/api.ts:30` short-circuits **before any fetch** and returns `getDemoResponse<T>(path)` | **No** — no network request is made at all |
| `mock` | Server, `apps/api/src/index.ts:49` (`DOCKERMAP_ALLOW_MOCK`) and `apps/api/src/index.ts:447` (`if (allowMockFallback) return publishApiPayload(getMockResponse<T>(path))`), reported as `mode: "mock"` at `apps/api/src/index.ts:469`. Also produced by the Rust daemon at `crates/dockermap-daemon/src/main.rs:339` (`mode: RuntimeMode::Mock`) | Synthetic fixtures delivered over the **real HTTP path**, through `fetchJson` (`api.ts:50`), `useApiResource`, `useSystemModel`, and `buildModel` | **Yes** — this is why "gate the stubs behind demo mode" is not sufficient on its own |
| `live` | Daemon reached Docker; `health.mode === "docker"` (`RuntimeMode = "docker" \| "mock"`, `packages/contracts/src/index.ts:3`; `HealthResponse.mode` at `packages/contracts/src/index.ts:433`) | Real host snapshot | Yes |

- `apps/web/src/components/AppShell.tsx:146` already renders all three: `const mode = settings.demoMode ? "Demo" : health?.mode === "docker" ? "Docker" : "Mock";`, displayed at `AppShell.tsx:198` as `{mode} Engine`.
- **`health.mode` alone cannot distinguish demo from mock.** `apps/web/src/lib/demoData.ts:174-181` defines `demoHealth` with `mode: "mock"`. In demo mode the browser therefore holds a health object claiming mock. The demo-mode flag must be consulted *first*; `AppShell.tsx:146` already does this by accident of ordering, and the new resolver must do it by contract.
- **`health.dockerReachable` is not trustworthy as an evidence authority.** `demoData.ts:177` sets `dockerReachable: true` inside the demo payload, while `apps/api/src/index.ts:471` sets it `false` for the server mock. No code may use `dockerReachable` to decide whether a claim is observed.
- `health` starts as `null` (`apps/web/src/hooks/useDaemonHeartbeat.ts:11`) and only becomes non-null after the first SSE `snapshot` event (`useDaemonHeartbeat.ts:26-30`) or, in demo mode, immediately from `getDemoHealth()` (`useDaemonHeartbeat.ts:15`). There is a real window in live operation where the mode is **not yet known**.

### The model layer cannot currently tell what mode it is in

- `apps/web/src/lib/model.ts:251`: `export function buildModel(snapshot: DockerSnapshot, runtimeMap: RuntimeMap): SystemModel` — no mode parameter.
- `apps/web/src/hooks/useSystemModel.ts:27`: `const built = buildModel(snapshot.data, runtimeMap.data);` — the only call site, and it has no mode either.
- `apps/web/src/lib/settingsStore.ts:91-93`: `isDemoMode()` reads module-global `state`. `settingsStore.ts:39` returns `DEFAULT_SETTINGS` when `typeof window === "undefined"`, and `DEFAULT_SETTINGS.demoMode` is `false` (`settingsStore.ts:27`). **An ambient `isDemoMode()` read therefore fails OPEN to "not demo" under SSR and before hydration** — exactly the wrong direction for a truthfulness primitive.
- `apps/web/src/context.tsx:5-12`: `AppContextValue` = `{ model, loading, error, health, tick, openCommand }`. This is the existing per-render distribution channel every screen already uses via `useApp()` (`context.tsx:16-20`). It carries no mode.
- `apps/web/src/hooks/useSystemModel.ts:23-30` already pins snapshot and runtime map to the **same generation** before building a model, and retains the previous model otherwise. The mode is a peer input to that pinned tuple.

### Claim sites this vocabulary will serve

| Claim | Site | Live mode renders today | Demo mode renders today | Qualified today? |
| --- | --- | --- | --- | --- |
| `updateAvailable` (hash-derived) | Produced at `apps/web/src/lib/model.ts:321` (`hashString(c.id + "update") > 0.74`), typed at `model.ts:95`, counted at `model.ts:565` | Same synthetic boolean — no mode gate anywhere | Identical synthetic boolean | **No** |
| Home "Updates" metric | `apps/web/src/screens/Home.tsx:45` (`<Metric label="Updates" value={summary.updatesAvailable} />`) | A bare integer presented as host truth | Same | **No** |
| Home "Updates available" panel | `apps/web/src/screens/Home.tsx:142-143` (`<Panel title="Updates available" icon="up" hint={`${updates.length}`}>`), list at `Home.tsx:144-159` | Service list asserting pending updates | Same | **No** — `hint` is the count, not a qualifier |
| ServiceDetail update cell | `apps/web/src/screens/ServiceDetail.tsx:100` (`{service.updateAvailable ? "Yes" : "No"}`), label at `ServiceDetail.tsx:101` | Flat "Yes"/"No" | Same | **No** |
| Copilot change answer | `apps/web/src/lib/copilot.ts:168-176` (`changeAnswer`, filters `s.updateAvailable`) | "N services have an update available" as fact | Same | **No** |
| CPU / memory / network | `apps/web/src/lib/stubs.ts:29-46` (`resourceFor`, `ResourceSample.estimated: true` at `stubs.ts:26`) | Synthesized from `hashString` | Same | Partly — see next two rows |
| ServiceDetail Resources panel | `apps/web/src/screens/ServiceDetail.tsx:210-212` (`resourceFor`, `<Panel title="Resources" icon="cpu" hint={STUB_NOTICE}>`) | Values + hint "Estimated — live resource collectors not yet wired" (`stubs.ts:16`) | Same | **Yes**, via one free-text hint |
| Home per-service CPU bar | `apps/web/src/screens/Home.tsx:167` (`resourceFor`) rendered at `Home.tsx:177-179` (`<Bar value={res.cpuPercent} …/>`) | A filled bar with **no qualifier at all** | Same | **No** |
| Change history | `apps/web/src/lib/stubs.ts:86-104` (`changeFeed`, `ChangeEvent.estimated: true` at `stubs.ts:68`, timestamps invented at `stubs.ts:95,98,100`) | Invented events + timestamps | Same | — |
| Change Center timeline | `apps/web/src/screens/Changes.tsx:43` (`<Panel title="Timeline" icon="history" hint={STUB_CHANGES_NOTICE}>`, `stubs.ts:17`) | Timeline + hint "Sample timeline — change collectors not yet wired" | Same | **Yes**, one free-text hint |
| Home "Recent change" panel | `apps/web/src/screens/Home.tsx:118` (same `STUB_CHANGES_NOTICE` hint) | Feed + hint | Same | **Yes**, one free-text hint |
| Causal chain | `apps/web/src/lib/stubs.ts:131-148` (`causalChain`), rendered `apps/web/src/screens/Home.tsx:126` (`<Panel title="What happened" icon="pulse" hint="Causal chain">`) | Narrative inference ("lost its upstream connection") presented as history | Same | **No** — "Causal chain" is a title, not a qualifier |

**Net finding: live and demo render identically at every one of these sites.** There is no mode gate on any of them. The two existing qualifiers (`STUB_NOTICE`, `STUB_CHANGES_NOTICE`) are free-text panel hints with no type behind them and no coverage of the Home CPU bar, the Updates surfaces, ServiceDetail's update cell, the causal chain, or Copilot.

### Rendering and test infrastructure

- `apps/web/src/components/primitives.tsx:63`: `{hint && <span className="panel-hint">{hint}</span>}`. **A falsy hint (including `""`) suppresses the entire hint element.** This is the G-19 mechanism, live in this repo. An evidence label that can be empty renders as nothing.
- `apps/web/src/components/primitives.tsx:82-90` (`Metric`, `value: ReactNode`, `sub` also falsy-suppressed at line 87) and `primitives.tsx:28-35` (`Tag`, `children: ReactNode`, optional `tone`) are the other two primitives the sibling slices will render labels through.
- Text-only helper precedent: `apps/web/src/lib/identity.ts` is a plain `.ts` module of string constants plus one pure function (`identityText`, `identity.ts:45-49`). It has no React import and is consumed by both `lib/` (`stubs.ts:2`, `copilot.ts:2`) and screens. The evidence module follows this exact shape.
- Test runner: `vitest run --passWithNoTests` (`apps/web/package.json:9`), vitest 4.1.9 with jsdom 30 available. `apps/web/vite.config.ts` declares **no `test` block** — there is no global environment and no setup file. SSR-shaped tests import `renderToStaticMarkup` (`apps/web/src/screens/change-feed-identity.test.tsx:1`); DOM tests opt in per file with the docblock `// @vitest-environment jsdom` (`apps/web/src/screens/duplicate-list-keys.test.tsx:1`) and drive `createRoot` from `react-dom/client`.
- `AppContextValue` is constructed in **7 test files**: `change-feed-identity`, `collision-graph-runtime`, `collision-identity`, `detail-identity`, `diagnostics-tone`, `duplicate-list-keys`, `mount-keys` (all under `apps/web/src/screens/`).
- Gates this slice must fit: `npm run check` → `check:js` (`audit`, `typecheck`, `build`, `test:js`) then `check:rust` (root `package.json:19-23`). `test:e2e` and `test:live-docker` exist (`package.json:33,35`) but are not required by this slice — see DM-02/DM-03 below.

### Could not verify

- **Issue #71 was not read from GitHub.** `gh issue view 71 --repo Joncallim/DockerMap` fails with `gh auth login` required (no `GH_TOKEN` in this environment), and the deltas forbid git commands. The slice text used here is the local copy at `/tmp/dm61-child-1.md` (goal, scope, acceptance criteria, non-goals, validation), cross-checked against the brief's summary; the sibling scopes come from `/tmp/dm61-child-2.md` … `dm61-child-6.md`. If the GitHub issue body has drifted from those files, pass 2 must reconcile.
- **Issue numbering for the siblings is inferred**, not confirmed: `dm61-child-2..6` are mapped to #72-#76 in slice order (updates, resources, history, Copilot, sweep) per the brief. The mapping of scope→number should be confirmed before the consumption map is quoted in a PR body.

## Decisions

### D1 — Module: `apps/web/src/lib/evidence.ts`, plain TypeScript

One new file, no `.tsx`, no React import, no dependency on `settingsStore`, `model`, or `contracts` types beyond `RuntimeMode` (type-only import).

Rationale: it mirrors `identity.ts`, which is the repo's established shape for a cross-cutting truthfulness helper consumed by both `lib/` and `screens/`. A React component would (a) be unusable from `copilot.ts` and `model.ts`, which are plain modules, (b) drag styling decisions into a slice that must not make them, and (c) make the vocabulary untestable without a renderer. A `.ts` module keeps `evidence.ts` importable from every layer including the Rust-mirroring-free web model.

### D2 — Two separate concepts: mode ≠ kind

This is the core of the design and the answer to the three-mode finding.

```ts
/** Where the bytes came from. Three values, exhaustive. */
export type EvidenceMode = "live" | "mock" | "demo";

/** What one user-facing claim is worth. Five values, fixed by #71. */
export type EvidenceKind = "observed" | "derived" | "inferred" | "demo" | "unavailable";
```

`mock` gets **its own mode value** — it is neither demo nor live, because it reaches the browser through the live code path (`api.ts:50` → real fetch) while carrying no host truth. But it gets **no new kind**: the issue fixes the vocabulary at five, and a sixth kind would fragment every consumer's switch. A host-truth claim in `mock` mode is `demo` kind (it *is* sample data) or `unavailable`. Never `observed`, never `derived`, never `inferred`.

The bridge between them is a single total function:

```ts
export type ClaimAuthority = "host" | "sample" | "none";

export function claimAuthority(mode: EvidenceMode | null): ClaimAuthority {
  if (mode === "live") return "host";
  if (mode === "demo" || mode === "mock") return "sample";
  return "none";
}
```

- `"host"` → `observed`, `derived`, and `inferred` are permitted (plus `unavailable` when the specific evidence is missing).
- `"sample"` → only `demo` and `unavailable` are permitted.
- `"none"` → only `unavailable` is permitted.

This makes #71's acceptance criterion ("demo/sample values cannot cross into a live model or live API path") unambiguous across all three modes: **`claimAuthority` returns `"host"` for exactly one mode value, and the sample kinds are unreachable from it.** It is one exhaustively-testable function, not a convention.

### D3 — Mode resolution: explicit inputs, fail-closed, one authority

```ts
export interface EvidenceModeInput {
  /** settings.demoMode — the client short-circuit at utils/api.ts:30. */
  demoMode: boolean;
  /** health?.mode ?? null — null while the heartbeat has not reported yet. */
  healthMode: RuntimeMode | null;
}

/** null = authority not yet established. Never guess. */
export function resolveEvidenceMode(input: EvidenceModeInput): EvidenceMode | null {
  if (input.demoMode) return "demo";        // checked FIRST: demoHealth.mode is "mock" (demoData.ts:176)
  if (input.healthMode === "docker") return "live";
  if (input.healthMode === "mock") return "mock";
  return null;                               // health not received, or an unrecognized value
}
```

Three decisions are packed in here:

1. **`demoMode` is checked first, by contract, with the reason in a comment.** `demoData.ts:176` makes `health.mode === "mock"` true in demo mode; ordering is the only thing preventing demo from being classified as server-mock. `AppShell.tsx:146` gets this right today incidentally — after this slice there is one function that gets it right deliberately.
2. **Inputs are passed explicitly, never read ambiently.** `isDemoMode()` (`settingsStore.ts:91`) must not be called from `evidence.ts`. It fails open to `false` under SSR and pre-hydration (`settingsStore.ts:39` → `DEFAULT_SETTINGS.demoMode === false`, `settingsStore.ts:27`), which would tag demo data as live. Explicit inputs also make the resolver a pure function with an 8-row truth table.
3. **Unknown health resolves to `null`, not to a mode.** This is the G-24 branch. Returning `"mock"` for unknown health (which is what `AppShell.tsx:146` displays today) would over-claim that the daemon is in mock fallback when we simply do not know yet. `null` carries "no authority", and `claimAuthority(null) === "none"` forces `unavailable` at every claim site during the heartbeat window.

`health.dockerReachable` is **forbidden** as an input: `demoData.ts:177` sets it `true` in demo mode.

### D4 — The five kinds and their exact user-facing strings

Two strings per kind. `label` is the short form for `Tag` children and `Panel.hint`; `description` is the sentence for `title` attributes, tooltips, and Copilot prose. Both are always non-empty. Sentence case, no trailing punctuation on `label`.

| Kind | `label` | `description` |
| --- | --- | --- |
| `observed` | `Observed` | `Read directly from this host` |
| `derived` | `Derived` | `Calculated from data read from this host` |
| `inferred` | `Inferred` | `A heuristic guess, not measured` |
| `demo` | `Sample data` | `Sample data — not from a host` |
| `unavailable` | `Not collected` | `DockerMap does not collect this yet` |

Wording rationale (DM-06 — a label must not claim more than the data proves):

- `Observed` / `Read directly from this host` — states the provenance, claims nothing about freshness or completeness.
- `Derived` / `Calculated from data read from this host` — deliberately distinguishes arithmetic-over-observation from observation. `summarize()` counts (`model.ts:550-568`) are the archetype: real, but computed.
- `Inferred` / `A heuristic guess, not measured` — the word "guess" is doing deliberate work. `causalChain` (`stubs.ts:131`) and `classifyKind` (`model.ts:219`) are regex heuristics; a softer word ("estimated", "predicted") reads as a measurement with error bars, which is exactly the overclaim DM-06 arrests.
- `Sample data` / `Sample data — not from a host` — covers both demo and mock. Not "Demo", because in server-mock mode the user did not turn on demo mode and "Demo" would be wrong; "Sample data" is true in both. The mode pill at `AppShell.tsx:198` keeps saying `Demo Engine` / `Mock Engine`, so the operational distinction stays visible where it belongs.
- `Not collected` / `DockerMap does not collect this yet` — reads as an intentional product state, not as an error and not as zero. "Unknown" and "Unavailable" were both rejected: "Unknown" implies DockerMap tried and failed, and "Unavailable" collides with the `UNAVAILABLE_*` identity family in `identity.ts:11-42`, which means something different (a schema-valid empty string in a record we *did* observe). Keeping the two families lexically distinct prevents a reviewer from conflating them.

All five `label` values are distinct; all five `description` values are distinct; no value is empty or whitespace-only; every `label` is ≤ 32 characters. All four properties are asserted by test (see D7).

### D5 — The label helper: text and kind only

```ts
export interface EvidenceLabel {
  kind: EvidenceKind;
  label: string;
  description: string;
}

export const EVIDENCE_KINDS: readonly EvidenceKind[] =
  ["observed", "derived", "inferred", "demo", "unavailable"] as const;

export function evidenceLabel(kind: EvidenceKind): EvidenceLabel;
```

- Returns **only** `{ kind, label, description }`. No `ReactNode`, no `className`, no `tone`, no colour token, no `IconName`, no `aria-*`. Per-surface presentation is each consuming slice's call; visual treatment belongs to epic #67 (Hearth DS), and public DockerMap must not acquire a private design-system dependency. A pass-2 review that finds any styling field in this interface should treat it as a P1.
- Backed by a `Record<EvidenceKind, EvidenceLabel>` constant, so adding a kind without adding its strings is a compile error (exhaustiveness by record type, not by switch).
- **Throws on an unrecognized kind** rather than returning a generic fallback. A kind can only be wrong if it was cast from untyped data; a lenient fallback there would silently print a plausible label over an unknown provenance (G-01, G-24). Throwing at the vocabulary boundary is the fail-closed behavior.

### D6 — How a claim site tags a value: `Claim<T>` wrapper with constructors

Inline unions (`value: number | "unavailable"`) were rejected: they force every render site to re-derive the kind from the value's shape, they cannot express "derived vs inferred" for the same `number`, and they make `0` and `unavailable` structurally adjacent — the exact confusion this slice exists to prevent.

```ts
export type Claim<T> =
  | { kind: "observed" | "derived" | "inferred" | "demo"; value: T }
  | { kind: "unavailable"; value: null; detail: string };

export function observed<T>(value: T): Claim<T>;
export function derived<T>(value: T): Claim<T>;
export function inferred<T>(value: T): Claim<T>;
export function demoSample<T>(value: T): Claim<T>;   // `demo` kind; named to avoid conflation with demo MODE
export function unavailable(detail: string): Claim<never>;
```

Four properties fall out of this shape, and each one arrests a named risk:

1. **No silent default is expressible.** There is no zero-argument constructor, no optional `kind` parameter, and no default. `unavailable` is the only constructor that takes no value, and it demands a reason. A claim site cannot produce a `Claim` without naming a kind.
2. **`unavailable` cannot render as `0` or blank.** Its `value` is `null` at the *type* level, so `claim.value.toFixed(1)` does not compile without narrowing on `kind`. The renderer is forced through a branch, and that branch has a label to render. This is the type-level answer to "unavailable rendering as blank/0".
3. **`detail` is required and non-empty.** `unavailable("")` throws. `unavailable()` does not compile. The reason strings replace today's free-text panel hints (`STUB_NOTICE`, `stubs.ts:16`) with a value that travels with the claim instead of sitting next to it.
4. **`detail` must be a static literal, never interpolated snapshot data** (DM-01, secret redaction). Enforced by review and by the checklist step below, not by the type system.

`demoSample()` is the only constructor a demo/mock path may call for a host-truth claim, and the naming makes a review grep trivial: `grep -n 'observed(\|derived(\|inferred(' ` inside any demo-gated branch is a defect.

### D7 — Test plan

All in `apps/web/src/lib/evidence.test.ts` (vocabulary, plain vitest, no environment docblock) plus `apps/web/src/lib/evidence-render.test.tsx` (micro-render fixtures, `renderToStaticMarkup`, matching `change-feed-identity.test.tsx:1`). Runs under `npm run test:web` → `npm run test:js` → `npm run check`.

**Vocabulary and labels**

1. `EVIDENCE_KINDS` has exactly 5 entries and equals the union — asserted at type level with a `satisfies` check plus an exhaustive `Record<EvidenceKind, …>` lookup that fails to compile if a kind is added without strings.
2. Every `label` and every `description` is non-empty after `trim()`. **This is the G-19 gate**: `primitives.tsx:63` suppresses a falsy hint entirely, so an empty label would silently render nothing.
3. `new Set(labels).size === 5` and `new Set(descriptions).size === 5` — distinctness, so two kinds can never read identically to a user.
4. Every `label.length <= 32`.
5. `evidenceLabel("nonsense" as EvidenceKind)` throws — no lenient fallback.

**No silent default / no crossing (the acceptance criterion)**

6. Mode truth table, all 8 combinations of `demoMode ∈ {true, false}` × `healthMode ∈ {"docker", "mock", null}` plus one unrecognized string cast to `RuntimeMode`. Named assertions include: `{demoMode: true, healthMode: "docker"} → "demo"` (demo wins over a docker health — proves demo data can never be classified live) and `{demoMode: false, healthMode: null} → null`.
7. `claimAuthority` over the full mode domain plus `null`: `"live" → "host"`, `"mock" → "sample"`, `"demo" → "sample"`, `null → "none"`. Asserted by iterating `["live","mock","demo",null]` so a future mode value forces a test update.
8. **Positive direction (G-15): the correct behavior RESUMES.** `claimAuthority("live") === "host"` and an `observed(42)` claim in live mode renders `Observed` — the suite must prove live mode still asserts host truth, not merely that demo does not leak.
9. `unavailable("")` and `unavailable("   ")` throw; `unavailable("Live resource collectors are not wired yet")` returns `{ kind: "unavailable", value: null, detail: … }`.
10. Type-level crossing test: a `// @ts-expect-error` line asserting that `claim.value.toFixed(1)` does not compile on an un-narrowed `Claim<number>`. `npm run typecheck` (root `package.json:14`, in `check:js`) makes this a real gate — a `@ts-expect-error` that stops erroring fails the build.

**Micro-render fixtures (delta c + G-19)**

11. For each of the 5 kinds, render `evidenceLabel(kind).label` through each of the three primitives the sibling slices will use — `Panel` `hint` (`primitives.tsx:63`), `Tag` children (`primitives.tsx:28`), and `Metric` `value` (`primitives.tsx:82`) — and assert the label text is present in the static markup. 15 assertions. This proves no kind is swallowed by the falsy-hint suppression.
12. An `unavailable` claim rendered through `Metric` shows `Not collected` and **does not** show `0`, `-`, or an empty `metric-value` element.

Each sibling slice (#72-#76) adds its own per-surface fixture for the kinds it introduces; #71 cannot write those fixtures because those surfaces do not yet consume the vocabulary. That obligation is recorded in the consumption map and must be restated in each sibling's brief.

**Not run by this slice:** `npm run test:e2e`, `npm run test:live-docker`. No rendered surface changes in #71 (see DM-02/DM-03).

### D8 — Where the mode lives: `AppContext`, resolved once, pinned per render

`AppShell` is the only place that holds both inputs today — `settings` (`AppShell.tsx:124`) and `health` (`AppShell.tsx:121`) — and it already computes a mode string at `AppShell.tsx:146`.

Decision:

1. `AppContextValue` (`context.tsx:5-12`) gains **one required field**: `evidenceMode: EvidenceMode | null`.
2. `AppShell` computes it once per render: `const evidenceMode = resolveEvidenceMode({ demoMode: settings.demoMode, healthMode: health?.mode ?? null });` and puts it in `ctx` (`AppShell.tsx:155-162`).
3. **The display pill is re-derived from the same value**, replacing the independent expression at `AppShell.tsx:146`. One mode authority, not two — otherwise the pill and the claim labels can disagree after any future edit to either.
4. `buildModel`'s signature is **not** changed in this slice. #72 is the first consumer that needs the mode inside the model layer and owns that parameter change. Adding an unused parameter here would ship a widened signature with no test exercising it.
5. The field is **required, not optional with a default**. An optional `evidenceMode?: EvidenceMode` would let a screen silently receive `undefined` and (via any `?? "live"`-shaped fallback) tag sample data as observed. Cost: the 7 test files that construct `AppContextValue` must each add the field — that is the point, since each one then declares the mode its fixture is testing.

Rejected alternatives: a module-level context or setter in `evidence.ts` (ambient global, same fail-open defect as `isDemoMode()`, untestable in parallel, and invisible at the call site); a new React context (a second provider for one scalar when `AppContext` already reaches every screen); reading `isDemoMode()` at each claim site (fails open pre-hydration, and scatters the demo-before-health ordering rule across N sites).

### D9 — Relationship to demo mode

- The `demo` **kind** exists *for* the demo and mock **modes**. It is the honest label for a value that exists but did not come from a host.
- **Live mode must never silently default to `demo`.** In live mode a claim with no evidence source is `unavailable` — a missing collector is not a licence to show a sample. This is D2's `claimAuthority` plus D6's constructor set; there is no code path from `mode === "live"` to a `demo`-kind claim, and test 7 asserts it over the whole mode domain.
- The reverse also holds: in demo/mock mode a claim may not be `observed`/`derived`/`inferred`, because there is no host to observe.
- `stubs.ts`'s existing `estimated: true` flags (`stubs.ts:26`, `stubs.ts:68`) are a weaker parallel vocabulary. **#71 must not extend or consume them**; #73 and #74 replace them. Recorded under G-23 below.

### D10 — Expected consumption map for #72-#76

One line per site. Each sibling slice tags exactly these and adds its own micro-render fixture.

| Slice | Site | Mode | Kind |
| --- | --- | --- | --- |
| #72 updates | `model.ts:321` `updateAvailable` | live | `unavailable` — no registry evidence source exists, and none is being added (runtime stays network-quiet) |
| #72 updates | `model.ts:321` `updateAvailable` | demo / mock | `demo` |
| #72 updates | `Home.tsx:45` Updates metric, `Home.tsx:142-143` Updates panel | live | `unavailable` with the `Not collected` label rendered, not a `0` |
| #72 updates | `ServiceDetail.tsx:100` update cell | live | `unavailable` — replaces the flat `"No"`, which today asserts "no update exists" |
| #73 resources | `stubs.ts:29` `resourceFor` output | demo / mock | `demo` |
| #73 resources | `ServiceDetail.tsx:210-212` Resources panel, `Home.tsx:167,177` CPU bar | live | `unavailable`; the Home bar (unqualified today) is the priority site |
| #74 history | `stubs.ts:86` `changeFeed` output | demo / mock | `demo` |
| #74 history | `Changes.tsx:43` timeline, `Home.tsx:118` Recent change | live | `unavailable` — invented timestamps must not reach a live surface |
| #74 history | `stubs.ts:131` `causalChain` → `Home.tsx:126` | demo / mock `demo`; live `unavailable` (or `inferred` **only** if rebuilt from observed states) |
| #75 Copilot | `copilot.ts:168` `changeAnswer` | live | `unavailable` for the change claim |
| #75 Copilot | `copilot.ts:179` `serviceOverviewAnswer` state/image/ports/dependency lines | live | `observed` (snapshot fields) |
| #75 Copilot | `computeImpact` counts (`model.ts:574`), `summarize` counts (`model.ts:550`) | live | `derived` |
| #75 Copilot | `classifyKind` regex classification (`model.ts:219`), `stateForStatus` mapping (`model.ts:208`) | live | `inferred` |
| #76 sweep | Residual surfaces not owned above; produces the route → claim → kind → action matrix | all | per site |

## Risks + mitigations

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | **Label drift** — a consumer writes its own string ("Estimated", "Sample") instead of using the helper, so two surfaces describe the same kind differently. | The strings live only in the `Record<EvidenceKind, EvidenceLabel>` inside `evidence.ts`; tests 2-4 assert non-empty, distinct, bounded. Pass-2 and every sibling review greps for the five literal label strings outside `evidence.ts` — any hit is a finding. `STUB_NOTICE`/`STUB_CHANGES_NOTICE` are the existing instances of this drift and are scheduled for removal in #73/#74. |
| R2 | **Consumers bypass the helper** by writing a raw object literal `{ kind: "observed", value }`, or by rendering a value with no `Claim` at all. | Constructors are the documented and only supported path; `Claim` is exported as a type, so a literal is possible but conspicuous. Review grep: `kind: "` outside `evidence.ts`. The deeper protection is D6 property 2 — an untagged raw value has no label to render, which each sibling's micro-render fixture catches. |
| R3 | **`unavailable` renders as blank, `0`, `-`, or a suppressed hint**, reading as "no load" / "no updates" rather than "not measured". | Type-level: `value: null` on the `unavailable` arm forces narrowing (D6.2, test 10). Render-level: tests 11-12 assert the label text appears through `Panel.hint` (`primitives.tsx:63`, the falsy-suppression site), `Tag`, and `Metric`, and that `0` does not. |
| R4 | **A naive default kind sneaks in** — an `?? "observed"`, a default parameter, or an optional `evidenceMode` that becomes `undefined`. | No constructor has a default or an optional kind (D6.1); `evidenceLabel` throws instead of falling back (D5); `AppContextValue.evidenceMode` is required, not optional (D8.5); `resolveEvidenceMode` returns `null` rather than guessing (D3.3). Pass-2 grep: `?? "observed"`, `?? "live"`, `= "observed"`, `kind =`. |
| R5 | **Mode drift** — `AppShell.tsx:146`'s pill expression and the evidence mode diverge after a later edit, so the UI says "Docker" while claims say sample (or vice versa). | D8.3: the pill is re-derived from `resolveEvidenceMode`; the standalone expression at `AppShell.tsx:146` is deleted, not left alongside. |
| R6 | **The demo-health trap resurfaces** — a future contributor reads `health.mode === "mock"` (or `dockerReachable`) directly and classifies demo as server-mock, or demo as reachable. | `resolveEvidenceMode` is the single entry point and checks `demoMode` first with the `demoData.ts:176` citation in a code comment; `dockerReachable` is documented as forbidden (D3) with the `demoData.ts:177` citation. Test 6 pins `{demoMode: true, healthMode: "docker"} → "demo"`. |
| R7 | **Stale claims survive a mode flip** — a `useMemo` computed under demo mode keeps returning `demo`-tagged claims after the user turns demo off, so sample data renders on a live screen (DM-09). | Every `useMemo`/`useCallback` producing claims lists `evidenceMode` in its dependency array; `evidenceMode` is re-resolved every render from current `settings` + `health`. Recorded in the checklist and as a pass-2 re-verification item. |
| R8 | **Epic #67 restyle collision** — a later design system wants tone/colour per kind and finds it hard-coded, or #71 pre-empts it by shipping tokens. | `EvidenceLabel` carries no presentational field (D5). A future kind→tone map lives in the design layer and keys off `kind`, which is exported for exactly that purpose. |
| R9 | **Test-fixture churn** from the required `AppContextValue` field touches 7 files in the same commit, and a reviewer waves it through. | The 7 files are enumerated in the checklist; each must pass the mode its fixture actually intends (`"live"` for the existing identity/collision tests, which all assert host-shaped behavior), never a copy-pasted `"demo"`. |
| R10 | **Scope creep into provenance** — `detail` on `unavailable` grows into a source/attribution field, or a `Claim` gains a timestamp/origin. | `detail` is a static human sentence, never interpolated data (DM-01). Any structured field on `Claim` beyond `kind`/`value`/`detail` belongs to epic #68 and is a pass-2 finding in this slice. |

## Resolved product questions (none left to implementer judgment)

| # | Question | Decision | Rationale |
| --- | --- | --- | --- |
| Q1 | Exact label wording for all five kinds | The 10 strings in D4, verbatim | Distinct, truthful, DM-06-safe; "guess" and "Not collected" chosen deliberately over "estimated"/"unknown" |
| Q2 | Are unlabelled claims a **type-level** or **runtime** error? | **Type-level is primary, runtime is the boundary backstop.** `Claim<T>` has no untagged constructor and `unavailable.value` is `null`, so an untagged or unnarrowed claim fails `npm run typecheck` (in `check:js`). `evidenceLabel` additionally throws on an unrecognized kind at runtime. | The web layer is fully typed and `typecheck` is a required gate, so the type is the real enforcement. The runtime throw covers the only hole — a kind cast from untyped JSON — and fails closed rather than printing a plausible label (G-01, G-24). |
| Q3 | Plain function or React component? | **Plain function in `apps/web/src/lib/evidence.ts`** (a `.ts` file, no React import) | Delta (c): text + kind only. `copilot.ts` and `model.ts` are plain modules and could not consume a component. Precedent: `identity.ts:45`. A component would also smuggle in styling that epic #67 owns. |
| Q4 | Demo-mode detection source | `resolveEvidenceMode({ demoMode: settings.demoMode, healthMode: health?.mode ?? null })`, called **once in `AppShell`**, distributed via `AppContext` | `isDemoMode()` (`settingsStore.ts:91`) fails open to `false` pre-hydration/SSR (`settingsStore.ts:39`, `:27`). `health.mode` alone cannot see demo (`demoData.ts:176`). `health.dockerReachable` is provably wrong in demo (`demoData.ts:177`). |
| Q5 | How is server-side `mock` classified? | **Its own `EvidenceMode` value**, authority `"sample"`; host-truth claims in mock mode take the `demo` kind or `unavailable` | Mock travels the live code path (`api.ts:50`), so gating on demo alone would let sample data render as observed — the exact defect the epic exists to fix. Classifying it `live` would be a lie; folding it into `demo` would erase the operator-visible distinction at `AppShell.tsx:198`. |
| Q6 | Does `mock` need a sixth `EvidenceKind`? | **No** | The issue fixes five kinds; a sixth fragments every consumer's exhaustive switch for a distinction that belongs to the mode, not the claim. `Sample data` is truthful for both demo and mock. |
| Q7 | Does the mode belong on `buildModel`, in module state, or in context? | **`AppContext`**, one required field, resolved once in `AppShell`. `buildModel`'s signature changes in #72, not here. | `AppContext` already reaches every screen (`context.tsx:16`); module state repeats the fail-open defect; widening `buildModel` with an unused parameter ships untested surface area. |
| Q8 | Does `unavailable` carry a reason? | **Yes — required, non-empty `detail: string`**; `unavailable("")` throws | Forces each site to say *why* (replacing today's detached free-text hints) and prevents a bare `unavailable` from reading as an error state. |
| Q9 | Static literal or interpolated `detail`? | **Static literal only.** Never interpolate a snapshot value. | DM-01 secret redaction: snapshot strings can carry redaction artifacts or, in a future collector, unredacted content. A reason sentence never needs record data. |
| Q10 | Is the label rendered as a `Tag`, a `Panel.hint`, or inline? | **#71 does not decide per-surface presentation.** It binds only that the label must always be rendered (never suppressed) and that `description` is available for `title`/hint. | Presentation is per-surface and belongs to the consuming slices; visual treatment belongs to epic #67. |
| Q11 | Constructor naming for the `demo` kind | Kind value stays `"demo"` (per the issue); the constructor is `demoSample()` | Avoids reading as "am I in demo mode?" at the call site, and makes the review grep unambiguous. |
| Q12 | What happens to `STUB_NOTICE` / `STUB_CHANGES_NOTICE` / `estimated: true`? | **Untouched in #71.** #73 removes the resource pair, #74 removes the change pair, each in the same commit that tags its surfaces. | Deleting them here would leave surfaces with *no* qualifier between #71 and #73/#74 — strictly worse than today. Recorded under G-23. |
| Q13 | Label casing and length | Sentence case, no trailing punctuation on `label`, ≤ 32 chars, asserted by test | Fits `Tag` and `Panel.hint` without wrapping; consistent with existing `UNAVAILABLE_*` copy style (`identity.ts:11-42`). |
| Q14 | Does #71 re-tag any existing claim site? | **No.** It ships the module, the `AppContext` field, the `AppShell` pill re-derivation, and tests only. | Keeps the slice reversible and keeps each sibling's diff reviewable on its own. The pill re-derivation is the one exception, and it is required to avoid shipping two mode authorities (R5). |

## Arrested lessons

RECURRING entries first, then the remainder. Every entry from `register-generic.md` and `register-dockermap.md` is addressed.

### Named in the brief

**G-01 (schema-escape hatches — every schema-valid value must be tolerable to every consumer).** Arrested. The vocabulary's own "schema" is the two unions, and both are closed and exhaustive: `EvidenceKind` is backed by a `Record<EvidenceKind, EvidenceLabel>` (D5), so a new kind without strings is a compile error, and `EVIDENCE_KINDS` is asserted to equal the union (test 1). The escape hatch is a kind cast from untyped data — `evidenceLabel` **throws** there rather than returning a generic label (D5, test 5), so a bad value fails at the boundary instead of rendering a plausible lie. `resolveEvidenceMode` is total over its declared input *and* over unrecognized `RuntimeMode` values (test 6 includes a cast string), returning `null` rather than a mode. `claimAuthority` is total over `EvidenceMode | null` (test 7).

**G-19 (falsy/empty values need explicit fallbacks at EVERY render site).** Arrested, and this repo contains the live mechanism: `primitives.tsx:63` renders `{hint && <span …>}`, so an empty label silently disappears. Three defences: every `label` and `description` is asserted non-empty after `trim()` (test 2); `unavailable.value` is typed `null` so a numeric render cannot compile without narrowing (D6.2, test 10); and micro-render fixtures render all five kinds through `Panel.hint`, `Tag`, and `Metric` and assert the text is present, with an explicit assertion that an `unavailable` metric shows `Not collected` and not `0` (tests 11-12). Each sibling slice repeats the fixture on its own surfaces (D7).

**G-24 (fail CLOSED — missing authority blocks, never an invented lenient default).** Arrested at three points. (a) `resolveEvidenceMode` returns `null` when health has not arrived (`useDaemonHeartbeat.ts:11` starts `health` at `null`) instead of assuming a mode; `claimAuthority(null) === "none"`, so only `unavailable` is permitted during that window. (b) Live mode with no evidence source yields `unavailable`, never `demo` — there is no code path from `mode === "live"` to a sample kind, asserted over the whole mode domain (test 7). (c) `evidenceLabel` throws on an unknown kind rather than falling back. The design also removes the existing fail-open read: `isDemoMode()` returns `false` under SSR/pre-hydration (`settingsStore.ts:39`, `:27`) and is forbidden as an evidence input (D3.2).

**G-15 (regression tests must assert correct behavior RESUMES).** Arrested. Test 8 is explicit: the suite asserts `claimAuthority("live") === "host"` and that an `observed` claim renders `Observed`, not merely that demo data fails to leak. Tests 11-12 assert the label text is *present*, not that a wrong string is absent. Every sibling slice's regression must likewise prove the live surface still renders its real value, not just that the stub is gone — restated in the pass-2 checklist.

**G-23 (no superseded rules left in docs).** Arrested with a scheduled obligation. `stubs.ts:4-14` currently documents the superseded policy ("Every surface that renders this data marks it as estimated") — which is already false at `Home.tsx:167,177`, where the CPU bar carries no notice. #71 does not touch it (Q12), but this doc binds: **when #73 lands, the same commit must update `stubs.ts:4-14` and remove `STUB_NOTICE` (`stubs.ts:16`) and `ResourceSample.estimated` (`stubs.ts:26`); when #74 lands, the same commit must remove `STUB_CHANGES_NOTICE` (`stubs.ts:17`) and `ChangeEvent.estimated` (`stubs.ts:68`).** Pass 2 must grep this document for residual wording if any decision here changes, and each sibling review must grep `stubs.ts` for a header comment that no longer matches the code.

**DM-01 (AGENTS.md invariants).** Arrested by scope and by one concrete rule. This slice adds no provider, no endpoint, no shell invocation, no filesystem access, no write path, and no new fetch — `evidence.ts` is a pure module with no I/O, so the read-only-provider, bounded-discovery, loopback, and dry-run-compose invariants are untouched. The one invariant that actively binds is **secret redaction**: `unavailable(detail)` strings must be static literals and must never interpolate a snapshot value (Q9), because snapshot strings pass through daemon redaction and must not be re-emitted into UI copy paths. Enforced by review grep for a template literal inside an `unavailable(...)` call. The issue-resolution rule also binds the closing PR: evidence comment, recommendation, never auto-close.

**DM-06 (labels must not claim more than the data proves — this vocabulary IS the enforcement mechanism).** Arrested as the slice's whole purpose. Concretely: the five labels are worded so that each is defensible from its data (D4 rationale, including the deliberate choice of "guess" over "estimated" and the rejection of "Unavailable" to avoid collision with the `identity.ts` family); `derived` exists specifically so arithmetic over observation is not sold as observation; `Sample data` is chosen over `Demo` so it stays true in server-mock mode where the user chose nothing. The consumption map (D10) names, per site, the label each current overclaim will be replaced with — `ServiceDetail.tsx:100`'s flat `"No"` (which asserts "no update exists") and `Home.tsx:45`'s bare integer are the two clearest current violations.

**DM-09 (derived claim state re-validated on live refresh).** Arrested. `evidenceMode` is re-resolved on **every** `AppShell` render from the current `settings` and `health` — it is never memoized, never cached in a ref, and never stored in component state (D8.2). Any `useMemo`/`useCallback` producing claims must list `evidenceMode` in its dependency array (R7), which pass 2 re-verifies. The precedent is `useSystemModel.ts:23-30`, which already refuses to build a model from a mismatched generation and retains the previous one instead; the mode is a peer of that pinned tuple, and when #72 threads it into `buildModel`, it must enter the *same* generation-checked `useMemo` (`useSystemModel.ts:24-30`), not a second one.

### Remaining RECURRING entries

**G-02 (mock masks reality — verify library claims against installed source).** Partially applicable, arrested. No new library is introduced. The one library-behavior claim in this design is that `vitest` honours a per-file `// @vitest-environment jsdom` docblock and otherwise runs with no DOM — verified against the installed setup: `apps/web/vite.config.ts` declares no `test` block, `duplicate-list-keys.test.tsx:1` carries the docblock and drives `react-dom/client`, while `change-feed-identity.test.tsx:1` uses `renderToStaticMarkup` without one. The `evidence.test.ts` vocabulary tests need no DOM; `evidence-render.test.tsx` uses `renderToStaticMarkup` and therefore needs no docblock. Note for the siblings: `renderToStaticMarkup` is React's **SSR** renderer and is vacuous for the duplicate-key class (G-21) — any test in that class needs the jsdom client reconciler.

**G-06 (cohort-scoped numerators and denominators).** N/A — this slice computes no rates, no telemetry, and no per-cohort statistics.

**G-08 (fix sweeps introduce regressions — verify prior fixes are CORRECT, not just present).** Arrested prospectively. The consumption map (D10) is the checklist the sibling slices are verified against, and every one of them modifies code that carries earlier hardening fixes: `stubs.ts:93` (collision-safe `routeName`), `stubs.ts:111` (`identityText` normalization), `Home.tsx:147-149` and `Home.tsx:172-174` (the dual `byId`/`byName` link gate), `model.ts:345` (occurrence-safe `dependsOn`). Pass 2 and each sibling review must confirm those behaviors still hold after tagging — the `change-feed-identity`, `collision-identity`, `detail-identity`, and `mount-keys` suites are the guards, and they must keep passing with real assertions, not by fixture weakening.

**G-09 (never trust implementer-reported numbers).** Arrested procedurally: pass 2 re-runs `npm run check` itself and reads the actual test output; a PR-body claim of "5 labels, all distinct" is not evidence. The relevant counts here (5 kinds, 3 modes, 15 render assertions, 7 fixture files) are all independently greppable.

**G-12 (a committed visual baseline is not a gate until proven enforced).** N/A — no visual/screenshot baseline is added or regenerated. The micro-render fixtures assert on text content, not on images.

**G-14 (resolve architecture open questions before dispatching the implementer).** Arrested. This document has no "Open questions" section; the 14 entries in "Resolved product questions" carry an explicit decision plus rationale, including all four the brief named (exact wording Q1, type-vs-runtime Q2, function-vs-component Q3, demo detection Q4) plus the mock classification (Q5) that the deltas required. The implementer makes zero product calls. If pass 2 finds a genuine gap, it is resolved in pass 2 — not deferred to the implementer.

**G-25 (structural mutations are not idempotent).** N/A — no mutation, no retry, no external write. `evidence.ts` is pure.

**G-26 (multi-step transactions must pin all derived inputs at start).** Arrested. `evidenceMode` is resolved **once** per render from a pinned input pair and passed down, rather than each claim site re-reading `settings`/`health` at its own moment (D3.2, D8). This is the same discipline `useSystemModel.ts:23-30` already applies to the snapshot/runtime-map pair; when #72 threads the mode into `buildModel`, it must be captured in that same generation-checked memo so a mode flip mid-refresh cannot label a model built from the other mode's data.

**G-27 (async API contracts — nothing null, nothing forever-pending).** N/A — every function in `evidence.ts` is synchronous and pure. The one `null` in the design is a deliberate domain value (`resolveEvidenceMode` returning "authority not established"), not a promise result, and its consumer `claimAuthority` handles it totally.

**DM-02 (e2e harness quirks) — N/A for this slice.** #71 adds no rendered surface and no new control, so no Playwright work is planned; validation is `npm run check` plus the two new vitest files. The quirk list becomes binding for #72-#76, each of which touches a real screen: assert on real mock output text, avoid `networkidle` (the SSE heartbeat at `useDaemonHeartbeat.ts:24` never settles it), give every new control a unique class, handle query params at the route boundary, and re-grep route registrations after patches.

**DM-04 (Rust/clippy conventions) — N/A.** Pure web slice; no file under `crates/` changes. `npm run check` still runs `check:rust` (root `package.json:23`) and must stay green, which for this slice means unchanged.

**DM-05 (empty schema-valid identities stay VISIBLE but NON-ROUTABLE).** Arrested by separation. The evidence vocabulary is deliberately lexically distinct from the `UNAVAILABLE_*` identity family (`identity.ts:11-42`) — `Not collected` versus `Unavailable service name` — because they mean different things: DM-05 is "we observed this record and the field is empty", while `unavailable` is "we did not collect this at all". A claim may be `observed` with a DM-05 empty-identity fallback inside it; the two compose and must not be merged. No evidence label is ever routable, and no `Claim` value enters a routing map.

**DM-08 (a fix must close EVERY consumer of the invariant).** Arrested. The verified-current-state table enumerates all 12 current claim sites across 6 files, and D10 assigns every one to a slice — including the two easily-missed ones: the Home per-service CPU bar (`Home.tsx:167,177`), which has **no** qualifier today while the ServiceDetail panel does, and the causal chain (`Home.tsx:126`), whose "Causal chain" hint is a title rather than a provenance claim. #76 exists to sweep residuals, and its truthfulness matrix is the completeness proof. Pass 2 must re-run the greps (`updateAvailable`, `resourceFor`, `changeFeed`, `causalChain`, `STUB_`) and confirm the site list is still complete against the branch HEAD.

**DM-03 (live-Docker evidence is the release gate) — N/A for this slice.** No daemon, API, or artifact change, so `npm run test:live-docker` is not required for #71. It becomes relevant for any sibling that changes what a live host renders — #73 and #74 in particular should record a live-mode spot check.

**DM-07 (diff-scoped review must trace the MODEL/HOOK layer; re-certify after the branch moves).** Arrested. This design deliberately reaches into the hook/context layer rather than stopping at screens: `context.tsx:5-12`, `AppShell.tsx:121,124,146,155-162`, and (for #72) `useSystemModel.ts:24-30` are all named as review targets. Pass 2 must verify the `AppContext` field is required and that the pill at `AppShell.tsx:146` is re-derived rather than duplicated — a screen-only review would miss both. A no-findings certification is valid only for the exact HEAD reviewed.

**DM-10 (release-artifact CI gap) — N/A.** No Dockerfile, build step, deploy bundle, or lockfile-layout change. The new module is bundled by the existing `npm run build` and exercised by `npm run test:js`, both already in `check:js`.

### Remaining generic entries (no applicable surface in this slice)

G-03 (mock-path e2e assertion text) — N/A, no e2e in #71; binding for #72-#76 alongside DM-02. G-04, G-05, G-07, G-10, G-11, G-13, G-16, G-17, G-18 — N/A: no balance/tradeoff model, no score saturation, no round-robin allocation, no selector tags, no RNG seeding, no visual matrix, no derived-artifact cache, no pixel-size rendering gate, and no criterion that can be met merely nominally (the acceptance criterion is discharged by a total function with an exhaustive truth table, not by inspection). G-20 (occurrence-indexed joins) — N/A, no correlation join; the existing occurrence discipline in `model.ts:326-330` is untouched. G-21 (collision-proof React keys) — N/A, this slice renders no list; note for siblings that `renderToStaticMarkup` cannot see duplicate-key defects (G-02). G-22 (accessible names entity-qualified) — N/A for #71 (no interactive control added); binding for any sibling that adds a control, and note that an evidence label placed only in a `title` attribute is not an accessible name. G-28 (guard-flag ownership), G-29 (foreground flows await freshness), G-30 (blank env values), G-31 (low-entropy secrets), G-32 (read paths settle journals), G-33 (write verification enforced), G-34 (retry classification), G-35 (cleanup removes only what it recreates) — N/A: no shared mutable flag, no async freshness promise, no env parsing, no secret comparison, no transaction journal, no write path, no retry policy, and no cleanup step in this slice.

## Implementation checklist

Ordered, smallest reversible commits. Each step should leave `npm run check` green.

1. **Create `apps/web/src/lib/evidence.ts`** with, in this order: the file-header comment (one line noting that richer provenance lands in a later epic, per the issue's scope note); `EvidenceKind`; `EVIDENCE_KINDS`; `EvidenceLabel`; the `Record<EvidenceKind, EvidenceLabel>` constant with the 10 strings from D4 verbatim; `evidenceLabel()` (throws on unknown kind); `EvidenceMode`; `EvidenceModeInput`; `resolveEvidenceMode()` (demo checked first, with the `demoData.ts:176` reason in a comment); `ClaimAuthority`; `claimAuthority()`; `Claim<T>`; the five constructors. No React import. No import from `settingsStore`. Type-only import of `RuntimeMode` from `@dockermap/contracts`.
2. **Add `apps/web/src/lib/evidence.test.ts`** — tests 1-10 from D7. Confirm `npm run test:web` runs it and that test 10's `@ts-expect-error` is exercised by `npm run typecheck`.
3. **Add `apps/web/src/lib/evidence-render.test.tsx`** — tests 11-12 (five kinds × `Panel`/`Tag`/`Metric`, plus the `unavailable`-is-not-`0` assertion), using `renderToStaticMarkup` per `change-feed-identity.test.tsx:1`. No environment docblock needed.
4. **Add `evidenceMode: EvidenceMode | null` to `AppContextValue`** (`apps/web/src/context.tsx:5-12`) as a **required** field. Typecheck will now fail in 8 places — that is expected and is the point.
5. **Populate it in `AppShell`**: compute `resolveEvidenceMode({ demoMode: settings.demoMode, healthMode: health?.mode ?? null })` and add it to `ctx` (`AppShell.tsx:155-162`).
6. **Re-derive the mode pill from the resolved value**, replacing the standalone expression at `AppShell.tsx:146`. Display strings stay in `AppShell` (`"demo" → "Demo"`, `"live" → "Docker"`, `"mock" → "Mock"`, `null → "Unknown"` (per pass-2 amendment 1 — never "Mock"; genuine mock keeps "Mock")); the *classification* comes only from `resolveEvidenceMode`. Confirm `AppShell.tsx:198` still renders `{mode} Engine` unchanged.
7. **Update the 7 test fixtures** that construct `AppContextValue` — `change-feed-identity.test.tsx`, `collision-graph-runtime.test.tsx`, `collision-identity.test.tsx`, `detail-identity.test.tsx`, `diagnostics-tone.test.tsx`, `duplicate-list-keys.test.tsx`, `mount-keys.test.tsx` (all in `apps/web/src/screens/`). Each passes the mode its fixture actually intends — `"live"` for all seven, since every one asserts host-shaped identity/collision behavior. Do not copy-paste `"demo"`, and do not weaken any existing assertion.
8. **Run `npm run check`.** Record exact results. If `check:rust` is slow or unavailable, state that explicitly rather than skipping silently; `check:js` is the mandatory subset for this slice.
9. **Self-review greps before opening the PR**: `grep -rn 'Observed\|Derived\|Inferred\|Sample data\|Not collected' apps/web/src --include=*.ts --include=*.tsx` returns hits only in `evidence.ts` and the two test files (R1); `grep -rn 'isDemoMode' apps/web/src` shows no new call sites (D3.2); `grep -rn '?? "observed"\|?? "live"\|kind = ' apps/web/src` is empty (R4); no template literal appears inside an `unavailable(` call (DM-01/Q9).
10. **PR body** states: no public-contract change, no styling, no claim site re-tagged, and the D10 consumption map as the handoff to #72-#76. Closing comment uses the `## Resolution Evidence` format from `AGENTS.md:61-71` and recommends — never performs — closure.

### What pass 2 must re-verify

1. All file:line citations in "Verified current state" against the branch HEAD — especially `AppShell.tsx:146`, `demoData.ts:176-177`, `api.ts:30`, `apps/api/src/index.ts:469`, and `primitives.tsx:63`, which carry the load-bearing findings.
2. That `resolveEvidenceMode` checks `demoMode` **before** `healthMode`, and that no code reads `health.dockerReachable` for evidence (R6).
3. That `AppContextValue.evidenceMode` is **required**, not optional, and that no `?? "live"`-shaped fallback exists anywhere (R4, D8.5).
4. That `AppShell.tsx:146`'s original expression was **replaced**, not left duplicated alongside the resolver (R5).
5. That `evidenceLabel` throws rather than falling back, and that no kind's `label` or `description` can be empty (G-01, G-19).
6. That the micro-render fixtures cover all five kinds on all three primitives, and that the `unavailable`-is-not-`0` assertion is present and real (R3).
7. That the suite asserts live behavior **resumes** — not only that demo does not leak (G-15, test 8).
8. That the 7 fixture updates weakened no existing assertion (R9, G-08), and that the identity/collision suites still pass on their real assertions.
9. That `stubs.ts` (`:4-17`, `:26`, `:68`) is untouched by this slice, and that the G-23 obligation for #73/#74 is carried into those briefs verbatim.
10. That nothing in `packages/contracts/` or `crates/` changed, and that `Claim` gained no field beyond `kind`/`value`/`detail` (R10, epic #68 boundary).
11. Actual `npm run check` output, re-run by the reviewer — not the PR body's claim (G-09).
12. Whether the GitHub issue #71 body matches `/tmp/dm61-child-1.md`, which this pass could not confirm (see "Could not verify").

## Architect pass 2

### Re-verification summary
- AppShell.tsx:146 — CONFIRMED. Note the ternary's structure: `health?.mode === "docker"` is false when `health` is undefined/null, so today **loading/error/unreachable renders "Mock Engine"**. This interpretive fact is load-bearing below.
- AppShell.tsx:198 — CONFIRMED (badge is the sole render site of `mode`).
- dockermap.spec.ts:29 (`Mock Engine|Docker Engine`), :507 (`Docker Engine`) — CONFIRMED. Consequence: :29 can pass **vacuously during loading** today, because null already renders "Mock".
- primitives.tsx:63 `{hint && ...}` — CONFIRMED (falsy-hint pattern exists in the codebase; relevant to any label rendered the same way).
- api.ts:30 demo short-circuit before fetch — CONFIRMED; consistent with demo-first ordering in resolveEvidenceMode.
- demoData.ts:176-177 reason string — CONFIRMED; single-sourcing it into EvidenceMode is correct, no duplicate string introduced.
- model.ts:251 (no mode param), :321 (hash-fabricated `updateAvailable`) — CONFIRMED; this slice classifies nothing in model.ts, which is consistent with vocabulary-only scope (bindings deferred).
- context.tsx:5-12 — CONFIRMED; `evidenceMode` as a REQUIRED (nullable) field is the right choice — optional would re-introduce silent absence.
- index.ts:49,447,469 + main.rs:339 — CONFIRMED: mock travels the real HTTP path, so `health.mode === "mock"` is genuinely distinguishable from null. This means pass-1's null->"Mock" mapping is **not** forced by any ambiguity in the data.
- 7 fixtures constructing AppContextValue — CONFIRMED; "typecheck fails in 8 places — intended" is coherent (7 fixtures + provider site).

### Findings
1. **P1 — null -> "Mock" display mapping is a silent fallback and re-encodes the exact defect class this slice exists to kill.** Pass-1 maps null -> "Mock" explicitly "to preserve today's rendering." Today's rendering is a mislabel: when health is unresolved (loading), failed, or the daemon is unreachable, the badge says "Mock Engine" although no mock data is being served. The design itself defines the correct tool — the `unavailable` kind / "Not collected" — and then declines to use it at the one site where the mode is genuinely unknown. The citations prove mock is distinguishable from null (real HTTP path, main.rs:339), so there is no ambiguity forcing this. **Amendment (binding):** null maps to an explicit unknown state — e.g. badge "Connecting…" / "Unknown Engine", or route through the unavailable kind — never "Mock". Genuine mock (health.mode === "mock") keeps "Mock". DM-06 label truthfulness is otherwise fine ("Sample data", "Not collected" are honest; the identity-family separation from identity.ts:11-42 is correct and deliberate).
2. **P2 — G-15 "live-resumes" assertion via renderToStaticMarkup cannot observe a transition.** Static markup is one-shot; rendering twice with different inputs proves purity of resolveEvidenceMode, not resumption of a mounted component. **Amendment:** either (a) derive evidenceMode inline in the AppShell render body (per-render, no memo) and assert purity of resolveEvidenceMode in evidence.test.ts, or (b) use a rerender-capable renderer for the mock->live transition. Option (a) is simpler and preferred.
3. **P2 — DM-09 re-derivation mechanism is unspecified.** "Populated in AppShell from resolveEvidenceMode(...)" does not pin whether this is inline per-render or memoized. If useMemo, deps MUST be exactly `[settings.demoMode, health?.mode]`; a stale memo re-introduces the stuck-label failure under refresh. Make the choice explicit in the doc (inline derivation recommended; inputs are cheap).
4. **P2 — G-19 coverage is claimed but only partially closed.** The compile-error arm prevents rendering unavailable **as 0**; it does not prevent rendering unavailable **as nothing**. If any consumer renders `{value && ...}` / `{hint && ...}` (pattern exists, primitives.tsx:63), a null value or empty label vanishes silently. **Amendment (binding):** the unavailable arm MUST render its "Not collected" label in Metric/Panel/Tag, and evidence-render.test.tsx must assert non-empty label text for all five kinds — not merely that renderToStaticMarkup doesn't throw.
5. **P3 — the compile-error unavailable arm is real, with two contingencies.** The @ts-expect-error test is self-checking (an unused directive is itself a typecheck error), so the invariant holds **provided** (a) apps/web has strictNullChecks on and (b) `tsc --noEmit` covers evidence.test.ts, not only src. Implementer must verify both; if (a) is off, the entire "inexpressible" claim degrades to runtime-null.
6. **P3 — register honesty spot-checks.** G-03 N/A: honest (no e2e this slice; deferral to #72-#76 carries binding DM-02/G-03 notes). G-01: genuinely covered — closed union, exhaustive Record, throwing lookup, type-only contracts import, zero schema surface. G-19: claimed covered — downgrade to partial per finding 4. No other N/A entries contradict the citations.
7. **P3 — evidenceLabel() throwing on unknown kind is acceptable defense-in-depth** (unreachable for typed callers given the exhaustive Record). Keep the throw test; no error-boundary requirement for this slice.

### E2E/test-plan amendments
- Required by finding 1: after the null-display fix, re-verify dockermap.spec.ts:29. It currently passes vacuously during loading; post-fix it will only pass once health actually resolves to mock. Playwright's auto-waiting toBeVisible should absorb this against the mock fixture; if it flakes, the test was vacuous and needs an explicit wait on the resolved badge. :507 unaffected (docker fixture resolves to live).
- Required by finding 2: add a rerender-based (or purity + inline-derivation) G-15 test; do not ship the static-markup version as the sole live-resumes evidence.
- Required by finding 4: render test asserts visible "Not collected" text for the unavailable kind across Panel/Tag/Metric.

### Verdict
sound-with-amendments — the vocabulary core (closed union, no default kind, required context field, compile-error unavailable arm, demo-first resolution) is sound and matches every confirmed citation. The null->"Mock" mapping (finding 1) must be amended pre-merge; findings 2-4 are binding test/mechanism corrections.