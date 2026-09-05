#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { buildIndexAsync } = require('../src/indexer');
const { CallGraphStore } = require('../src/store');

function positiveInteger(value, name, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  }
  return number;
}

function parseArguments(args) {
  const result = { modules: 500, methods: 20, queries: 1000 };
  const options = new Map([
    ['--modules', ['modules', 5000]],
    ['--methods', ['methods', 200]],
    ['--queries', ['queries', 100000]],
  ]);

  for (let index = 0; index < args.length; index++) {
    const separator = args[index].indexOf('=');
    const option = separator >= 0 ? args[index].slice(0, separator) : args[index];
    const inlineValue = separator >= 0 ? args[index].slice(separator + 1) : undefined;
    const [property, maximum] = options.get(option) || [];
    if (!property) throw new Error(`Unknown option: ${option}`);
    const value = inlineValue ?? args[++index];
    if (value === undefined || value === '') throw new Error(`${option} requires a value.`);
    result[property] = positiveInteger(value, option, maximum);
  }
  return result;
}

function moduleName(index) {
  return `Synthetic${String(index).padStart(5, '0')}`;
}

function methodName(moduleIndex, methodIndex) {
  return `M${String(moduleIndex).padStart(5, '0')}P${String(methodIndex).padStart(3, '0')}`;
}

function generateCorpus(root, modules, methods) {
  for (let moduleIndex = 0; moduleIndex < modules; moduleIndex++) {
    const directory = path.join(root, 'CommonModules', moduleName(moduleIndex), 'Ext');
    fs.mkdirSync(directory, { recursive: true });
    const lines = [];
    for (let methodIndex = 0; methodIndex < methods; methodIndex++) {
      const current = methodName(moduleIndex, methodIndex);
      const nextMethod = methodName(moduleIndex, (methodIndex + 1) % methods);
      const nextModuleIndex = (moduleIndex + 1) % modules;
      lines.push(`Procedure ${current}() Export`);
      lines.push(`  ${nextMethod}();`);
      if (methodIndex === 0) {
        lines.push(`  ${moduleName(nextModuleIndex)}.${methodName(nextModuleIndex, 0)}();`);
      }
      lines.push('EndProcedure', '');
    }
    fs.writeFileSync(path.join(directory, 'Module.bsl'), lines.join('\n'));
  }
}

function milliseconds(value) {
  return Number(value.toFixed(3));
}

async function runBenchmark(options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsl-callgraph-benchmark-'));
  let sampler;
  try {
    const generationStarted = performance.now();
    generateCorpus(root, options.modules, options.methods);
    const generationMilliseconds = performance.now() - generationStarted;

    let peakRssBytes = process.memoryUsage().rss;
    sampler = setInterval(() => {
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    }, 5);
    sampler.unref();
    const rssBeforeBytes = process.memoryUsage().rss;
    const indexStarted = performance.now();
    const index = await buildIndexAsync(root);
    const indexingMilliseconds = performance.now() - indexStarted;
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);

    const store = new CallGraphStore();
    const loadStarted = performance.now();
    await store.loadAsync(index);
    const storeLoadMilliseconds = performance.now() - loadStarted;

    const exactName = methodName(Math.floor(options.modules / 2), 0);
    const queryStarted = performance.now();
    for (let iteration = 0; iteration < options.queries; iteration++) {
      store.findSymbol(exactName);
      store.getCallees(exactName);
      store.getCallers(exactName);
    }
    const queryMilliseconds = performance.now() - queryStarted;
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);

    return {
      schemaVersion: 1,
      runtime: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
      },
      generatedCorpus: {
        modules: options.modules,
        methodsPerModule: options.methods,
        files: index.stats.files,
        procedures: index.stats.procedures,
        callCandidates: index.stats.calls,
      },
      generationMilliseconds: milliseconds(generationMilliseconds),
      indexingMilliseconds: milliseconds(indexingMilliseconds),
      storeLoadMilliseconds: milliseconds(storeLoadMilliseconds),
      queries: {
        iterations: options.queries,
        operationsPerIteration: 3,
        totalMilliseconds: milliseconds(queryMilliseconds),
        meanOperationMilliseconds: milliseconds(queryMilliseconds / (options.queries * 3)),
      },
      memory: {
        rssBeforeBytes,
        peakRssBytes,
        sampledPeakDeltaBytes: Math.max(0, peakRssBytes - rssBeforeBytes),
        samplingIntervalMilliseconds: 5,
      },
    };
  } finally {
    clearInterval(sampler);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = await runBenchmark(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`Benchmark failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { generateCorpus, parseArguments, runBenchmark };
