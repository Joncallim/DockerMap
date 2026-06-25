# DockerMap Agent Guide

DockerMap is a read-first local operational topology app. It helps a person
understand one self-hosted machine across Docker, Compose, systemd, tmux, npm,
Python/native processes, reverse proxies, DNS, storage, networks, and AI
workloads.

## Non-Negotiable Invariants

- DockerMap must not change files, containers, services, images, networks, or
  volumes unless a future write-mode issue explicitly adds backup, diff preview,
  confirmation, audit logging, and rollback behavior.
- Provider commands must be fixed read-only invocations. Do not pass user input
  to a shell command.
- Filesystem discovery must stay bounded to documented roots, explicit request
  targets, or hard caps. Do not add unbounded host scans.
- Secrets from env vars, unit files, process args, package auth config, service
  definitions, proxy config, logs, or inline auth URLs must be omitted or
  redacted before API responses, docs examples, fixtures, screenshots, and issue
  comments.
- The Rust daemon binds to loopback by default. Remote daemon access and browser
  API access must stay explicit, token-protected where documented, and covered by
  tests.
- Compose edit planning is dry-run only and must return `willWrite: false`.

## Repository Map

- `crates/dockermap-core`: canonical Rust domain model, Compose parser, graph
  derivation, fixtures, and provider-neutral runtime types.
- `crates/dockermap-daemon`: Rust HTTP daemon, Docker and host-provider
  collectors, daemon routes, mock fallback, and CLI commands.
- `apps/api`: Express API that exposes browser-facing routes, auth, CORS, daemon
  proxying, SSE behavior, and error redaction.
- `packages/contracts`: TypeScript contracts that mirror Rust API shapes and
  shared JSON fixture compatibility tests.
- `apps/web`: React/Vite UI for dashboard, service map, inventory, logs,
  Compose, settings, and read-only Copilot surfaces.
- `tests/fixtures/contracts`: shared fixtures consumed by Rust and TypeScript.
- `tests/e2e`: Playwright smoke and live-Docker checks.
- `docs`: architecture, deployment, testing, release, security, design, and
  planning docs.

## Default Agent Workflow

1. Read the issue body, acceptance criteria, and this guide before editing.
2. Identify the narrowest matching subagent from `.codex/agents`.
3. Inspect the current repo state and relevant files. Do not rely on stale docs
   when code is cheap to verify.
4. Make the smallest pass that satisfies the issue. If the request spans more
   than the selected agent scope, stop with a handoff note instead of guessing.
5. Run the smallest relevant verification commands and record exact results.
6. Update docs, fixtures, and contracts when behavior changes.

## Issue Resolution Rule

AI coding platforms should not close GitHub issues automatically. After an issue
appears resolved, post or draft a plain-English evidence comment that a
non-technical maintainer can understand, then recommend whether the maintainer
should close the issue.

Use this format:

```markdown
## Resolution Evidence
- What changed:
- Why this resolves the issue:
- How I checked it:
- Remaining risk or follow-up:

Recommendation: This issue appears resolved and can be closed by a maintainer.
```

If validation fails or evidence is incomplete, say so and recommend keeping the
issue open.

## Validation Commands

Use the narrowest applicable set:

- JavaScript/API/contracts: `npm run typecheck`, `npm run build`,
  `npm run test:js`, `npm run test:api`, `npm run test:contracts`
- Rust/core/daemon: `npm run fmt:rust:check`, `npm run lint:rust`,
  `npm run test:rust`, `npm run test:rust:core`, `npm run test:rust:daemon`
- Full local gate: `npm run check`
- Browser smoke: `npm run test:e2e`
- Live Docker evidence: `npm run test:live-docker`
- Deployment build: `npm run build:deploy`

State commands that were not run and why.

## Subagent Routing

- Compose parser, graph, edit-plan: `compose-core`
- Runtime providers and read-only collectors: `runtime-provider`
- Express API, contracts, and shared fixtures: `api-contracts`
- React topology and inventory UI: `frontend-topology`
- Security invariants, auth, redaction, and write-prevention review:
  `security-readonly`
- Tests, fixtures, and release evidence: `qa-evidence`
- Docker, CI, systemd, reverse proxy, and deployment: `release-ops`
- README, architecture, deployment, security, release, and testing docs:
  `docs-operator`
- GitHub issue triage and evidence comments: `issue-steward`
