# Architecture pass 1: Docker inventory detail pages (#34)

Status: implementation-ready architecture for Architect pass 2 review. This document is the binding scope for the implementer; deviation from an arrested lesson is a P1 finding.

## Goal and non-goals

Add first-class network, volume, and image detail routes that follow `ServiceDetail.tsx`, are reachable from every current inventory surface, and work from the already-published snapshot in mock and live modes.

This slice is read-only. It does not add daemon/API endpoints, Docker inspection calls, write behavior, speculative metrics, or metadata absent from the snapshot (labels, network options/IPAM, volume driver/options/mountpoint, image digest/ID/size/history/created time).

## Verified current state

- `apps/web/src/App.tsx:38-54` has `/services/:name` plus the three list routes, but no network, volume, or image detail route.
- `apps/web/src/screens/ServiceDetail.tsx:22-45` establishes route-param lookup and loading/error/not-found behavior; lines 49-102 establish the detail header, impact band, tabs, and panels; lines 135-153 establish linked relationship rows; lines 199-265 establish configuration and an explicit internals reveal.
- `packages/contracts/src/index.ts:43-61` is the complete browser contract for this slice: image `{ image, containers, status }`, network `{ id, name, driver, internal, members }`, and volume `{ id, name, attachedTo }`. `DockerSnapshot` carries all four inventory collections at lines 63-69.
- `apps/web/src/hooks/useSystemModel.ts:12-25` already fetches `/api/snapshot` and `/api/runtime/map` once per refresh tick and builds the shared model. `apps/web/src/lib/model.ts:211-273` currently preserves networks and volumes but drops `snapshot.images`.
- The list surfaces are `Networking.tsx:22-49`, `Storage.tsx:40-71`, and `Images.tsx:57-82`. Images currently makes a second `/api/images` request at `Images.tsx:8-17`; networking and storage use the shared model.
- Existing cross-links use `encodeURIComponent` before putting a name in a path (for example `ServiceDetail.tsx:145-147` and `Map.tsx:122-124`).
- `Runtime.tsx:70-72` currently matches a runtime node to a Docker service by label, not runtime node ID. Its selected runtime nodes and relationships are rendered at lines 161-307.
- The mock-stack navigation test is `tests/e2e/dockermap.spec.ts:24-69`; the live fixture assertions are in the same file at lines 71-203. The harness has a persistent SSE/heartbeat, so tests already rely on explicit locator assertions rather than `networkidle`.

## Decisions

### 1. Route scheme and identity

Add these sibling routes inside `AppShell` in `apps/web/src/App.tsx`:

| Entity | Route | Param source | Lookup |
| --- | --- | --- | --- |
| Network | `/networks/:name` | `NetworkRecord.name` | exact `network.name === name` |
| Volume | `/volumes/:name` | `VolumeRecord.name` | exact `volume.name === name` |
| Image | `/images/:image` | full `ImageRecord.image` reference | exact `image.image === image` |

All route builders must use `encodeURIComponent` on the exact snapshot value. React Router supplies the decoded param to `useParams`; screens must not manually decode it a second time.

Installed-library proof: `react-router-dom@7.18.2` (the locked workspace version) was exercised with `matchRoutes`; `/images/ghcr.io%2Facme%2Fapp%3A1.2` matches `/images/:image` and yields `{ image: "ghcr.io/acme/app:1.2" }`. Keep the browser e2e below so this behavior remains proved at the real router boundary.

Rationale:

- Network IDs are opaque Docker IDs in live mode (`main.rs:869-883`), while the issue and current UI expose names. Docker network names are the operator-facing key and Docker requires them to be unique on one engine.
- A live `VolumeRecord.id` is deliberately equal to its name (`main.rs:887-901`), so a separate ID route adds no stability.
- `ImageRecord` has no daemon image ID or digest field (`packages/contracts/src/index.ts:43-47`); the full image reference is the only lossless lookup key. Do not call the param `id` or route by tag alone. A reference can contain registry paths, ports, tags, or digests, making `encodeURIComponent` mandatory.
- Runtime topology IDs are not route identities. `derive_runtime_map` turns raw snapshot IDs into `docker_container_<slug+hash>`, `docker_network_<slug+hash>`, and `docker_volume_<slug+hash>` (`crates/dockermap-core/src/lib.rs:1255-1285,1322-1357`). No UI route may parse, trim, or reconstruct a snapshot key from one of those IDs.

Renames naturally invalidate an old name/reference URL. The resulting detail screen shows a not-found state against the current snapshot and offers a link back to the corresponding list; it must not guess a fuzzy replacement or silently select a similarly named record.

### 2. Screen structure

Create one explicit screen per entity:

- `apps/web/src/screens/NetworkDetail.tsx`
- `apps/web/src/screens/VolumeDetail.tsx`
- `apps/web/src/screens/ImageDetail.tsx`

Do not introduce a schema-driven generic `DetailScreen`. The records have different relationships and configuration semantics, and this repository uses explicit screens. Share only a small presentational helper if duplication is exact (for example a `ConnectedServices` list); do not hide entity lookup, empty/error copy, or field selection behind a generic schema.

Each screen follows the established service-detail anatomy:

1. `useParams` and `useApp` at the top.
2. Exact record lookup with `useMemo` (or an indexed model map; see data flow).
3. `Loading` when `loading && !model`.
4. entity-specific `ErrorState` only when `error && !model`, preserving a stale model if one exists.
5. entity-specific `EmptyState` when the current model has no exact match, with a `primary-link` back to `/networking`, `/storage`, or `/images`.
6. `.screen`, `.screen-head.detail-head`, `.detail-id`, `.eyebrow`, and `.screen-title` for consistent and accessible layout.
7. A compact `.impact-band.wide` for truthful counts from the current record.
8. Explicit `Panel`, `KeyValue`, `Tag`, `.svc-list`/`.svc-row`, `.muted-line`, and existing state classes. Prefer a simple Overview/Configuration layout over five empty tabs; tabs are warranted only if each has real content.

Relationship entries are links only when `model.byName` resolves the recorded container name. An unresolved recorded name remains visible as plain text with unknown state; never drop evidence just because cross-resolution failed.

### 3. Data flow and model contract

Use the existing shared snapshot fetch. Do not add a screen-local fetch and do not use the daemon list endpoints as pseudo-detail endpoints.

Extend `SystemModel` in `apps/web/src/lib/model.ts` to retain `images: ImageRecord[]`. Add exact lookup maps to make route and runtime wiring unambiguous:

- `networkByName: Map<string, NetworkRecord>`
- `volumeByName: Map<string, VolumeRecord>`
- `imageByRef: Map<string, ImageRecord>`

Build these directly from `snapshot.networks`, `snapshot.volumes`, and `snapshot.images` in `buildModel`. Preserve the arrays as well for existing list iteration. This is a web-domain-model change only; the TypeScript/Rust wire contracts do not need new fields.

Migrate `Images.tsx` from its separate `/api/images` `useApiResource` call to `model.images` and the shared `loading/error` state, matching Networking and Storage. This ensures list and detail resolve against the same snapshot generation and avoids a list row navigating to a detail view whose independent request sees a different refresh.

The shared model is already replaced atomically after both snapshot and runtime-map data are present (`useSystemModel.ts:14-20`). During refresh, keep rendering the last model as existing screens do. If an entity disappears or is renamed in a later snapshot, the open detail route changes to the not-found state; do not retain a stale entity object separately.

### 4. Display fields and relationship derivation

All labels below are from the published snapshot; no values are fabricated.

#### Network detail

- Header/title: `name`; eyebrow `Docker network`; tags for `driver` and `internal`/`externally reachable` (the latter is UI wording for `internal === false`, not a reachability probe).
- Impact band: `members.length`, resolved members, unresolved members, and internal yes/no.
- Overview panel: name, driver, internal yes/no, connected-container count.
- Connected containers panel: every `members` entry, resolved through `model.byName`, linked to `/services/:name` with `StateDot`; unresolved entries remain plain text.
- Configuration/internals panel: network ID behind the same show/hide interaction used by `ServiceDetail`; driver and internal flag may remain visible in Overview.
- Edges: the membership list is the authoritative connected-container relation. It is populated from each live container's network IDs (`main.rs:797-813`) and attached to `NetworkRecord.members` (`main.rs:869-883`). Runtime `connected_to` edges are a derived duplicate, not a second source of truth (`lib.rs:1273-1285`).

#### Volume detail

- Header/title: `name`; eyebrow `Docker volume`; tag `in use` or `idle`.
- Impact band: `attachedTo.length`, resolved consumers, read-only matched mounts, and read-write matched mounts.
- Overview panel: name, consumer count, use state.
- Connected containers panel: every `attachedTo` entry linked when resolvable.
- Mount configuration panel: for each resolved consumer, derive matching `service.mounts` where `kind === "named_volume"` and `source === volume.name || source === volume.id`; show service link, target, and read-only/read-write status. If the summary says attached but no mount detail matches, retain the consumer and show “Mount details unavailable in this snapshot” rather than claiming a mode/target.
- Internals panel: volume ID behind show/hide.
- Edges: `attachedTo` is populated from live container mount names (`main.rs:815-823,887-901`). Runtime `mounts` edges are derived from that same list (`lib.rs:1359-1377`) and add no fields.

#### Image detail

- Header/title: the full `image` reference in monospace; eyebrow `Docker image`; status tag from `status` without mapping it to health unless an existing status mapper is explicitly used.
- Impact band: `containers.length`, resolved consumers, unresolved consumers, and distinct resolved service states.
- Overview panel: image reference, raw aggregate status, consumer count.
- Connected containers panel: every `containers` entry linked when resolvable, with service state and role/status already available on the model.
- Configuration/internals panel: exact image reference and raw status; do not claim digest, local image ID, tag freshness, size, creation date, layers, or update availability. The current service `updateAvailable` value is stub-derived (`model.ts:236-255`) and must not appear as real image metadata.
- Edges: `derive_images` groups the snapshot containers by exact image string; `ImageRecord.containers` is sufficient for image-to-container usage. No image node exists in `RuntimeMap`, so do not manufacture one.

#### Redaction boundary

Do not add client-side secret detection and do not display raw Docker/Compose objects. The daemon clones and redacts the complete snapshot at publication (`main.rs:4099-4126`), including image references/status/container names, network IDs/names/driver/members, volume IDs/names/consumers, and every container mount source/target (`main.rs:4129-4144`). Detail screens consume only those published strings.

Potentially sensitive implementation details (Docker IDs, mount sources/targets, exact image reference) use the established explicit internals/configuration treatment. Redaction is still mandatory even behind the reveal: hiding is not a security boundary.

### 5. Navigation wiring

#### Inventory lists (acceptance-critical)

- `Networking.tsx`: make each panel title an entity link to `/networks/${encodeURIComponent(net.name)}` and add an `Open detail` panel action if needed for an unambiguous accessible name. Do not wrap the whole `Panel` in a link because it contains nested service links.
- `Storage.tsx`: make each panel title an entity link to `/volumes/${encodeURIComponent(vol.name)}` with the same accessible action pattern. Preserve nested service links and filtering.
- `Images.tsx`: make the image name in each `.image-row` a link to `/images/${encodeURIComponent(img.image)}`. Keep the consumer chips as independent service links. The image link must have a distinct class/accessibility target so Playwright strict mode is deterministic.

Every rendered entity item therefore has one obvious detail link without invalid nested interactive content.

#### Map and service detail

- `Map.tsx`: turn the selected service's image value into an image detail link; add linked network chips from `selected.networks`; add linked named-volume chips from `selected.mounts` where a source resolves in `model.volumeByName`. Keep the existing primary service-detail link.
- `ServiceDetail.tsx`: link the Overview image value to image detail; link configuration network tags; link named-volume mount sources when they resolve. This is the coherent return path from a container detail to the new inventory details.

#### Runtime

Replace the service-only `selectedDetailUrl` heuristic in `Runtime.tsx:70-72` with an explicit resolver:

- Docker `container`: resolve `selected.label` in `model.byName` and route by the resolved service name.
- Docker `docker_network`: resolve `selected.label` in `model.networkByName` and route by the resolved network name.
- Docker `docker_volume`: resolve `selected.label` in `model.volumeByName` and route by the resolved volume name.
- A selected Docker container whose `metadata.image` is a string resolving in `model.imageByRef` gets a separate image-detail link.
- Other providers/types receive no Docker detail link.

Never use `selected.id` to construct these URLs. Gate links on successful snapshot lookup so provider nodes with coincidentally equal labels cannot navigate to unrelated Docker records. Remove the current duplicate pair of service links (`Runtime.tsx:238-242` and `300-304`) in favor of one entity-specific primary link plus the optional image link.

### 6. E2E and verification plan

Extend `test("navigates every space against the daemon fallback")` in `tests/e2e/dockermap.spec.ts:24-69`; do not create a second mock stack for the same flow.

Mock assertions, using actual mock snapshot values from `mock_snapshot` (`crates/dockermap-core/src/lib.rs:951-1100`):

1. Open Networking, click the accessible `application` network detail link, assert URL `/networks/application`, heading `application`, driver `bridge`, and connected services `gateway`, `api`, and `worker`; follow one service link and assert its service detail.
2. Return to Storage, click `postgres_data`, assert `/volumes/postgres_data`, heading, consumer `postgres`, mount target `/var/lib/postgresql/data`, and read/write label from the real mock mount.
3. Return to Images, click `python:3.11-slim`, assert the encoded image route resolves, heading/reference, and consumers `api` and `worker`.
4. Open Runtime, select a Docker network and volume node by accessible text/type and assert the entity-specific detail link navigates to the same detail routes. Do not select by generated runtime ID.
5. Open Map, select `postgres`, follow linked image/network/volume chips and assert their detail headings.
6. Directly visit non-existent encoded routes for each type and assert entity-specific not-found copy plus the back-to-list link. The image case must include an encoded slash, for example `ghcr.io/example/missing:tag`, to prove segment decoding through the browser router.

Use the real mock names/targets, `page.goto(..., { waitUntil: "domcontentloaded" })` only when direct navigation is needed, and explicit role/class waits. Do not use `networkidle`, invented mock text, broad duplicate locators, or generated runtime IDs.

Extend the existing `@live-docker` test after its current Networking/Storage assertions:

- Read network, volume, and image keys from the already-fetched live snapshot rather than hard-coding generated IDs.
- Click one row from each list and assert the detail heading, at least one fixture container relation, and a known existing field (`driver`, mount target, image status/reference).
- For the busybox image shared by fixture containers, assert the detail route uses the exact snapshot `image` string.
- This turns “works live” into a navigation verdict, not just list text presence.

Implementation gates, in order: `npm run check`, `npm run test:e2e`, `npm run test:live-docker`. Because no daemon code is planned, no Rust-specific change gate is added beyond what `npm run check` already runs. Capture exact failures rather than weakening assertions.

### 7. Daemon-data gap verdict and diff scope

**Verdict: no daemon-data gap for issue #34's accepted detail views. Do not change Rust, Express routes, OpenAPI, or wire contracts.**

Proof:

- Network metadata and connected containers are in `NetworkRecord` and live collection (`contracts:49-55`; `main.rs:797-813,869-883`).
- Volume identity/consumers are in `VolumeRecord`; per-container named-volume source, target, and read-only flag are in `ContainerMount` (`contracts:35-41,57-61`; `main.rs:815-825,887-901,917-955`).
- Image identity/status/consumers are in `ImageRecord` (`contracts:43-47`) and are already exposed on `/api/snapshot` and `/api/images`.
- Runtime network and volume edges are derived from those same snapshot fields (`lib.rs:1273-1285,1359-1377`); they do not prove missing daemon data.
- All strings cross the existing redaction boundary before publication (`main.rs:4099-4144`).

There is a real *richness limitation*—the snapshot does not carry Docker labels/options/IPAM, volume driver/options/mountpoint, or image ID/digest/size/history—but none is required to render metadata, current connections, and the available redacted configuration. Architect pass 2 must reject scope expansion presented as a “detail endpoint” unless acceptance is changed and a concrete missing required field is named with collector and contract evidence.

Expected implementation diff is limited to web routes/screens/model/styles/tests (and imports). A contracts edit is unnecessary unless TypeScript reveals an existing mismatch; no new contract field is authorized by this plan.

## Risks and mitigations

1. **Encoded image references:** registry paths, ports, and digests contain reserved characters. Always build URLs with `encodeURIComponent`, look up the decoded param exactly, and include a slash-containing mock/live assertion. Do not split on `/`, `:`, or `@` for identity.
2. **Runtime ID mismatch:** runtime IDs are collision-resistant slug+hash derivations, not raw snapshot IDs. Resolve by provider + node type + exact label against snapshot indexes; never trim prefixes or hashes.
3. **Snapshot staleness/rename:** a route may become invalid at the next heartbeat. Preserve the prior model only during fetch; once the new model lands, show not found rather than stale details or a fuzzy match.
4. **Cross-record inconsistency:** `members`/`attachedTo`/`containers` can name an entity filtered out or renamed. Keep unresolved evidence visible and mark state/details unavailable.
5. **Nested links:** list cards and rows already contain service links. Link titles/actions rather than wrapping a whole card/row in an anchor.
6. **Redaction misunderstanding:** reveal controls are UX, not security. Render only published model values; never fetch/serialize a raw Docker object or bypass daemon publication redaction.
7. **Misleading derived claims:** `internal: false` is not proof of external reachability, image status is not per-service health, and stub update availability is not image freshness. Use literal, qualified labels.
8. **Duplicate fetch generations:** retaining the current Images `/api/images` fetch would allow list/detail skew. Move Images to `model.images` before adding its detail navigation.
9. **E2E strict mode/SSE:** unique link classes or accessible names and explicit waits are required; `networkidle` will hang.
10. **CSS/a11y drift:** use established classes and semantic headings/lists/links. New controls need type, visible focus behavior, and unique accessible names; color must not carry state alone.

## Resolved product questions (none left to implementer judgment)

- Names are the route keys for networks and volumes; the exact full reference is the route key for images.
- Three explicit screens, not a generic schema renderer.
- One shared snapshot generation powers lists and details.
- Current snapshot fields define the display ceiling; no daemon enrichment in this slice.
- Inventory lists, Map, Runtime, and ServiceDetail all receive coherent links.
- Not-found is the correct renamed/deleted behavior; no aliases/fuzzy redirects.
- Existing mock and live tests are extended; acceptance is navigation plus field/relationship assertions, not screenshots.

## Arrested lessons

Recurring entries are listed first. Quoted arrest text is verbatim from the loaded registers; each disposition is binding.

### G-01: Spec-conformance is NOT sufficient — schema-escape hatches — Caught: 2× · RECURRING · reviewer-strength

> Architecture v2 review MUST lint the spec itself — for every schema field, every schema-valid value must be tolerable to every consumer (if a consumer needs min(1), the SOURCE schema carries it, not a downstream parse). Arg-parser contracts: test the smallest/zero/edge inputs, not just canonical N. "Valid content, wrong failure mode" (a bad value must fail at parse/load, never crash later at render/use).

Arrest: empty arrays render muted/empty relationship copy; empty strings remain renderable; unresolved container names remain visible; encoded reserved characters and missing records produce a not-found view rather than a crash. Architect pass 2 must inspect each schema-valid string/array edge.

### G-02: Mock masks reality — verify library claims against the installed source — Caught: 2× · RECURRING · reviewer-strength

> Any claim about library behavior must be verified against the INSTALLED library source (node_modules), never the mock. Check whether the mock filters/defends against states the real library does not (disconnected devices, short arrays, out-of-range indices, undefined fields); if so, the adapter has a production bug the suite can't see — write a regression fake matching REAL semantics.

Arrest: route-param decoding behavior must be verified with the installed `react-router-dom` through an encoded slash/reference e2e, not assumed from the mock fixture. Live navigation uses keys read from the real snapshot.

### G-06: Cohort-scoped numerators AND denominators — Caught: 2× · RECURRING · reviewer-strength

> Every per-cohort rate divides cohort fires by cohort campaigns; scoped counters make reliability honest; cross-cohort contamination stays visible via per-strategy hit rates + balanced gate.

N/A — no rates, cohorts, or aggregate denominators are introduced. Counts are direct lengths or explicitly scoped resolved/unresolved subsets of one record.

### G-08: Fix sweeps can introduce regressions — verify prior fixes are CORRECT, not just present — Caught: 2× · RECURRING · arch/impl blind spot

> Each fresh review round (a) gets prior findings verbatim, (b) verifies each fix at the anchored line, (c) re-runs the behavior the fix touched, (d) for restore-pre-PR-behavior fixes, DIFF against `git show main:path` and compare SEMANTICS, (e) adds a test locking the intended behavior.

Arrest: pass 2 and every fixer must preserve filtering, nested service links, stale-model loading/error behavior, and the existing service detail/command-palette routes. Review fixes at their anchored lines and rerun the affected navigation assertion plus the full required gates.

### G-09: Never trust implementer-reported balance/telemetry numbers — Caught: 2× · RECURRING · reviewer-strength

> Review briefs require re-running gates AND the batch/telemetry; citing the PR body is not evidence. Suspiciously perfect numbers are red flags, not clean results.

Arrest: reviewers rerun `npm run check`, `npm run test:e2e`, and `npm run test:live-docker`; implementer summaries are not evidence. UI counts are re-derived from the rendered snapshot in tests where asserted.

### G-12: A committed visual baseline is not a gate until proven enforced — Caught: 2× · RECURRING · arch/impl blind spot

> After regenerating ANY visual baseline, prove enforcement (invoke `compareImages` on old-vs-new, or intentionally break the matrix and watch the test fail) before treating it as a gate.

N/A — no visual baseline or screenshot gate is proposed. Functional DOM/a11y navigation assertions are the gate.

### G-14: Resolve architecture "Open questions" before dispatching the implementer — Caught: 2× · RECURRING · arch/impl blind spot

> Resolve each open question with an explicit product decision (rationale + test impact) in the implementer brief → zero-judgment-call implementation rounds.

Arrest: route identities, fields, lookup behavior, links, not-found behavior, data ceiling, and test assertions are resolved above. There are zero implementation open questions.

### DM-02: E2E harness quirks (each cost a real debug session) — Caught: 3× · RECURRING · arch/impl blind spot

> E2e designs must (a) assert on real mock output text, (b) avoid networkidle, (c) give every new control its own class, (d) handle query params at the route boundary, (e) after route-file patches, grep for duplicate/missing registrations.

Arrest: assertions use actual mock records/targets; direct loads use `domcontentloaded` plus explicit locators; new entity links have unique classes/accessible names. No query or API route is added. If an implementer nevertheless touches API routes, verify the route manifest and duplicate/missing registrations before review.

### DM-04: Rust/clippy conventions are enforced by the gate — Caught: 2× · RECURRING · arch/impl blind spot

> Rust contributions must assume fmt-then-clippy gate order and idiomatic contains/format usage; do not "fix" E0670.

N/A — daemon/Rust changes are explicitly out of scope. If pass 2 proves a daemon gap and changes scope, the plan must be revised before implementation and must put fmt-before-clippy/test in the implementer gate.

### G-03: Mock-path e2e assertions must use real mock output text — Caught: 1×

Arrest: mock assertions are named above from `mock_snapshot` (`application`, `postgres_data`, `/var/lib/postgresql/data`, `python:3.11-slim`, `postgres`, `api`, `worker`); implementer must verify the values at current source lines before coding the test. The inconsistent mock `app_cache` summary versus `api-cache`/`logs` mount sources is intentionally not used to claim mount details; it should exercise the “details unavailable” fallback if covered.

### G-04: Authored cost ≠ observed tradeoff — Caught: 1×

N/A — no balance, cost, or outcome tradeoff is designed.

### G-05: Score saturation hides counterweights — Caught: 1×

N/A — no scores or clamped metrics exist in this slice.

### G-07: Dense-index cycling under round-robin allocation — Caught: 1×

N/A — no cycling, allocation, or indexed option rotation exists.

### G-10: A targeted policy must not co-trigger another event — Caught: 1×

N/A — no event trigger or selector policy exists.

### G-11: Batch session ids do not seed sim RNG — Caught: 1×

N/A — no RNG or simulation is introduced.

### G-13: Every visual-matrix cell must genuinely exercise its gated effect — Caught: 1×

N/A — no visual matrix is proposed.

### G-15: Regression tests can codify the new bug — Caught: 1×

Arrest: e2e tests assert positive correct behavior (route changes, heading/metadata render, service relation remains navigable, not-found back-link works), not merely absence of 404 or console errors.

### G-16: Derived-artifact cache keys must cover every input that changes the output — Caught: 0×

N/A — no cache or derived artifact is added. Exact lookup maps are rebuilt from each model snapshot and key on the full identity string.

### G-17: Render targets must be validated at the REAL rendered size — Caught: 1×

N/A — this is not a pixel-art/render-target change. Existing responsive classes are reused; issue #35 owns the broader responsive/a11y pass.

### G-18: Nominal acceptance is not acceptance — task the reviewer with the verdict — Caught: 1×

Arrest: acceptance is observable: each list entity link must reach a matching detail heading and real fields/relations in mock and live modes. A route that merely mounts, or a list that merely contains text, does not pass.

### DM-01: AGENTS.md invariants are non-negotiable — Caught: 1×

Arrest: the slice remains read-only, makes no provider command/filesystem/bind/compose-plan change, adds no endpoint, and renders only daemon-published redacted snapshot strings. Tests and docs must contain no secrets. The issue is not auto-closed.

### DM-03: Live-Docker evidence is the release gate — Caught: 1×

Arrest: `npm run test:live-docker` is mandatory and must exercise list-to-detail navigation using live snapshot keys. Release evidence capture remains required by the standing workflow; mock green alone is insufficient.

## Architect pass 2

### Confirmed and corrected decisions

1. **Route keys are correct for normal Docker records, but names are not lossless at the wire-contract boundary.** Live volume collection deliberately copies `volume.name` into both `id` and `name` (`crates/dockermap-daemon/src/main.rs:887-901`), while the mock does not (`crates/dockermap-core/src/lib.rs:1087-1097`); therefore all volume links and lookups must use `name`, and mount matching must retain the pass-1 `source === volume.name || source === volume.id` rule. Images are uniquely grouped by exact container image string through a `BTreeMap` (`crates/dockermap-core/src/lib.rs:1110-1134`) and are re-derived for both mock and live caches (`crates/dockermap-daemon/src/main.rs:332-355,409-455`), so `ImageRecord.image` is the only available and normally unique image identity. Network records preserve Docker IDs and names but replace a missing name with the shared literal `unnamed` (`crates/dockermap-daemon/src/main.rs:869-885`); the TypeScript contract itself permits duplicate or empty strings (`packages/contracts/src/index.ts:43-61`). Docker normally enforces engine-scoped uniqueness for network and volume names, but the web model must tolerate malformed/redacted/fixture snapshots rather than pretend route identity is mathematically lossless.

2. **Duplicate-map semantics are now explicit: first record wins.** Build `networkByName`, `volumeByName`, and `imageByRef` by iterating each snapshot array and inserting only when the key is absent; do not use `new Map(array.map(...))`, whose silent last-wins behavior would leave collision policy accidental. First-wins is deterministic for a given snapshot order, not a guarantee across reordered duplicate input; the contract has no identity capable of providing that guarantee. Every duplicate row remains visible; rows sharing a key necessarily open the same first matching detail because the name/reference route cannot distinguish them. Empty identity strings are schema-valid but cannot inhabit a required `:param`: render such a row as malformed/unavailable evidence without a detail link, and require every route builder/resolver to reject an empty key. Do not invent a sentinel, fuzzy match, new daemon field, or ID route in this slice. Cross-kind equal strings are harmless because routes and indexes are separate.

3. **Encoded slash behavior is confirmed for the locked implementation, with browser e2e still required.** The lock resolves the web workspace to `react-router-dom@7.18.2` (`package-lock.json:365-369,415-418`). Executing both `matchRoutes` and `createMemoryRouter` from that installed package with `/images/ghcr.io%2Facme%2Fapp%3A1.2` produced `{ image: "ghcr.io/acme/app:1.2" }` while preserving the encoded pathname. Installed router source decodes each URL segment while re-protecting `/`, then restores `%2F` in the captured param (`apps/web/node_modules/react-router/dist/development/chunk-62JRHF6Z.mjs:796-800,844-850`). The app uses `BrowserRouter` (`apps/web/src/main.tsx:1-12`), whose installed implementation supplies browser-history locations to the same router matcher (`chunk-62JRHF6Z.mjs:10391-10427`). This is strong source/runtime confirmation, not a substitute for the planned Playwright assertion at the actual browser boundary. Screens must not call `decodeURIComponent` again.

4. **ServiceDetail anatomy is substantially represented, with two fidelity clarifications.** It gets `useParams`/`useApp`, preserves a stale model for top-level loading/error, and renders a model-backed not-found action (`apps/web/src/screens/ServiceDetail.tsx:22-45`); its real shell is header + four-cell impact band + optional tabs/panels (`ServiceDetail.tsx:49-102`), and its internals disclosure is local state rendered only in Configuration with a `type="button"` `.ghost-link` action (`ServiceDetail.tsx:199-265`). Mock/daemon-fallback mode is not screen-special-cased: `useApp` receives the same model shape, so the new screens must remain mode-agnostic. Do not copy `RelList`'s unresolved-item drop (`ServiceDetail.tsx:135-153`); pass 1 correctly requires inventory relationship evidence to remain visible. Existing layout styles do cover `.impact-band.wide`, `.detail-head`, `.detail-id`, and mount rows (`apps/web/src/styles.css:1351-1379,1448-1517`), but entity-link classes do not yet exist and must be added with visible focus styles. New disclosure buttons must add `aria-expanded` (and `aria-controls` when a stable panel ID is used), even though the existing ServiceDetail control does not yet expose that state.

5. **Runtime label gating is sufficient and intentionally fail-closed, but not a same-generation guarantee.** Docker runtime node labels are copied directly from snapshot container/network/volume names and carry exact node kinds (`crates/dockermap-core/src/lib.rs:1243-1271,1318-1357`; `packages/contracts/src/index.ts:349-352,399-405`). The daemon computes snapshot and runtime map into one cache refresh (`crates/dockermap-daemon/src/main.rs:409-455`), but the web fetches `/api/snapshot` and `/api/runtime/map` independently and combines the latest successful responses (`apps/web/src/hooks/useSystemModel.ts:12-25`), so a refresh can transiently pair generations. Resolve only when `selected.provider === "docker"`, the exact `selected.type` matches, the label is non-empty, and the corresponding current snapshot map contains it. A renamed/removed node then has no detail link; that fail-closed behavior is acceptable. Never fall back to `selected.service?.name`, `selected.id`, a stripped runtime ID, or a coincidental cross-provider label. Remove both existing service-link sites when installing the one primary resolver (`apps/web/src/screens/Runtime.tsx:70-72,238-242,300-304`).

6. **No half-built detail screen or daemon gap was found.** `ServiceDetail.tsx` is the only current `*Detail.tsx`; routes still stop at the three list pages (`apps/web/src/App.tsx:38-54`). Publication already redacts images, networks, volumes, and mount strings (`crates/dockermap-daemon/src/main.rs:4099-4144`). Pass 1's web-only scope remains binding: routes/screens/model/styles/e2e only; no Rust, Express, OpenAPI, contract, collector, or Docker-inspect expansion.

### E2E amendments after fixture verification

- Pass 1's core mock assertions are correct: `application` is `bridge` with `gateway`, `api`, and `worker` (`crates/dockermap-core/src/lib.rs:1067-1073`); `postgres_data` is attached to `postgres` (`lib.rs:1087-1092`), whose named-volume mount is read-write at `/var/lib/postgresql/data` (`lib.rs:1008-1022`); and `python:3.11-slim` has `api` and `worker` (`lib.rs:1037-1047`). The daemon mock re-derives the same image grouping, so these are the browser-visible values (`crates/dockermap-daemon/src/main.rs:332-355`). No value correction is needed.
- Strengthen the encoded-slash browser check: visit `/images/${encodeURIComponent("ghcr.io/example/missing:tag")}` and assert the **image-specific** not-found heading, the decoded full reference in the body, and the `/images` back link. Merely seeing generic not-found text would not prove that BrowserRouter matched `/images/:image` and decoded the param.
- Select Runtime network/volume buttons by role plus exact visible label (and, where needed, their adjacent `docker · docker network/volume` text), never generated IDs. Assert the single entity-specific link target before clicking it.
- On Map, `postgres` truthfully exercises image `postgres:16-alpine`, network `data`, and volume `postgres_data`; do not expect the `python:3.11-slim` or `application` values from the separate inventory assertions (`lib.rs:1008-1023,1074-1092`).
- In live Docker, choose records from the fetched snapshot that actually have relationships: a network with a fixture member, a volume with `attachedTo.length > 0` and a matching named-volume mount, and the exact `busybox:1.36.1` image record. The fixture targets are `/cache` for `live-cache` and `/logs` for `live-logs` (`tests/e2e/dockermapHarness.ts:574-613`); derive the selected expected target from the matching snapshot container mount rather than relying on array order.

### Ordered implementation checklist

1. Extend `SystemModel` with `images` plus the three exact first-wins lookup maps; import `ImageRecord`, build indexes from the snapshot arrays, retain arrays, and explicitly skip empty keys for routable resolution.
2. Migrate `Images.tsx` to `model.images` and shared `loading/error` semantics before adding links, preserving stale-model rendering, search, sorting, consumer chips, and empty states.
3. Register the three sibling detail routes in `App.tsx`, then implement explicit `NetworkDetail`, `VolumeDetail`, and `ImageDetail` screens with exact map lookup, stale-model loading/error behavior, entity-specific not-found/back links, truthful panels/counts, unresolved relationship evidence, and accessible internals disclosure.
4. Add only the necessary reusable CSS/entity-link classes, including hover and keyboard-visible focus; reuse the verified detail/panel/list/mount primitives and avoid a generic schema renderer.
5. Wire list links without nested interactive content: Panel title/action links for network/volume and a uniquely classed image-name link. Guard empty identities.
6. Wire Map and ServiceDetail image/network/named-volume links from exact resolved snapshot values. Keep unresolved names visible and non-interactive; never construct a URL from a mount target, runtime ID, or display-only split image value.
7. Replace Runtime's two service-link paths with one provider+type+non-empty+exact-map resolver and one optional exact image link for Docker containers; fail closed on cross-generation mismatch.
8. Extend the existing mock navigation test with the verified fixture values and the strengthened encoded-slash assertion, using `domcontentloaded` only for direct loads and explicit unique locators.
9. Extend the existing `@live-docker` flow with snapshot-derived, relationship-bearing keys and matching mount targets; assert list-to-detail navigation and exact headings/fields/relations.
10. Verify diff scope is web/docs/tests only, then run in order: `npm run check`, `npm run test:e2e`, `npm run test:live-docker`. Do not weaken assertions or add daemon data when a relationship is absent; select a truthful fixture record instead.

### Verdict

**Sound with amendments.** Pass 1 chose the correct web-only architecture, source of truth, explicit screens, route encoding, relationship derivations, and test surfaces. The binding amendments are first-wins duplicate handling, fail-closed empty identities, stronger disclosure a11y, explicit transient Runtime generation mismatch behavior, and fixture-derived live assertions. No daemon/API/contracts scope expansion is justified.
