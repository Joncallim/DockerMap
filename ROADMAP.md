# DockerMap Roadmap

## Current Codebase Review

Initial review found a placeholder Python entry point and a minimal README:

- `main.py` exists but contains no implementation yet.
- `README.md` defines the project name and intent: "Visualise and Edit Docker Paths".
- There are no dependencies, package metadata, tests, CI workflows, architecture docs, Docker fixtures, or user interface assets yet.
- The repository is clean against `origin/main` before this roadmap change.

After merging the existing primitive work on `main`, the active codebase is now a React + Node.js + Rust monorepo with the older Python/FastAPI prototype retained as migration reference. DockerMap is likely to touch host paths, container paths, bind mounts, named volumes, and eventually Docker Compose files, so the project should treat parsing accuracy and edit safety as core product requirements rather than implementation details.

## Second-Pass Review

The current implementation is a useful read-only prototype, but it is still early and split across multiple generations of the product:

- `apps/web` implements the React/Vite interface for dashboard, containers, images, networks, volumes, logs, and container detail.
- `apps/api` implements a Node/Express browser-facing API that proxies the Rust daemon and exposes an SSE heartbeat.
- `crates/dockermap-core` owns the Rust contracts, mock snapshot, graph derivation, image derivation, and mock log generation.
- `crates/dockermap-daemon` reads Docker through `bollard`, serves cached inventory endpoints, and falls back to mock data when Docker is unavailable.
- `dockermap/` and `main.py` are now legacy Python prototype code and should not remain an equal implementation path for long.

Validation performed on the merged primitive code:

- `npm install` completed successfully.
- `npm run typecheck` passes across the TypeScript workspaces.
- `npm audit --omit=dev` reports 0 production vulnerabilities after updating the lockfile.
- `npm audit` reports 0 vulnerabilities after the Vite 8 upgrade.
- `npm run build` passes across the TypeScript workspaces.
- `Cargo.lock` is generated for the Rust workspace.

Important review findings:

- A CI template now covers TypeScript audit/typecheck/build and Rust format/lint/test. Publishing it to `.github/workflows/` requires GitHub `workflow` scope.
- Runtime contracts are duplicated between TypeScript and Rust. The project needs a single source of truth or contract generation before the API surface grows.
- The Python prototype has been moved under `legacy/python-prototype`; remove it after useful behavior is migrated.
- The active product currently observes Docker runtime state; it does not yet parse or edit Docker Compose path mappings, which is the core promise implied by "Visualise and Edit Docker Paths".
- Docker socket access is read-oriented, but it is still privileged. The daemon should keep binding to loopback by default and document Docker socket risk before any mutation work.

## Product Vision

DockerMap should help developers understand and safely edit Docker path relationships across local Docker projects. The first useful version should answer three questions clearly:

1. Which host paths, container paths, named volumes, and compose-file declarations exist?
2. How are those paths connected across services, containers, and files?
3. What will change if the user edits a mapping?

The product should optimize for confidence: visual clarity, reversible edits, validation before write, and plain explanations of risky path changes.

## Target Users

- Developers maintaining Docker Compose based local environments.
- Operators debugging volume mounts, missing files, or unexpected container state.
- Teams standardizing compose files across services.
- AI-assisted coding workflows that need an inspectable map before editing Docker config.

## Guiding Principles

- Read first, edit second: every mutation should be previewed as a diff.
- Prefer structured Docker and YAML parsers over string edits.
- Preserve user formatting where feasible, and isolate formatting changes when not feasible.
- Keep host filesystem access explicit and narrow.
- Treat path edits as potentially destructive.
- Make the graph useful without requiring Docker daemon access, then enrich it when Docker is available.

## Proposed Architecture

### Core Modules

- `crates/dockermap-core`: represent services, mounts, volumes, host paths, container paths, graph relationships, diagnostics, and unresolved references.
- `crates/dockermap-daemon`: discover Docker runtime state, parse Compose/Dockerfile inputs, validate path mappings, and expose read-only HTTP endpoints.
- `packages/contracts`: publish TypeScript API contracts generated from or validated against Rust fixtures.
- `apps/api`: adapt daemon endpoints for browser clients, SSE heartbeats, and future auth/session policy.
- `apps/web`: render graph, table, diagnostics, and diff-preview workflows.
- Future CLI package or daemon subcommand: provide scriptable scan, validate, export, and dry-run edit commands.

### Suggested Stack

- Rust for Docker access, Compose/path parsing, validation, graph derivation, and future edit planning.
- Node/Express as the browser-facing API layer while the daemon remains local and loopback-bound.
- React/Vite for the current UI.
- TypeScript contracts generated from Rust schemas or checked by shared serialized fixtures before the API grows.
- Round-trip YAML handling for Compose edits once mutation work begins.
- Rust unit/fixture tests plus TypeScript typecheck/build and browser tests for critical UI paths.

## Roadmap

### Phase 0: Foundation And Baseline Hardening

- Keep the React + Node.js + Rust monorepo as the active implementation path.
- Move the Python prototype to `legacy/python-prototype`, then remove it after useful behavior is migrated.
- Add a GitHub Actions template for `npm ci`, TypeScript typecheck, web build, Rust format/lint/test, and dependency audit. Publish it under `.github/workflows/` once GitHub auth has `workflow` scope.
- Generate and commit `Cargo.lock`.
- Add Rust toolchain metadata.
- Add sample Docker Compose fixtures covering bind mounts, named volumes, relative paths, environment variables, read-only mounts, and multiple files.
- Resolve the Vite/esbuild audit findings through an intentional Vite 8 upgrade.
- Add a short architecture note that names Rust core/daemon as the Docker source of truth and TypeScript contracts as API consumers.

### Phase 1: Read-Only Map

- Keep the current Docker runtime inventory experience stable.
- Implement Compose file discovery from the current directory and explicit file paths.
- Parse services, bind mounts, named volumes, anonymous volumes, mount modes, and source file locations.
- Resolve relative host paths against the correct Compose file/project directory.
- Build a typed graph model.
- Add CLI or daemon commands:
  - `dockermap scan`
  - `dockermap validate`
  - `dockermap export --format json`
- Add diagnostics for unresolved environment variables and unsupported mount syntax.
- Correlate Compose declarations with observed Docker runtime state.

### Phase 2: Validation And Safety

- Add validation rules for missing host paths, duplicate container targets, ambiguous relative paths, read-only/write mismatch, and path traversal.
- Add severity levels: info, warning, error, blocked.
- Add machine-readable validation output for automation.
- Add tests for malformed Compose files and partial parsing.
- Add a threat model for host path exposure, symlink traversal, edit permissions, and Docker socket access.

### Phase 3: Editing Workflow

- Implement dry-run edits for bind mount source and target paths.
- Generate unified diffs before writing.
- Require explicit confirmation for destructive or broad edits.
- Preserve Compose file comments and ordering where possible.
- Create backup files or use git-aware safety checks before writes.
- Add rollback guidance for non-git worktrees.

### Phase 4: Visual Interface

- Build a first UI around the actual work surface, not a landing page.
- Include graph, table, diagnostics, and diff preview views.
- Support filtering by service, path type, severity, and file.
- Make unresolved or risky mappings visually distinct.
- Add keyboard-accessible controls and responsive layouts.
- Use Playwright checks for graph rendering, navigation, and edit preview flows.

### Phase 5: Docker Runtime Enrichment

- Optionally inspect running containers when Docker is available.
- Correlate Compose declarations with actual container mounts.
- Show drift between declared and running state.
- Keep daemon access optional and read-only by default.
- Document permissions and Docker socket risks clearly.

### Phase 6: Collaboration And Release

- Add saved reports for CI or pull request review.
- Add changelog and release workflow.
- Publish package artifacts if the CLI proves useful.
- Consider a desktop wrapper only after the UI and safety model are stable.

## Backlog

- Dockerfile `WORKDIR`, `COPY`, and `VOLUME` path extraction.
- Compose override file merging.
- `.env` interpolation with missing-variable diagnostics.
- Path normalization for Windows, WSL, macOS, and Linux.
- Named volume lifecycle hints.
- Export to Mermaid or Graphviz.
- Integration tests with a temporary Docker Compose project.
- Optional policy file for allowed host path roots.
- "Explain this mount" command for AI-assisted debugging.

## Security And Reliability Priorities

- Do not write to Docker files without showing a diff.
- Do not follow symlinks for validation unless the behavior is explicit.
- Avoid requiring Docker socket access for basic mapping.
- Treat Docker socket access as privileged and document the risk.
- Validate path edits against project root policy where configured.
- Keep structured parse errors visible rather than silently ignoring unsupported syntax.
- Add regression fixtures for every supported Compose syntax form.

## Definition Of Done For MVP

- A user can run DockerMap against a Compose project and see all detected bind mounts and named volumes.
- Relative paths resolve correctly and point back to the file and line where they were declared.
- Validation reports missing paths and duplicate container targets.
- JSON export is stable and tested.
- The project has CI, fixture tests, and documented setup.
- No edit command writes changes without a dry-run preview.

## Installed Skills Review

I reviewed the official OpenAI curated Codex skills catalog and high-signal GitHub results for Codex skill repositories. Relevant installed skills include:

- `figma-use`
- `security-best-practices`
- `security-threat-model`
- `security-ownership-map`
- `accessibility-basic-check`
- `css-layout-helper`
- `system-design-draft`
- `architecture-review`
- `domain-modeling`
- `roadmap-prioritization`
- `pr-reviewer`
- `unit-test-starter`
- `integration-test-planner`
- `security-quick-scan`
- `config-hardening`
- `observability-setup`

`webapp-testing` was already installed. Restart Codex to pick up newly installed skills.
