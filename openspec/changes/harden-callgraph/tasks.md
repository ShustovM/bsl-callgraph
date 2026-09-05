# Tasks: harden BSL CallGraph and release 1.1.0

Implementation starts only after plan approval. Keep commits atomic and run the
relevant focused tests before each commit.

## 1. Baseline and public repository hygiene

- [x] Capture current functional/performance baseline on the synthetic fixture
  and the configured large repository without committing private paths/data.
- [x] Add `package-lock.json`, deterministic scripts, supported Node.js engines,
  package `files` allowlist, executable `bin`, and complete repository metadata.
- [x] Add MIT `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, and `CHANGELOG.md`.
- [x] Neutralize personal paths and qualify performance/accuracy claims in the
  README.

## 2. Real test foundation

- [x] Replace the print-only test script with assertion-based unit tests.
- [x] Add focused fixtures for Russian/English syntax, comments, escaped quotes,
  multiline query strings, multiline declarations, and Unicode paths.
- [x] Add regression tests reproducing the observed `ЕСТЬNULL`, `ЗНАЧЕНИЕ`, and
  `Запрос.УстановитьПараметр` false-positive cases.
- [x] Add store tests for duplicate module display names, ambiguity, cycles,
  depth, deduplication, ordering, limits, and pagination.

## 3. Stateful lexer and parser

- [x] Introduce a lexer that preserves source locations while carrying string
  and comment state across lines.
- [x] Parse declarations and call candidates from lexer output; do not classify
  arbitrary receivers as modules during parsing.
- [x] Return diagnostics for malformed/unclosed constructs without crashing the
  entire index.
- [x] Verify parser regressions and document supported BSL constructs.

## 4. Canonical modules and edge resolver

- [x] Model canonical module identity from full relative path, object kind,
  module kind, and form/command identity where applicable.
- [x] Keep human-readable aliases separate from unique keys.
- [x] Build a second-pass resolver for local, known-module, uniquely exported,
  ambiguous, and dynamic calls.
- [x] Store confidence/resolution reason and target provenance on every edge.
- [x] Make resolved-only the exact graph and expose ambiguous/dynamic candidates
  through an explicit option.

## 5. Graph store and bounded MCP API

- [x] Rebuild lookup indexes around canonical symbol and edge IDs with stable,
  deterministic ordering.
- [x] Add bounded limits/cursors to callers, callees, search, and impact tools.
- [x] Add structured MCP results while preserving concise text responses and
  current tool names.
- [x] Include confidence, canonical module, file, and line in dependency output.
- [x] Add `server_info`/capabilities and an explicit index state/generation to
  status output.

## 6. Reliable indexing lifecycle

- [x] Validate and canonicalize the configured root at startup; define the
  symlink/junction policy and ignore rules.
- [x] Move scanning/parsing off the MCP handshake critical path and expose
  `building`, `ready`, and `failed` states.
- [x] Build each generation separately and atomically swap it only on success.
- [x] Make `reindex` await completion and return the new generation/timestamp;
  handle concurrent requests deterministically.
- [x] Retain the last good index and surface bounded diagnostics if rebuild fails.

## 7. Integration, performance, and security verification

- [x] Add MCP stdio integration tests for initialization, all tool schemas,
  readiness errors, structured content, and reindex behavior.
- [x] Add a generated large-corpus benchmark for indexing time, query latency,
  and peak memory; publish reproducible commands and measured figures.
- [x] Verify that tools cannot change the configured root, write files, execute
  BSL, follow excluded links, or emit unbounded output.
- [x] Run dependency audit and clean-package inspection.

## 8. GitHub automation and documentation

- [x] Add CI for Node.js 22/24 on Ubuntu and Node.js 22 on Windows.
- [x] Add CodeQL, Dependabot, issue forms, pull-request template, and CODEOWNERS.
- [x] Rewrite quick-start examples for Codex, Claude Code, and a generic stdio
  MCP client.
- [x] Document exact versus exploratory graph modes, privacy boundaries,
  limitations, troubleshooting, and clean uninstall.

## 9. Release 1.1.0

- [x] Run the full release gates from a clean clone.
- [x] Verify live behavior against the configured large BSL tree and compare
  results with the captured baseline.
- [x] Review the public diff for personal paths, secrets, internal hostnames, and
  generated artifacts.
- [x] Merge/push the approved changes, create annotated tag `v1.1.0`, and publish
  a GitHub Release with migration and limitation notes.
- [x] Verify anonymous clone/install and MCP startup from the published tag.

## Completion evidence — 2026-09-05

- PR: https://github.com/ShustovM/bsl-callgraph/pull/1
- Release: https://github.com/ShustovM/bsl-callgraph/releases/tag/v1.1.0
- Annotated tag targets merge commit `a6bb885be512b249b07a7cce82c4a38b410b08fd`.
- 51 tests pass; Node.js 22/24 Ubuntu and Node.js 22 Windows CI are green.
- Release-commit CI: https://github.com/ShustovM/bsl-callgraph/actions/runs/33952997068
- Release-commit CodeQL: https://github.com/ShustovM/bsl-callgraph/actions/runs/33952997052
- Dependency audit: zero vulnerabilities. CodeQL: zero open alerts.
- Inspected 21-file tarball installed and initialized successfully with eight
  MCP tools. Anonymous clone of the published tag, `npm ci`, and MCP startup
  also succeeded.
- Aggregate large-corpus results and measured limitations are recorded in
  `docs/performance.md`; private source and paths were not committed.
