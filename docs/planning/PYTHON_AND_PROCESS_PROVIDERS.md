# Python And Native Process Provider Plan

This plan defines how DockerMap should add Python application and native-process
providers before any collector code is written. The goal is to make these providers peers
in the read-only runtime map without scanning the whole host, exposing secrets, or adding
controls that can change running services.

## Goals

- Represent Python applications and ordinary host processes in `GET /daemon/runtime/map`.
- Reuse the existing runtime-map concepts for services, packages, processes, edges, and
  diagnostics.
- Prefer explicit evidence over guesses, and explain heuristic edges with metadata.
- Keep every source fixed, local, bounded, and read-only.
- Keep tests runnable from fixtures without a real production host.

## Non-Goals

- No process start, stop, restart, signal, kill, reload, or package-install actions.
- No user-supplied shell commands.
- No process environment dumps.
- No log, stdout, stderr, terminal scrollback, process memory, open-file, or file-descriptor
  scraping.
- No `.env`, `.pypirc`, `pip.conf`, `pip.ini`, Poetry auth config, private-index config, or
  credential-file reads.
- No package registry, advisory, DNS-provider, or other external-network lookup by default.
- No recursive home-directory, virtualenv, cache, or host-wide filesystem crawl.

## Contract Fit

The current contracts already contain most of the vocabulary needed for a first pass:

- Python application nodes can use `provider: "process"` and `type:
  "python_application"` for the first collector, because the current contracts do not
  include a separate `python` provider.
- Native process nodes can use `provider: "process"` and `type: "process"` or `type:
  "worker"` when evidence is strong enough.
- Package metadata can use existing `package` and `package_dependency` node types with
  `manager: "pip"` once Rust and TypeScript contract shapes are intentionally aligned.
- Provider-neutral service fields should stay the long-term target, but the first Rust
  implementation can keep metadata string-only until richer runtime-node fields are added
  to Rust and fixture drift checks cover both languages.

Do not add a new `python` provider enum in the first collector unless fixtures prove that
Python project discovery cannot be represented clearly with `provider: "process"`,
`type: "python_application"`, `package`, and `package_dependency` vocabulary. If a later
provider enum is needed, make it a separate contract issue before collector work lands.

## Data To Expose

Python application nodes may expose:

- Stable node id derived from safe project-relative evidence, not raw secret-bearing paths.
- Project or package name when read from safe manifest fields.
- Project-relative path under `DOCKERMAP_PROJECT_ROOT`.
- Manifest type: `pyproject.toml`, `requirements.txt`, `Pipfile`, `poetry.lock`,
  `uv.lock`, `setup.cfg`, or conservatively parsed `setup.py` metadata.
- Declared version and Python version markers when available from safe manifest fields.
- Entrypoint file basename when known from safe manifest metadata.
- Lockfile presence and package-manager hint such as `pip`, `poetry`, `uv`, or `pipenv`.
- Capped dependency names and versions when parsed from safe local files.
- Framework hints derived from dependency names or safe manifest fields, with evidence
  metadata.

Native process nodes may expose:

- Stable node id derived from pid plus safe process identity for the current snapshot.
- Pid and parent pid.
- Executable basename or command name.
- Sanitized command summary. Raw argv and raw `ps args` must never leave the provider
  boundary in API responses, fixtures, logs, diagnostics, screenshots, docs, or issue
  comments.
- Process status and start-time or uptime fields when read from fixed local sources.
- User or uid if readable without privilege escalation.
- Cwd only when the resolved path is inside a documented project root; otherwise expose a
  redacted or omitted location.
- Runtime hints such as `python`, `node`, `binary`, or `shell` when derived from command
  basename and not from sensitive args.

Edges may expose:

- Process `runs_on` host.
- Python application `runs_on` process when the process cwd is under the project root.
- Process `managed_by` or `related_to` systemd, PM2, tmux, or scheduled-job nodes only when
  there is explicit evidence such as main pid, cwd, or a known manager output.
- Python application `contains` package dependency nodes when dependency files are parsed.

Every heuristic edge must include metadata such as `evidence=proc_cwd`,
`evidence=project_manifest`, or `evidence=systemd_main_pid`. Defer process-to-listener
edges unless a future safe source provides pid/listener evidence without reading
`/proc/<pid>/fd` targets.

## Data To Avoid

Providers must not expose:

- Environment variable values or raw `/proc/<pid>/environ`.
- Raw argv or raw `ps args`, even when they do not appear secret-like.
- Full cwd paths outside `DOCKERMAP_PROJECT_ROOT`.
- Secret-bearing package options such as `--index-url`, `--extra-index-url`, trusted-host
  credentials, auth headers, or private repository URLs.
- Process memory, maps, open files, fd targets, stdin/stdout/stderr, terminal scrollback, or
  logs.
- Dependency cache contents, virtualenv package trees, home-directory config, or arbitrary
  filesystem contents.

## Fixed Read-Only Sources

Preferred native-process sources on Linux:

- `/proc/<pid>/stat`
- `/proc/<pid>/status`
- `/proc/<pid>/cmdline`
- `/proc/<pid>/cwd` symlink target

If `/proc` is unavailable, a future fallback may use only a fixed command with no user input:

```bash
ps -eo pid,ppid,user,stat,lstart,comm,args
```

Preferred Python project files under the configured project root:

- `pyproject.toml`
- `requirements.txt`
- `requirements/*.txt`
- `Pipfile`
- `poetry.lock`
- `uv.lock`
- `setup.cfg`
- `setup.py`, metadata only, parsed conservatively without executing it

Do not execute Python, import project modules, run package managers, or contact registries.

## Discovery Bounds

Python project discovery must follow the existing npm provider pattern:

- Start under `DOCKERMAP_PROJECT_ROOT` or the daemon working directory.
- Reuse the general directory traversal cap and stop when it is hit.
- Enforce these minimum hard caps before implementation:
  - `MAX_PYTHON_PROJECTS = 64`
  - `MAX_PYTHON_DEPENDENCIES_PER_PROJECT = 64`
  - `MAX_PYTHON_MANIFEST_BYTES = 262144`
  - `MAX_PROVIDER_DIAGNOSTICS = 128`
- Skip `.git`, `.hg`, `.svn`, `.venv`, `venv`, `env`, `__pycache__`, `site-packages`,
  `.mypy_cache`, `.pytest_cache`, `.tox`, `.ruff_cache`, `dist`, `build`, `target`,
  `node_modules`, `coverage`, and cache directories.

Native process discovery should be Linux-first, use `/proc`, cap the number of process
entries inspected, and never recurse into cwd trees. Unreadable or short-lived processes are
normal and should produce capped diagnostics instead of failing the runtime-map endpoint.
Enforce these minimum hard caps before implementation:

- `MAX_NATIVE_PROCESSES = 256`
- `MAX_PROCESS_CMDLINE_BYTES = 8192`
- `MAX_PROCESS_STATUS_BYTES = 65536`
- `MAX_PROCESS_CWD_BYTES = 4096`
- `MAX_PROVIDER_DIAGNOSTICS = 128`

## Diagnostics

Use diagnostics instead of endpoint failures for expected provider limits:

- Unsupported platform.
- `/proc` unavailable or partially unreadable.
- Process disappeared during inspection.
- Process count capped.
- Process cmdline, status, or cwd value capped.
- Python project count capped.
- Manifest too large.
- Manifest parse failed.
- Path skipped because it is outside the project root.
- Secret-like command, path, manifest, or dependency value redacted or omitted.
- Optional fixed command unavailable.

Diagnostic text must not include raw secrets, raw argv, private URLs, or full paths outside
the allowed root.

## Fixture And Test Plan

Implementation follow-ups should add fixture-first coverage before enabling live collection:

- Fake `/proc` trees for normal processes, short-lived processes, unreadable fields, cwd
  outside the project root, and secret-bearing cmdline values.
- Optional fake `ps` output if a fallback parser is implemented.
- Python manifest fixtures for `pyproject.toml`, `requirements.txt`, `Pipfile`, `poetry.lock`,
  `uv.lock`, and oversized/invalid manifests.
- Redaction sentinels using `DOCKERMAP_TEST_FAKE_*` in process args, manifest URLs, dependency
  options, project paths, diagnostics, and edge metadata.
- Cap fixtures for too many processes, too many projects, too many dependencies, and too-large
  manifests.
- Contract fixtures showing a Python application node, a native process node, and a
  project-cwd edge.
- A negative fixture proving the process provider does not read `/proc/<pid>/fd` entries or
  fd targets while building process nodes.

Default tests must not require Docker, systemd, tmux, Python services, real `/proc` contents,
or external network access.

## Follow-Up Issues

1. Add bounded Python project manifest parser fixtures and redaction tests.
2. Add Linux `/proc` native-process parser fixtures with caps and soft diagnostics.
3. Add shared runtime-map fixture examples for Python application and native-process nodes;
   expand contracts only if fixtures prove the existing vocabulary is insufficient.
4. Implement the bounded Python project collector under `DOCKERMAP_PROJECT_ROOT`.
5. Implement the native-process collector behind hard process caps.
6. Add cross-provider edge derivation for process-to-host, process-to-Python-project, and
   manager-to-process relationships with evidence metadata.
7. Run a `security-readonly` review before enabling either provider by default.
8. Defer process-to-listener edge derivation to a separate security-reviewed issue unless a
   safe source provides pid/listener evidence without reading `/proc/<pid>/fd` targets.
9. Add API proxy and contract tests proving `/api/runtime/map` returns the new provider
   nodes with the same auth, CORS, query-limit, and daemon-error redaction guarantees as
   existing read-only routes.
10. Update deployment, security, testing, and release docs after implementation to record the
   exact sources read, caps used, skipped data, and validation commands.
11. Teach the web app to consume provider nodes from `/api/runtime/map` in a separate
   frontend issue.
