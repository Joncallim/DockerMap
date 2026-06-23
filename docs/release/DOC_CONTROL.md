# Documentation Control

DockerMap docs are part of the release surface. Changes that affect deployment,
security, API behavior, user-visible workflows, or test expectations must update the
relevant docs in the same pull request.

## Controlled Docs

- `README.md`: product scope, quick start, and main command list.
- `docs/architecture/ARCHITECTURE.md`: source-of-truth data flow and component responsibilities.
- `docs/deployment/DEPLOYMENT.md`: host deployment and systemd/reverse-proxy checklist.
- `docs/deployment/REVERSE_PROXY.md`: remote review exposure model and proxy requirements.
- `docs/deployment/DOCKER.md`: single-container Docker/Compose build and run instructions.
- `docs/testing/TESTING_PLAN.md`: local, CI, E2E, live-Docker, and security test commands.
- `docs/security/THREAT_MODEL.md`: risks, controls, and security test expectations.
- `docs/release/RELEASE_CHECKLIST.md`: release gates, evidence, and known follow-up work.

## Update Triggers

Update controlled docs when any of these change:

- Environment variables or defaults.
- Public API routes, request parameters, response shapes, or auth behavior.
- Daemon bind behavior, Docker access, host-provider commands, or path validation.
- Reverse-proxy assumptions, token handling, CORS behavior, or SSE behavior.
- Build, test, smoke, deployment, or release commands.
- Any feature that changes read-only guarantees or introduces write behavior.

## Review Rules

Every release PR should include these checks:

- Docs mention the same command names as `package.json` and CI.
- Security docs describe the current controls, not planned controls.
- Deployment docs include explicit negative checks such as unauthenticated `401` and private daemon access.
- Test docs distinguish default CI tests from opt-in live-Docker tests.
- Release notes list skipped tests and known limitations.

## Versioning Rules

- Private review releases use `v0.x.0-alpha.N` or `v0.x.0-alpha`.
- Wider beta releases use `v0.x.0-beta.N` only after live-Docker and proxy smoke evidence exists.
- Do not tag a release from a dirty worktree.
- Do not tag a release if controlled docs are stale relative to behavior.

## Evidence Rules

Release evidence should be concrete command output or links to CI runs. At minimum,
capture `npm run check`, `npm run test:e2e`, `npm run test:live-docker`,
`npm run build:deploy`, and reverse-proxy smoke results.
