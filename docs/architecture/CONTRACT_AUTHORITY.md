# Contract Authority and Deterministic Schema Strategy

This decision gives each DockerMap public API surface one owner. It prevents a plausible-looking fixture, TypeScript declaration, or OpenAPI entry from being mistaken for proof that the daemon emits the same contract.

- Status: accepted for phased implementation
- Decision record: [#144](https://github.com/Joncallim/DockerMap/issues/144)
- Parent epic: [#65](https://github.com/Joncallim/DockerMap/issues/65)
- Scope: architecture and validation strategy only; it changes no endpoint or response.

## Historical motivating gap and current state

At #65 creation, Rust models, handwritten browser-facing TypeScript, Express
policy, request parsing, OpenAPI, and readable fixtures were separately
maintained. That made a plausible fixture or declaration insufficient evidence
that the daemon, Node API, and documented route agreed.

Current `main` assigns those responsibilities explicitly: Rust models generate
`packages/contracts/src/rustModels.ts` and JSON Schema; Node-owned envelopes
are declared in `nodeSchemas.ts`; `ROUTE_MANIFEST` owns browser routes;
`requestContracts.ts` owns bounded Logs/Compose requests; `sseProtocol.ts`
owns named event frames; and `openapi.ts` derives the OpenAPI document. The
fixtures in `tests/fixtures/contracts` remain readable validation examples,
not a second schema authority.

The earlier status-fixture drift has been corrected: `status.json` now uses the
attested `"docker"`/`"mock"` vocabulary and includes `sourceCoherent` and
`snapshotSource`. The contracts workspace now typechecks and validates fixtures
at runtime. Rust/Node response associations, SSE event contracts, and bounded
request declarations are implemented; #65 remains open for its final
cross-boundary acceptance audit, not for a missing schema association.

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
| API compatibility version | Tracked root `VERSION` file | Checked Cargo/npm/package-lock mirrors; generated API-local version module; daemon build guard; Node descriptor/status/OpenAPI; release tag metadata | `scripts/check-version-authority.mjs` is the dependency-free checker/generator. |

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

The first phase is deliberately narrow. `schemars` `=1.2.1` derives the daemon-owned response roots from their Rust serialization definitions: Docker snapshot and graph, runtime map, Compose scan/graph/edit plan, logs, and health. The committed artifacts live in `packages/contracts/generated/rust/` and are regenerated with `npm run generate:contracts`; `npm run check:contracts` renders twice and fails when the byte streams, checked-in bytes, or expected artifact set drift. Rust `u64` fields serialize as JSON integers, but public schemas cap them at JavaScript's exact integer limit (`9007199254740991`): JavaScript `JSON.parse` cannot preserve every larger integer. Current public uses are timestamps and remain inside that range; a future endpoint that needs a larger value must serialize it as a string or introduce a separately documented representation rather than claiming lossless browser compatibility.

The contracts workspace validates every matching readable fixture using Ajv against the committed generated schema, including a negative regression that makes a Rust-owned integer field invalid. This validates schema/fixture agreement without treating a fixture as schema authority. Browser/API-only envelopes and route associations follow in later phases of this ADR.

### Implemented Node envelope schemas (#152)

`packages/contracts/src/nodeSchemas.ts` is the canonical, handwritten JSON
Schema declaration layer for values created by the Node API: API errors,
identity, diagnostics, status, the `/api/v1` descriptor, and the root/API
health envelopes. Readable fixtures are validated with strict Ajv and reject
both source-stamp drift and undeclared response fields. An isolated API-process
test validates actual successful endpoints plus a real 404 error against those
same schemas.

OpenAPI exposes these Node schemas as components and references them only for
Node-owned success envelopes and generic API-error responses. Daemon
pass-through success operations retain human-readable descriptions rather than
misrepresenting a Node copy as their schema authority. Health envelopes contain
a Rust-owned `daemon` value; the Node schema validates the enclosing fields but
does not duplicate its Rust serialization contract.

### Implemented Rust route/OpenAPI association (#154)

The generated contracts module now packages two deterministic views of every
Rust response schema. `RUST_RESPONSE_SCHEMAS` retains the standalone Schemars
documents for Ajv fixture and actual-response validation.
`OPENAPI_RUST_RESPONSE_SCHEMAS` differs only by rebasing internal `#/$defs`
references to the owning OpenAPI component; that is required because an
OpenAPI component is embedded below the document root. Both views are emitted
by the Rust generator, not hand-authored schema authorities.

OpenAPI is now 3.1.1 and is structurally validated against the OpenAPI 3.1
schema by `@seriousme/openapi-schema-validator`, replacing the previous
3.0-only parser. Every Rust pass-through browser route and its `/api/v1/*`
alias references one exact generated component: snapshot, graph, runtime,
inventory/detail, logs, and all Compose reads. Named Rust wrappers make the
existing inventory object envelopes and transparent container-detail payload a
stable schema root without changing response bytes. SSE and intentional 204
session responses remain explicit non-JSON exceptions. Coverage and planted
missing-mapping tests fail closed if a Rust route loses its schema association,
and a real Node API process validates emitted pass-through responses against
the standalone generated schemas.

### Implemented Rust declaration authority (#156)

`json-schema-to-typescript` `15.0.4` renders the committed Rust/Schemars
documents into `packages/contracts/src/rustModels.ts`. The file is committed,
deterministic, and never hand-edited; `npm run check:contracts` first checks
the Rust schema bytes, then fails if the generated declarations are stale.
`packages/contracts/src/index.ts` re-exports those daemon models rather than
maintaining a second structural copy. A regression simulates adding a public
Rust `ContainerRecord` field, runs the real declaration generator, and proves
the committed declarations fail freshness until regenerated.

The browser's Demo Mode is Node-owned. It deliberately permits JSON scalar
metadata values that the current Rust daemon's `BTreeMap<String, String>` does
not emit. The only handwritten overlay is therefore the explicitly documented
API union for that Node-owned metadata field; every daemon model field remains
generated from Rust. This preserves the existing response bytes without
misrepresenting demo data as daemon serialization.

### Implemented version authority (#150)

`VERSION` is now the strict SemVer product authority. The dependency-free
`scripts/check-version-authority.mjs` checks all DockerMap Cargo manifests,
workspace package manifests, workspace dependency mirrors, and the exact
`package-lock.json` metadata. It emits and checks the committed API-local
`PRODUCT_VERSION` module used by `/api/v1`, `/api/status`, and OpenAPI. The
daemon build script rejects a Cargo package version that differs from `VERSION`;
release packaging performs the same mirror check and rejects any tag other than
`vVERSION` before creating a staging directory. Docker Engine API and snapshot
versions are deliberately outside this product-version authority.

### Implemented SSE and request authority (#159 and #161)

`apps/api/src/sseProtocol.ts` owns the closed set of named SSE event frames and
maps each payload to its Rust or Node schema authority. The generated OpenAPI
stream annotation and API-process tests consume that same declaration; heartbeat
comments remain an explicit non-JSON protocol frame. `apps/api/src/requestContracts.ts`
owns the supported Logs and Compose query declarations used by fail-closed
parsing, daemon forwarding, and OpenAPI parameters. The tests include malformed
encoding, duplicate/unknown fields, bounded values, and forwarding regressions
so a readable OpenAPI parameter cannot silently diverge from enforcement.

## Determinism and CI contract

- A clean checkout generates all committed artifacts with pinned public dependencies. No private registry, network fetch, current time, random ID, absolute build path, or platform ordering may affect output.
- A check runs generation twice at one SHA and fails if tracked files change or the two byte streams differ.
- CI fails if a public Rust shape changes without regenerated output, a Node envelope lacks schema, a fixture is invalid, or the manifest, live Express registration, metadata, and OpenAPI disagree.
- The OpenAPI 3.1 structural schema validator validates generated OpenAPI. Route completeness and auth/rate-limit tests stay independent: an OpenAPI file is not authorization evidence.
- Runtime validation belongs in tests, fixture validation, and optional debug/CI assertions. Production responses gain no new per-response validation cost without a later performance decision.

Generated artifacts are reviewed like source. A generator upgrade is contract-affecting and must show deterministic output and compatibility impact.

## Compatibility policy

The stable surface is v1. Adding an optional response field, a new enum value where clients are documented to tolerate it, or a route is additive; it still requires regenerated artifacts, schema/fixture validation, and release review. Removing or renaming a field, narrowing values, changing serialization or nullability, changing route authentication, changing bounded-query meaning, or removing an alias is breaking. It requires a new API version or an explicitly approved compatibility bridge.

`/api/*` and `/api/v1/*` remain together until a separate versioned deprecation decision records notice, migration window, and removal evidence. An alias cannot disappear merely because generated OpenAPI omits it. Each breaking-schema CI change needs recorded client impact and a version/bridge decision; a green diff does not authorize a break.

## Boundaries and non-goals

This ADR does not redesign models, add GraphQL, remove aliases, or create a generic SDK program. It does not weaken redaction, source-stamp, auth, query-bound, or dry-run-only invariants. Generated artifacts and their validation prove the declared contract paths; the remaining #65 work is a final cross-boundary acceptance audit, including the live-Docker/release evidence required by the epic, rather than a return to independently handwritten daemon models.
