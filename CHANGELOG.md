# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-09-05

### Added

- Reproducible synthetic baseline command and an anonymized baseline report.
- Stateful BSL lexer, canonical module identities, and second-pass edge resolver.
- Structured MCP responses, pagination, exact/exploratory graph modes, and
  atomic index generations.
- Generated large-corpus performance benchmark and GitHub CI/security templates.
- Locked npm dependency tree and explicit package/runtime metadata.
- Standalone license, security policy, and contribution guidance.

### Changed

- Test execution now uses Node.js' built-in test runner.
- Documentation uses neutral paths and qualifies accuracy and performance
  claims.
- Exact dependency and impact queries now exclude ambiguous/dynamic candidates
  unless exploratory mode is explicitly requested.

### Fixed

- Multiline BSL string fragments, including intervening comment lines, no
  longer produce query-language calls.
- `Procedure`/`Function` property names no longer disrupt declaration parsing;
  Russian and English async declarations are recognized explicitly.
- Calls through indexed values, call results, and property chains remain
  dynamic instead of being resolved as unrelated local or module methods.
- File/directory read failures retain the last complete index generation.
- Large index builds yield to MCP requests throughout scanning, resolution,
  sorting, and store loading; high-fan-in requests no longer exhaust the
  JavaScript argument stack.

## [1.0.0] - 2026-05-23

### Added

- Initial stdio MCP server with BSL source indexing.
- Symbol lookup, substring search, callers, callees, impact, reindexing, and
  statistics tools.

[Unreleased]: https://github.com/ShustovM/bsl-callgraph/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/ShustovM/bsl-callgraph/compare/8698e29...v1.1.0
[1.0.0]: https://github.com/ShustovM/bsl-callgraph/tree/8698e29
