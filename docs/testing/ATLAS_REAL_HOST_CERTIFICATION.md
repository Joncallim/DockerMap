# Atlas Real-Host Certification Record

This template lets an operator record an approved Atlas review of a real host
without placing host data in the repository or confusing a review packet with
release approval. Complete a separate record for each approved host class and
retain any sensitive working material only in the operator-approved location.

Status: certification template for #256. It does not certify a host, enable
Atlas, authorize a production cutover, or change DockerMap's read-first
boundary. It complements the [Atlas Acceptance Rubric](../architecture/ATLAS_ACCEPTANCE_RUBRIC.md),
[Atlas Screenshot Governance](ATLAS_SCREENSHOT_GOVERNANCE.md),
[Atlas Performance and Bundle Evidence](ATLAS_PERFORMANCE_BUNDLE_EVIDENCE.md),
and [Docker testbed procedure](TESTBED_DOCKER_PROCEDURE.md). The implemented
route, feature flag, and test harness remain the source of truth.

Synthetic-fixture and production-preview pull-request evidence are useful
prerequisites only. They do **not** substitute for this real-host record,
operator review, human visual approval, or a cutover decision.

## 1. Eligibility and safety boundary

Use this record only after the operator has selected a host and explicitly
authorized read-only observation. DockerMap must not change host files,
containers, services, images, networks, or volumes during this review. Do not
turn this template into a default command that discovers or contacts hosts.

Before beginning, the operator confirms all of the following:

- [ ] The host is in scope and access is explicitly approved.
- [ ] The daemon remains loopback-bound unless separately documented,
  token-protected remote access has been approved and verified.
- [ ] DockerMap is running in its read-first mode; no write-mode feature or
  edit-plan execution is used.
- [ ] The Atlas preview route is enabled only for this controlled review and
  its default-off production behavior is preserved elsewhere.
- [ ] A rollback owner and an approved deployment procedure for replacing the
  preview-enabled artifact with a verified default-off artifact are known before
  testing begins. The Atlas gate is build-time only; disabling it requires a
  controlled image/deployment change, not a browser setting or runtime toggle.
- [ ] The review packet will contain sanitized attestations and references,
  never copied host output.

Stop the review if the route, daemon, API, feature flag, authentication
boundary, or host authorization differs from the approved plan. Record the
exception as a failure or follow-up; do not reinterpret it as passing evidence.

## 2. Record identity (safe fields only)

Fill in only the fields below. Use a locally meaningful but non-identifying
case alias, such as `operator-case-a`; do not use a hostname, IP address,
machine identifier, container ID, Compose project name, user name, or path.

| Field | Value |
| --- | --- |
| Certification record ID | `<opaque operator-approved record ID>` |
| Host class | `compose-heavy` / `mixed-docker-host-native` / `sparse-unusual` |
| Safe case alias | `<non-identifying alias>` |
| Operator approver | `<approved reviewer role or opaque identifier>` |
| Review date (UTC) | `<YYYY-MM-DD>` |
| Source revision | `<commit SHA>` |
| Atlas model / projection / layout / presentation / visual-policy versions | `<published version strings>` |
| Browser name and version | `<sanitized version>` |
| Browser zoom | `200%` |
| Viewport and device scale | `<controlled non-identifying values>` |
| Theme and reduced-motion setting | `<values tested>` |
| Deployment mode | `controlled production image` / `<approved equivalent>` |
| Result | `pass` / `fail` / `incomplete` |
| Approval decision | `approved` / `not approved` / `pending` |

The record must not include raw hostnames, addresses, ports, IDs, labels,
paths, provider metadata, API payloads, screenshots containing identifying
data, logs, tokens, credentials, cookies, authorization headers, raw
evidence/source references, or unredacted command output. If a fact is needed
for operator audit, retain it outside the repository in the approved secure
system and cite only its opaque evidence reference below.

## 3. Required host-class coverage

Certification is incomplete until there is one separately approved record for
each class. A host can satisfy only the class that the operator attests it
actually represents; do not infer a class from display names, labels, or
proximity.

| Required class | Operator attests, using sanitized wording | Minimum Atlas review focus |
| --- | --- | --- |
| Compose-heavy | Multiple observed Docker/Compose subjects and bounded supported network/storage or declared-dependency context are present | identity, bounded local context, aggregate/uncertainty handling, and no causal or exposure claim |
| Mixed Docker + host-native | Distinct observed Docker and host-native provider subjects are present, including a freshness or availability distinction where supported | source separation, exact-key selection, independent presentation channels, and no label/name correlation |
| Sparse or unusual | Limited subjects and at least one supported uncertainty condition (for example unresolved, unsupported, omitted, collision, or unavailable) are present | empty/sparse orientation, non-routable treatment, text alternative, and truthful unknown boundary |

Record an unavailable required condition as `not applicable on this approved
host` and continue only when another approved host is scheduled to cover it.
Do not manufacture a real-host condition or use synthetic data to fill the
gap.

## 4. Pre-capture redaction review

Review every visible surface and every artifact before it leaves the approved
environment. The reviewer signs only after all applicable checks pass:

- [ ] Atlas cards, directory, inspector, local-context rail, status text, and
  accessible names contain only safe display material approved for the packet.
- [ ] A browser URL may contain only the closed Atlas route state: an exact,
  opaque published `subject` key and the permitted `lens` or `expand` fields.
  It contains no raw host identifiers, source references, or other sensitive
  values. Treat a selected URL as controlled working material; do not copy it
  into this repository or the sanitized record.
- [ ] No raw runtime record, Compose file, evidence key, source reference,
  provider revision, provider metadata, label, image reference, mount/path,
  port, environment value, command argument, token, cookie, or credential is
  copied into the record.
- [ ] Any screenshot retained for human review is inspected for identifying
  visual text and stored only in the operator-approved evidence location; its
  repository reference is an opaque inventory entry, not the image itself.
- [ ] The published evidence inventory below names only artifact type, opaque
  reference, integrity status, reviewer, and retention location class.

If redaction is uncertain, mark the review `incomplete`, remove the artifact
from the packet, and obtain operator guidance. Do not attempt to redact or
reconstruct raw host material in this repository.

## 5. Controlled review checklist

These are observation checks, not commands. Run only the approved local
procedure for the selected host; this document intentionally supplies no
default network, Docker, daemon, or browser automation command.

### Production image, live Docker, and authentication

- [ ] The operator attests that the reviewed build is the controlled production
  image/version recorded above, not a development server or synthetic fixture.
- [ ] The operator records a passing approved live-Docker observation for the
  host, including that unrelated resources remain outside the configured
  observation boundary where applicable.
- [ ] The API/browser authentication boundary was tested in the approved
  configuration: unauthenticated access was rejected when protection was
  configured, and authorized access was sufficient for the review.
- [ ] The daemon binding and any remote-access exception match the approved
  deployment plan; no access token or endpoint detail is recorded here.

### Cross-screen continuity and read-only behavior

- [ ] An exact safe subject handoff was tested between Atlas and each applicable
  existing screen (Runtime, Networking, Home, or detail); no name/label match
  or raw identifier was needed to complete the handoff.
- [ ] The selected subject, semantic lens, directory/text alternative, and
  bounded local context agree after navigation and refresh where the coherent
  revision remains valid.
- [ ] Unsupported, unresolved, ambiguous, and omitted material remains visibly
  bounded and non-routable as designed. Freshness is assessed independently:
  a stale subject with a current exact published key may remain routable, while
  a non-routable subject never gains a route merely because its evidence is
  fresh.
- [ ] No Atlas observation changed non-DockerMap host state. Any Compose edit
  plan inspected still reported `willWrite: false`; it was not executed.

### Manual 200% zoom and human acceptance rubric

At 200% browser zoom, test keyboard and pointer paths separately. Reviewers
must use the applicable task and visual-quality rows in the Atlas Acceptance
Rubric; automation, screenshots, and AI critique cannot award the human score
or approval.

| Check | Keyboard result | Pointer result | Human reviewer notes (sanitized) |
| --- | --- | --- | --- |
| Find a named routable subject | pass / fail / N/A | pass / fail / N/A | `<safe summary>` |
| Find a material attention or ambiguity item | pass / fail / N/A | pass / fail / N/A | `<safe summary>` |
| Inspect supported port, network, storage, or dependency context without a forbidden claim | pass / fail / N/A | pass / fail / N/A | `<safe summary>` |
| Establish an unknown/unsupported boundary | pass / fail / N/A | pass / fail / N/A | `<safe summary>` |
| Use directory/text alternative and recover focus after invalid selection | pass / fail / N/A | pass / fail / N/A | `<safe summary>` |

| Human visual-rubric outcome | Score / disposition |
| --- | --- |
| Applicable task gate | `<pass / fail and safe reference>` |
| Ten visual criteria | `<0–2 scores, sanitized>` |
| Required threshold / dagger rows | `<pass / fail>` |
| Accessibility or readability defect | `<none / sanitized follow-up>` |
| Reviewer approval | `<approved / not approved / pending>` |

## 6. Rollback exercise

Before a class can be marked approved, the operator must demonstrate a safe
preview rollback in the controlled environment. The Atlas preview flag is
build-time only, so this is a feature-availability check performed through an
approved deployment change, not a runtime toggle or a host-observation action.
It must not change non-DockerMap host workloads that DockerMap observes.

- [ ] Replace the preview-enabled artifact using the approved deployment
  procedure with a verified default-off artifact. Record the deployment change
  as rollback evidence; it is expected for this build-time gate.
- [ ] Confirm the legacy Service Map route and normal production build behavior
  remain available as documented, with Atlas no longer exposed by the preview
  route.
- [ ] Confirm Atlas observation did not change non-DockerMap host files,
  containers, services, images, networks, or volumes. The approved rollback
  deployment may replace only the DockerMap application artifact/workload needed
  to restore the default-off route; record that controlled app change separately
  from host-observation evidence.
- [ ] Record the result and an opaque evidence reference below. A failed or
  unperformed rollback keeps certification and cutover pending.

## 7. Safe evidence inventory and attestation

Use opaque references managed by the approved evidence system. No row may
embed or link directly to a raw artifact in this repository.

| Evidence type | Opaque reference | Integrity/redaction checked | Reviewer role | Retention location class | Result |
| --- | --- | --- | --- | --- | --- |
| Operator host-scope authorization | `<opaque ref>` | yes / no | `<role>` | approved secure system | pass / fail |
| Controlled production-image attestation | `<opaque ref>` | yes / no | `<role>` | approved secure system | pass / fail |
| Approved live-Docker observation | `<opaque ref>` | yes / no | `<role>` | approved secure system | pass / fail |
| Auth and loopback/remote-access review | `<opaque ref>` | yes / no | `<role>` | approved secure system | pass / fail |
| 200% keyboard/pointer and human-rubric review | `<opaque ref>` | yes / no | `<role>` | approved secure system | pass / fail |
| Cross-screen continuity review | `<opaque ref>` | yes / no | `<role>` | approved secure system | pass / fail |
| Rollback exercise | `<opaque ref>` | yes / no | `<role>` | approved secure system | pass / fail |

### Operator attestation

> I confirm that this record describes only the approved host class and the
> sanitized results listed above. I reviewed redaction before sharing the
> record; it contains no raw host data or secrets. I understand that this
> approval is observational certification evidence, not authority to change
> DockerMap's read-only behavior or enable Atlas by default.

| Attestor role | Date (UTC) | Decision | Opaque approval reference |
| --- | --- | --- | --- |
| `<role>` | `<YYYY-MM-DD>` | approved / not approved / pending | `<opaque ref>` |

## 8. Completion rule and follow-up

Mark the real-host gate complete only when all three required host-class
records are separately approved, each inventory item required above passes,
the 200% human rubric passes, and the rollback exercise passes. A failed,
incomplete, unredacted, synthetic-only, or production-preview-only record is
not interchangeable with an approved real-host record.

Even then, this template alone does not authorize Atlas cutover. A maintainer
must review the full release packet, including the applicable deterministic,
browser, production-image, live-Docker, security, accessibility, performance,
bundle, and rollback evidence, before deciding whether to enable Atlas or
retire any legacy behavior.
