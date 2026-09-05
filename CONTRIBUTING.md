# Contributing

Thank you for helping improve BSL CallGraph.

## Before opening a change

- Search existing issues and pull requests for related work.
- Keep changes focused and preserve existing MCP tool names unless a breaking
  change has been discussed first.
- Use only synthetic or redistributable BSL fixtures. Never commit customer
  code, private paths, credentials, internal host names, or generated indexes.

## Local setup

Use Node.js 22 or 24 and install the locked dependency tree:

```console
npm ci
npm test
```

Before submitting a packaging or release change, also inspect the package:

```console
npm audit --omit=dev --audit-level=high
npm pack --dry-run
```

Tests use the built-in `node:test` runner and should be deterministic on both
Windows and POSIX systems. Add a focused regression test for every parser,
resolver, graph, or lifecycle bug. Performance measurements must state the
corpus, runtime, platform, number of runs, and whether process startup is
included.

## Pull requests

Explain the user-visible behavior, verification commands, compatibility impact,
and known limitations. Keep unrelated formatting and refactoring out of the
same pull request. By contributing, you agree that your contribution is
licensed under the repository's MIT License.

Security vulnerabilities should be reported privately as described in
[`SECURITY.md`](SECURITY.md), not through a public issue.
