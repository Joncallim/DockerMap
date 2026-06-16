# Legacy Python Prototype

This directory contains the earlier FastAPI/Python prototype. It is preserved as migration reference only.

The active DockerMap implementation is the React + Node.js + Rust monorepo at the repository root:

- `apps/web`
- `apps/api`
- `crates/dockermap-core`
- `crates/dockermap-daemon`
- `packages/contracts`

New product work should target the active stack. If a behavior from this prototype is still useful, migrate it into the Rust core/daemon or React interface, then remove the legacy copy.
