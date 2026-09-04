'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseArguments, runBenchmark } = require('../scripts/benchmark');

test('generated benchmark is bounded, path-neutral, and reproducible in a small profile', async () => {
  assert.deepEqual(parseArguments(['--modules', '3', '--methods', '4', '--queries', '5']), {
    modules: 3,
    methods: 4,
    queries: 5,
  });
  assert.throws(() => parseArguments(['--modules', '0']), /from 1/iu);

  const report = await runBenchmark({ modules: 3, methods: 4, queries: 5 });
  assert.equal(report.generatedCorpus.files, 3);
  assert.equal(report.generatedCorpus.procedures, 12);
  assert.equal(report.generatedCorpus.callCandidates, 15);
  assert.equal(report.queries.operationsPerIteration, 3);
  assert.ok(report.indexingMilliseconds >= 0);
  assert.ok(report.memory.peakRssBytes >= report.memory.rssBeforeBytes);
  assert.ok(!JSON.stringify(report).includes('bsl-callgraph-benchmark-'));
});
