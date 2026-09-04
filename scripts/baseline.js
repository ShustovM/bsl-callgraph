#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { buildIndex } = require('../src/indexer');

function parsePositiveInteger(value, option) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${option} must be a positive integer.`);
  }
  return number;
}

function parseArguments(args) {
  let root = path.join(__dirname, '..', 'baseline', 'fixtures');
  let label = 'synthetic fixture';
  let runs = 20;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];

    if (argument === '--root') {
      root = args[++index];
      label = 'external corpus';
    } else if (argument === '--label') {
      label = args[++index];
    } else if (argument === '--runs') {
      runs = parsePositiveInteger(args[++index], '--runs');
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }

    if (args[index] === undefined) {
      throw new Error(`${argument} requires a value.`);
    }
  }

  return { root, label, runs };
}

function percentile(sortedValues, fraction) {
  const index = Math.min(
    sortedValues.length - 1,
    Math.ceil(sortedValues.length * fraction) - 1
  );
  return sortedValues[index];
}

function round(number) {
  return Number(number.toFixed(3));
}

function assertReadableDirectory(root) {
  try {
    fs.accessSync(root, fs.constants.R_OK);
    if (!fs.statSync(root).isDirectory()) {
      throw new Error('not a directory');
    }
  } catch {
    throw new Error('Corpus root must be a readable directory.');
  }
}

function main() {
  const { root, label, runs } = parseArguments(process.argv.slice(2));
  assertReadableDirectory(root);

  const durations = [];
  const rssBefore = process.memoryUsage().rss;
  let result;

  for (let run = 0; run < runs; run++) {
    const startedAt = performance.now();
    result = buildIndex(root);
    durations.push(performance.now() - startedAt);
  }

  durations.sort((left, right) => left - right);
  const total = durations.reduce((sum, value) => sum + value, 0);
  const rssAfter = process.memoryUsage().rss;

  const report = {
    schemaVersion: 1,
    label,
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    runs,
    corpus: {
      files: result.stats.files,
      procedures: result.stats.procedures,
      calls: result.stats.calls,
      errors: result.stats.errors,
    },
    indexingMilliseconds: {
      mean: round(total / runs),
      minimum: round(durations[0]),
      median: round(percentile(durations, 0.5)),
      p95: round(percentile(durations, 0.95)),
      maximum: round(durations[durations.length - 1]),
    },
    processMemoryBytes: {
      rssBefore,
      rssAfter,
      rssDelta: rssAfter - rssBefore,
    },
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`Baseline failed: ${error.message}\n`);
  process.exitCode = 1;
}
