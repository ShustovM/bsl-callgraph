# BSL CallGraph MCP Server

BSL CallGraph is a local stdio MCP server for navigating call relationships in
1C:Enterprise (BSL) source exports. It indexes `.bsl` files in memory and gives
an MCP client compact tools for finding definitions, callers, callees, and a
transitive impact set.

The analyzer is static and intentionally lightweight. It helps explore large
repositories without repeatedly opening many files, but it is not a BSL
compiler or a complete type-inference engine. Treat graph results as navigation
evidence and review the relevant source before making a high-risk change.

## Requirements

- Node.js 22 or 24
- npm
- A readable directory containing exported `.bsl` files

No C++ toolchain, Java runtime, database, or network connection is required at
runtime.

## Install from source

```console
git clone https://github.com/ShustovM/bsl-callgraph.git
cd bsl-callgraph
npm ci
npm test
```

Start the stdio server with the BSL root as its only positional argument:

```console
npm start -- /absolute/path/to/bsl-export
```

When the package is installed as a command-line package, the equivalent command
is:

```console
bsl-callgraph /absolute/path/to/bsl-export
```

The server writes protocol messages to standard input/output and diagnostic
progress to standard error. It is normally launched by an MCP client, not used
as an interactive shell command.

## MCP client configuration

Every client must launch the server with exactly one fixed BSL root. The root
is chosen in client configuration and cannot be replaced by a tool call.

### Codex CLI

After installing or linking the command, register the local stdio server:

```console
codex mcp add bsl-callgraph -- bsl-callgraph /work/bsl-export
codex mcp get bsl-callgraph
```

Use absolute paths on Windows. `codex mcp remove bsl-callgraph` removes the
registration.

### Claude Code

Claude Code uses the same stdio command form:

```console
claude mcp add bsl-callgraph -- bsl-callgraph /work/bsl-export
claude mcp get bsl-callgraph
```

Add `--scope project` before `--` only when the repository should intentionally
share this local server configuration.

### Generic stdio MCP client

Point the client at Node.js, this repository's server entry point, and the BSL
root. For example on a POSIX system:

```json
{
  "mcpServers": {
    "bsl-callgraph": {
      "command": "node",
      "args": [
        "/opt/bsl-callgraph/src/mcp-server.js",
        "/work/bsl-export"
      ]
    }
  }
}
```

On Windows, use absolute paths and escape backslashes in JSON:

```json
{
  "mcpServers": {
    "bsl-callgraph": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\Tools\\bsl-callgraph\\src\\mcp-server.js",
        "D:\\Work\\bsl-export"
      ]
    }
  }
}
```

The exact configuration-file location and reload procedure depend on the MCP
client. Consult that client's current documentation. The Codex command shape
above was verified against the installed CLI; the Claude Code form follows its
official MCP documentation.

## Tools

### `find_symbol`

Find procedure or function definitions by exact, case-insensitive name.

- `name` — required procedure/function name.
- `module` — optional display alias or canonical module ID.
- `limit` — optional result limit from 1 to 200; default is 50.
- `cursor` — optional opaque cursor from the preceding page.

### `search_symbols`

Search definitions by a case-insensitive name substring.

- `query` — required substring.
- `module` — optional display alias or canonical module ID.
- `limit` — optional result limit from 1 to 200; default is 50.
- `cursor` — optional opaque cursor from the preceding page.

### `get_callers`

Find procedures/functions that contain a call to a named symbol.

- `name` — required callee name.
- `module` — optional target-module filter.
- `mode` — `exact` by default, or `exploratory`.
- `limit` — optional result limit from 1 to 200; default is 50.
- `cursor` — optional opaque cursor from the preceding page.

### `get_callees`

Find call candidates inside a named procedure/function.

- `name` — required caller name.
- `module` — optional caller-module filter.
- `mode` — `exact` by default, or `exploratory`.
- `limit` — optional result limit from 1 to 200; default is 50.
- `cursor` — optional opaque cursor from the preceding page.

### `get_impact`

Walk callers transitively to estimate the impact radius of a change.

- `name` — required starting symbol name.
- `module` — optional starting-module filter.
- `depth` — optional traversal depth from 1 to 10; default is 5.
- `mode` — `exact` by default, or `exploratory`.
- `limit` — optional result limit from 1 to 200; default is 50.
- `cursor` — optional opaque cursor from the preceding page.

### `reindex`

Re-scan the configured root after its BSL files change. The call waits for the
new generation to be built and atomically published. Concurrent calls join the
same build. A failed rebuild leaves the preceding good generation available.
The tool does not accept a new filesystem root.

### `stats`

Return `building`, `ready`, or `failed` state, generation, timestamp, bounded
diagnostics, resolution counts, and index counts. The configured absolute root
is deliberately omitted from tool results.

### `server_info`

Return the server version and machine-readable capabilities, including page and
impact limits, graph modes, link policy, structured output, and immutable-root
behavior.

Every tool returns concise text plus `structuredContent`. List tools use opaque
cursors: do not inspect or modify a cursor, and do not reuse it with different
arguments or after a new index generation.

## Exact and exploratory graphs

The resolver classifies each call candidate as:

- `resolved` — one target is known, with its canonical module and provenance;
- `ambiguous` — several valid targets remain;
- `dynamic` — a variable/object receiver or unknown target needs runtime type
  information.

`exact` callers, callees, and impact include only resolved edges. Use
`mode: "exploratory"` when possible ambiguous or dynamic candidates are useful.
Exploratory results include their resolution reason, confidence, candidate
targets, and source location; they are not silently treated as proven impact.

## Accuracy and performance boundaries

BSL CallGraph recognizes Russian and English `Procedure`/`Function` declarations,
`Async`, and `Export`, including multiline signatures. Its stateful lexer
carries BSL string and `//` comment state across lines, handles doubled quotes,
and accepts comment lines between `|`-prefixed string fragments, so query text
does not become graph edges. Calls are collected as candidates and resolved only
after every module is known. Static analysis still has important limits:

- dynamic dispatch and values stored in variables may not resolve to one target;
- duplicate symbol or module display names can be ambiguous;
- preprocessor behavior, type inference, and runtime metadata are not evaluated;
- malformed source can reduce the completeness of one file's results;
- measured indexing time depends on filesystem, hardware, Node.js version,
  source layout, and background load.

Do not interpret the output as compiler-exact proof that a call is present or
absent. After indexing, many lookups use in-memory maps and are typically fast,
but the project does not promise a fixed latency or token-saving ratio.

The checked-in [baseline](docs/baseline.md) records a reproducible synthetic
fixture and an anonymized one-off observation from a larger repository. Use
`npm run baseline` to measure the public fixture on your machine. The generated
[performance benchmark](docs/performance.md) measures indexing, store loading,
queries, and sampled peak RSS without committing a source corpus or its path.

## Privacy and security

Parsing and indexing happen in the local Node.js process. The server is designed
to read BSL source under the root supplied at startup; it does not execute BSL
or require network access.

MCP responses can contain symbol and module names, canonical module IDs,
relative file paths, and line locations. Those results are visible to the
connected MCP client and may be handled by a remote agent or service according
to that client's policy. The absolute configured root is used locally but not
returned by tools; the client configuration itself necessarily contains the
launch argument. Review the client configuration before indexing confidential
source.

Report security issues privately as described in [SECURITY.md](SECURITY.md).

## Development

```console
npm ci
npm test
npm run baseline
npm run benchmark
npm audit --omit=dev --audit-level=high
npm pack --dry-run
```

Tests and committed fixtures must be synthetic and free of private paths or
customer data. See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution and
verification checklist.

## Project layout

```text
bin/                 executable package entry point
docs/                maintained project notes and baselines
scripts/             repository maintenance scripts
src/parser.js        BSL parsing and call-candidate extraction
src/lexer.js         stateful BSL tokenization and source locations
src/resolver.js      second-pass call-edge classification
src/indexer.js       recursive source discovery and indexing
src/index-manager.js atomic indexing generations and lifecycle
src/store.js         in-memory call-graph indexes and queries
src/mcp-server.js    stdio MCP server and tool definitions
test/                node:test suites and synthetic fixtures
```

## Troubleshooting and uninstall

- `Index is being built` is expected immediately after startup; poll `stats` or
  retry after it reports `ready`.
- A `failed` state includes a bounded error. Fix root permissions or malformed
  configuration and call `reindex`; an earlier good generation remains usable.
- An invalid cursor usually means the query arguments or generation changed;
  restart pagination without a cursor.
- If the process exits at startup, verify Node.js 22/24 and that the one root
  argument names a readable directory.

To uninstall, remove the MCP registration from the client, stop any running
server process, and remove the package (`npm uninstall -g bsl-callgraph`) or the
source checkout. The server creates no database or cache to clean up.

## License

[MIT](LICENSE)
