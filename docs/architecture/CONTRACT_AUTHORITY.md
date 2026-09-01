# Contract Authority and Deterministic Schema Strategy

This decision gives each DockerMap public API surface one owner. It prevents a plausible-looking fixture, TypeScript declaration, or OpenAPI entry from being mistaken for proof that the daemon emits the same contract.

- Status: accepted for phased implementation
- Decision record: [#144](https://github.com/Joncallim/DockerMap/issues/144)
- Parent epic: [#65](https://github.com/Joncallim/DockerMap/issues/65)
- Scope: architecture and validation strategy only; it changes no endpoint or response.

## Current fact and motivating gap

DockerMap currently has useful but separate declarations: Rust public domain structures in `crates/dockermap-core/src/models.rs`; handwritten browser-facing TypeScript in `packages/contracts/src/index.ts`; Express policy in `apps/api/src/routes.ts` as `ROUTE_MANIFEST`; browser-only envelopes, query parsing, version descriptor, and a hand-built OpenAPI object in `apps/api/src/readHandlers.ts`; and readable shared JSON examples in `tests/fixtures/contracts`.

The fixture test is not schema validation. In particular, `tests/fixtures/contracts/status.json` currently says `"mode": "live"` and omits `sourceCoherent` and `snapshotSource`; current `StatusResponse` permits `"docker" | "mock" | "mixed"` and requires both omitted fields. The compatibility test still passes because it uses a TypeScript assignment in a Vitest test, while the contracts workspace has no `typecheck` script and no runtime schema validator. This is a real baseline hole, not a claim that the fixture or endpoint has already been corrected.

Existing route-manifest completeness tests remain valuable: they prove that registered Express templates and declared templates agree. They do not prove OpenAPI paths, request metadata, response schemas, or daemon serialization agree with them.

## Canonical ownership map

Exactly one authority owns each concern. A generated artifact is evidence of its authority, never a second editable authority.

| Public concern | Canonical owner | Generated or handwritten output | Notes |
| --- | --- | --- | --- |
| Daemon-domain response models: snapshot/inventory, graph, runtime map, Compose scan/graph/edit plan, daemon logs, and daemon diagnostics | Rust public model and response definitions in `dockermap-core`, with daemon wrappers where a route has one | Stable JSON Schema and generated TypeScript declarations | Rust serialization names, nullability, enums, and defaults are authoritative for daemon-owned bytes. |
| Browser/API-only envelopes: `/health`, `/api/health`, `/api/status`, identity/session responses, API errors, and SSE event envelopes | Node API response declarations | Handwritten, schema-described Node contracts; generated TypeScript where browser consumption needs it | These are not daemon-model aliases and must not be inferred from Rust. |
| Browser-facing HTTP route IDs, templates, aliases, auth class, and rate-limit class | `apps/api/src/routes.ts` `ROUTE_MANIFEST` | Express registration, completeness checks, generated OpenAPI paths | Node owns this boundary because Express enforces it. UI navigation is a separate concern. |
| Request/query metadata and bounds | Node handler request declarations beside the manifest entry | OpenAPI parameters and request-validation tests | Generation must not replace fail-closed parsing of malformed input. |
| Response-to-route association | Typed Node route-contract table referencing a Rust or Node schema ID and shared API-error schema | OpenAPI responses and route/schema completeness checks | This closes the current path-list/schema-list gap. |
| OpenAPI | Derived artifact, not an editable source | Committed deterministic OpenAPI JSON (optional rendered YAML) | Derived from manifest, request metadata, response association, and schemas. |
| Fixtures | `tests/fixtures/contracts` | Handwritten readable examples validated against schemas | Retain collision, redaction, and realistic regression value; never define the API. |
| API compatibility version | Tracked root `VERSION` file, introduced in the version phase | Rust build value, Node descriptor/status/OpenAPI value, release metadata | Current repeated `0.1.0` literals are temporary duplication, not authority. |

## Options considered

### `ts-rs`

`ts-rs` can generate TypeScript declarations directly from Rust types. It is useful for Rust-only consumers, but does not provide JSON Schema constraints for runtime validation or OpenAPI, and cannot own Node-only envelopes, Express aliases, authentication policy, or bounded request queries. Used alone, it would leave the key cross-boundary declarations disconnected. It is not the primary contract mechanism.

### `schemars` JSON Schema

`schemars` derives JSON Schema from the Rust/Serde structures that serialize daemon-owned payloads. JSON Schema is a stable review artifact and can drive a standard runtime validator, TypeScript generation, and OpenAPI components. The Rust workspace does not currently declare `schemars` for DockerMap public models; implementation must add and pin it deliberately, derive only public boundary types, and make output deterministic.

It does not solve Node envelopes or route policy on its own. That is desirable: Node stays the explicit owner of the browser boundary rather than hiding Express policy in Rust.

### Handwritten TypeScript plus stronger checks

Handwritten TypeScript is readable, but independently expressing every Rust model creates a second authority. Structural AST comparison is fragile across Rust and TypeScript differences such as nullable fields, tagged unions, maps, and serialization names; fixtures exercise only selected examples. Handwritten contracts remain appropriate for Node-owned shapes, whose source is Node, but are rejected for daemon-owned models.

## Decision and phases

DockerMap will use deterministic JSON Schema as the interchange artifact: Rust owns daemon models; Node owns browser envelopes and HTTP policy; generated artifacts connect them.

1. **Schema foundation.** Add an explicitly pinned schema generator for public Rust types and a small Node schema declaration layer for Node-owned envelopes. Generate committed JSON Schema under one documented `packages/contracts/generated/` location. Generate browser TypeScript from those schemas for daemon-owned data only after parity tests pass.
2. **Validation and drift checks.** Add a contracts-workspace typecheck and deterministic generator/check command. Validate every shared fixture and daemon-emitted fixture/live-test payload against its schema. Add intentional drift regressions for changed Rust fields, stale generated output, invalid fixtures, and undeclared routes.
3. **Route-derived OpenAPI.** Give every manifest entry typed request and response metadata. Generate OpenAPI from that table and schema references, including supported `/api/*` and `/api/v1/*` aliases. Preserve and strengthen route-completeness and security-policy tests.
4. **Version authority.** Introduce the root `VERSION` file and one reproducible read path for Rust, Node, OpenAPI, status, `/api/v1`, and release evidence. Package-manager versions may remain, but their relationship to release version must be checked rather than assumed.

OpenAPI follows schema and route association deliberately: generating it first would merely preserve today's manually synchronized path list under a new tool.

### Implemented baseline (#146)

The first phase is deliberately narrow. `schemars` `=1.2.1` derives the daemon-owned response roots from their Rust serialization definitions: Docker snapshot, runtime map, Compose scan/graph/edit plan, logs, and health. The committed artifacts live in `packages/contracts/generated/rust/` and are regenerated with `npm run generate:contracts`; `npm run check:contracts` renders twice and fails when the byte streams, checked-in bytes, or expected artifact set drift.

The contracts workspace validates every matching readable fixture using Ajv against the committed generated schema, including a negative regression that makes a Rust-owned integer field invalid. This validates schema/fixture agreement without treating a fixture as schema authority. Browser/API-only envelopes, route associations, generated TypeScript, OpenAPI, and release-version authority remain later phases of this ADR.

## Determinism and CI contract

- A clean checkout generates all committed artifacts with pinned public dependencies. No private registry, network fetch, current time, random ID, absolute build path, or platform ordering may affect output.
- A check runs generation twice at one SHA and fails if tracked files change or the two byte streams differ.
- CI fails if a public Rust shape changes without regenerated output, a Node envelope lacks schema, a fixture is invalid, or the manifest, live Express registration, metadata, and OpenAPI disagree.
- A standard parser/linter validates generated OpenAPI. Route completeness and auth/rate-limit tests stay independent: an OpenAPI file is not authorization evidence.
- Runtime validation belongs in tests, fixture validation, and optional debug/CI assertions. Production responses gain no new per-response validation cost without a later performance decision.

Generated artifacts are reviewed like source. A generator upgrade is contract-affecting and must show deterministic output and compatibility impact.

## Compatibility policy

The stable surface is v1. Adding an optional response field, a new enum value where clients are documented to tolerate it, or a route is additive; it still requires regenerated artifacts, schema/fixture validation, and release review. Removing or renaming a field, narrowing values, changing serialization or nullability, changing route authentication, changing bounded-query meaning, or removing an alias is breaking. It requires a new API version or an explicitly approved compatibility bridge.

`/api/*` and `/api/v1/*` remain together until a separate versioned deprecation decision records notice, migration window, and removal evidence. An alias cannot disappear merely because generated OpenAPI omits it. Each breaking-schema CI change needs recorded client impact and a version/bridge decision; a green diff does not authorize a break.

## Boundaries and non-goals

This ADR does not redesign models, add GraphQL, remove aliases, or create a generic SDK program. It does not weaken redaction, source-stamp, auth, query-bound, or dry-run-only invariants. Until these phases land, TypeScript contracts and fixtures are helpful regression evidence, not complete cross-language contract proof.
