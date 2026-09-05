# Performance benchmark

`npm run benchmark` generates a deterministic synthetic BSL tree in the system
temporary directory, indexes it, loads the graph store, runs lookup queries,
prints a path-neutral JSON report, and removes the generated tree.

Default profile:

```console
npm run benchmark
```

Smaller or larger reproducible profiles can be selected explicitly:

```console
node scripts/benchmark.js --modules=1000 --methods=25 --queries=5000
```

The report includes corpus counts, generation/index/store-load durations, mean
query-operation latency, and a sampled peak process RSS. RSS is sampled every
5 ms throughout asynchronous indexing and store loading, with a final sample
after queries; it is an operational estimate,
not a language-runtime heap guarantee. Timings vary with hardware, filesystem
cache, Node.js version, antivirus software, and background load.

## Reference run

On 2026-09-05, the default profile on Node.js 22.15.0, Windows x64 produced:

| Metric | Result |
|---|---:|
| Files | 500 |
| Procedures/functions | 10,000 |
| Call candidates | 10,500 |
| Corpus generation | 2,368.494 ms |
| Indexing | 1,683.186 ms |
| Store load | 723.774 ms |
| Mean lookup operation (3,000 operations) | 0.044 ms |
| Sampled peak RSS delta | 54.88 MiB |

This is a reference measurement, not a performance guarantee. Release-gate
runs should retain their own JSON output as CI artifacts when practical.

## 1.1.0 large-corpus release check

A local release-gate run on 2026-09-05 used the same non-public BSL export as
the pre-hardening baseline. Only aggregate values are recorded here; no source
path, file, module, or symbol name is retained.

| Metric | 1.0.0 baseline | 1.1.0 release candidate |
|---|---:|---:|
| Files | 11,034 | 11,034 |
| Procedures/functions | 125,048 | 125,540 |
| Call candidates | 1,050,155 | 981,818 |
| Resolved / ambiguous / dynamic | not classified | 267,821 / 1,012 / 712,985 |
| Parser diagnostics | not recorded | 0 |
| Approximate indexing time | 15 s | 92.923 s |
| Graph-store load time | not recorded | 21.793 s |
| Mean lookup operation (3,000 operations) | not recorded | 0.019 ms |
| Sampled peak RSS | not recorded | 1.186 GiB |

The count changes are expected: query-string calls are now excluded, property
names no longer disrupt declaration parsing, and every remaining call is
classified explicitly. The older implementation did substantially less work,
so its indexing time is contextual rather than a performance target. These are
single local observations affected by filesystem cache and machine load.

The final implementation yields between scan, parse, resolution, sorting, and
store-load batches. During this run a 20 ms event-loop heartbeat ran 3,897
times, with a maximum gap of 980 ms. Individual file parsing, filesystem calls,
and garbage collection can still pause the event loop; there is no hard latency
guarantee. A separate synthetic stdio check with 400,000 call candidates served
116 `stats` requests while building, with a maximum measured round trip of
38 ms. The reference runs were performed under background load and are not a
controlled before/after performance comparison.
