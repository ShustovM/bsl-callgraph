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
5 ms while the asynchronous indexer is active; it is an operational estimate,
not a language-runtime heap guarantee. Timings vary with hardware, filesystem
cache, Node.js version, antivirus software, and background load.

## Reference run

On 2026-09-04, the default profile on Node.js 22.15.0, Windows x64 produced:

| Metric | Result |
|---|---:|
| Files | 500 |
| Procedures/functions | 10,000 |
| Call candidates | 10,500 |
| Corpus generation | 763.785 ms |
| Indexing | 552.389 ms |
| Store load | 350.286 ms |
| Mean lookup operation (3,000 operations) | 0.019 ms |
| Sampled peak RSS delta | 54.64 MiB |

This is a reference measurement, not a performance guarantee. Release-gate
runs should retain their own JSON output as CI artifacts when practical.
