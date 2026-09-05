# Design: harden BSL CallGraph and prepare release 1.1.0

## Status

Implemented locally through sections 1–8. Release verification, push, tag, and
published-install checks remain open in section 9 of `tasks.md`.

## Goal

Turn the current useful prototype into a dependable public MCP server for
navigating large BSL repositories. Preserve the lightweight local-first model
and existing MCP tool names while making graph results explicit about their
accuracy, adding real verification, and completing repository/release hygiene.

## Current baseline

- The server successfully indexes the configured working tree: 11,034 files,
  125,048 procedures/functions, and 1,050,155 call sites.
- Search and definition lookup are fast and materially reduce agent context.
- Runtime security is strong by construction: local read-only `.bsl` access,
  no shell execution, no code execution, no remote requests.
- `npm audit` reported zero known vulnerabilities on 2026-09-04.
- The current parser is line-oriented and regex-based. In a live check it
  reported `ЕСТЬNULL()` and `ЗНАЧЕНИЕ()` from a multiline query string as BSL
  calls and treated `Запрос.УстановитьПараметр()` as a module call.
- The current test script has output checks but no assertions. The repository
  has no lockfile, CI, tags/releases, standalone license file, or security and
  contribution guidance.

## Chosen approach

Keep Node.js and the stdio MCP architecture. Replace the single-pass heuristic
with a small, dependency-light analysis pipeline:

1. **Scan** canonical `.bsl` files under the configured root.
2. **Lex** source with state carried across lines so comments, ordinary strings,
   multiline strings/query text, and escaped quotes cannot create call edges.
3. **Collect symbols** using canonical module identities derived from the full
   relative path and module kind, with a separate human-readable display name.
4. **Collect call candidates** without prematurely assuming that every
   `Receiver.Method()` receiver is a common module.
5. **Resolve edges in a second pass** against the complete symbol/module table.
6. **Classify every candidate** as `resolved`, `ambiguous`, or `dynamic`.
7. **Build and atomically swap** immutable lookup indexes after a successful
   indexing generation.

The default callers/impact view will use resolved edges. An explicit option
will expose ambiguous candidates when an agent needs exploratory results.

### Resolution rules

- An unqualified call first resolves to a symbol in the current canonical
  module.
- A qualified call resolves as a module call only when the qualifier matches a
  known module identity/display alias and the target symbol exists there.
- A uniquely matching exported common-module method may be resolved globally.
- Multiple valid targets remain `ambiguous`; object/variable receivers remain
  `dynamic`. Neither category silently enters the exact impact graph.
- Symbol identity includes canonical module ID and normalized method name;
  display names never serve as unique keys.

## MCP compatibility and output

Existing tool names remain available: `find_symbol`, `search_symbols`,
`get_callers`, `get_callees`, `get_impact`, `reindex`, and `stats`.

Responses will keep a concise text representation for existing agents and add
structured content for reliable machine consumption. List tools receive bounded
`limit`/cursor controls. Dependency responses include resolution/confidence and
canonical file/line provenance. `get_impact` remains bounded by depth and also
gets a result limit.

`reindex` will await the requested generation, report its new generation ID and
timestamp, and retain the previous good index if rebuilding fails. Concurrent
reindex requests will join or reject deterministically instead of reporting old
statistics as a new result.

## Verification strategy

Use an assertion-based test runner and synthetic fixtures only. Tests cover:

- Russian and English procedure/function declarations;
- comments, escaped quotes, multiline strings, and embedded query text;
- local, qualified-module, dynamic-object, ambiguous, and recursive calls;
- duplicate display names across forms, object modules, and manager modules;
- callers/callees/impact cycles and depth/limit behavior;
- initial indexing, failed indexing, and concurrent/awaited reindexing;
- MCP stdio handshake, schemas, structured output, and error responses;
- Windows and POSIX path normalization, Unicode, spaces, and unreadable files;
- a generated large-corpus benchmark with recorded time and memory figures.

Release gates:

- all tests pass on Node.js 22 and 24, Windows and Ubuntu;
- the known query-text false positives are absent;
- exact impact never includes ambiguous/dynamic edges by default;
- `npm audit --omit=dev --audit-level=high` succeeds;
- `npm pack --dry-run` contains only intended runtime/docs files;
- CodeQL and CI are green;
- installation is verified from a clean clone.

## Repository and security work

- Commit `package-lock.json` and use reproducible `npm ci` in CI.
- Add `files`, `bin`, `engines`, repository/homepage/bugs metadata, and keep the
  package CommonJS unless migration provides a concrete benefit.
- Add MIT `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, GitHub
  Actions CI/CodeQL, Dependabot, issue forms, and a pull-request template.
- Replace personal absolute paths in examples with neutral placeholders.
- Document that source is processed locally, but symbol names and file paths
  returned by tools become visible to the connected agent/MCP client.
- Canonicalize the configured root, validate that it is a readable directory,
  do not follow directory symlinks/junctions by default, and never accept a new
  filesystem root from a tool argument.

## Versioning and release

Target `v1.1.0`: existing tools remain, while correctness, optional parameters,
structured content, and repository infrastructure are added. Publish a GitHub
Release after all gates pass. npm registry publication is a separate opt-in
decision and is not required for this change.

## Alternatives considered

### Patch the existing regular expressions

Rejected. It may hide the demonstrated query-text case but will continue to
produce new false positives because string state, receiver identity, and symbol
resolution are cross-line/cross-file problems.

### Require BSL Language Server / a full external AST

Deferred. It offers higher language fidelity but adds a Java runtime, process
management, slower installation, and a much larger operational surface. The
new pipeline keeps an adapter boundary so an exact AST provider can be added
later without changing MCP tools.

### Persist the million-edge index to a database

Deferred. The current in-memory implementation is already fast enough for the
observed repository. First measure peak memory and indexing time; add an
optional persistent backend only if benchmarks show a real need.

## Risks and mitigations

- **False negatives after tightening resolution:** expose ambiguous/dynamic
  candidates explicitly and provide an opt-in exploratory mode.
- **Output compatibility:** retain text content and tool names; add fields and
  optional parameters rather than removing existing behavior.
- **Memory growth:** avoid duplicate edge objects where practical, benchmark the
  million-edge case, and cap all MCP outputs.
- **Path differences:** test Windows/POSIX separators, Unicode, spaces, and
  canonical relative paths in CI.
- **Overclaiming accuracy:** document the resolver's guarantees and remaining
  heuristic boundaries; never describe the graph as compiler-exact.

## Non-goals

- Executing or compiling BSL code.
- Editing the indexed configuration.
- Sending source code to a remote service.
- Full type inference for arbitrary object receivers.
- Replacing BSL Language Server diagnostics.
