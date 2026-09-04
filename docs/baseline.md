# Baseline

This document records the behavior and indicative performance of the 1.0.0
implementation before the call-graph hardening work. It is evidence for later
comparisons, not a performance guarantee.

## Reproducible synthetic baseline

The repository contains a dedicated, stable synthetic BSL fixture with no production source,
user names, host names, or private paths. Run the same measurement with:

```console
npm run baseline
```

On 2026-09-04, commit `8698e29`, Node.js 22.15.0 on Windows x64 produced:

| Metric | Result |
|---|---:|
| Files | 1 |
| Procedures/functions | 4 |
| Call sites | 7 |
| Read/parse errors | 0 |
| Mean indexing time, 100 in-process runs | 1.249 ms |

The synthetic fixture confirms the original parser/store flow but is too small
for capacity conclusions. Process startup was excluded from the in-process
timing. Results vary with hardware, filesystem cache, Node.js version, and
background load.

The script prints JSON, deliberately labels the corpus instead of printing its
root path, and can measure another readable tree without exposing the path:

```console
node scripts/baseline.js --root <bsl-root> --label external-corpus --runs 1
```

Do not commit output derived from non-public source trees unless it has been
reviewed for sensitive names and paths.

## Observed large-repository baseline

A one-off local review of a non-public BSL export on 2026-09-04 produced these
aggregate counts:

| Metric | Result |
|---|---:|
| Files | 11,034 |
| Procedures/functions | 125,048 |
| Call sites | 1,050,155 |
| Approximate indexing time | 15 seconds |

Only aggregate counts are retained. The corpus path, file names, module names,
symbol names, and source text are intentionally absent. The timing was not a
controlled benchmark and must not be presented as a generally reproducible
result. A generated large-corpus benchmark is planned for repeatable capacity
testing.
