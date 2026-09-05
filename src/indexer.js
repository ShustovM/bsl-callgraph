'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseFile } = require('./parser');
const { resolveCalls, resolveCallsAsync } = require('./resolver');
const { runSync, runAsync, sortSteps } = require('./cooperative');

const DEFAULT_IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
]);
const DEFAULT_DIAGNOSTIC_LIMIT = 100;

function validateRoot(rootPath) {
  if (typeof rootPath !== 'string' || rootPath.trim() === '') {
    throw new TypeError('The BSL root path must be a non-empty string.');
  }

  const absolutePath = path.resolve(rootPath);
  let canonicalPath;
  let stats;
  try {
    canonicalPath = fs.realpathSync.native(absolutePath);
    fs.accessSync(canonicalPath, fs.constants.R_OK);
    stats = fs.statSync(canonicalPath);
  } catch (error) {
    throw new Error(`The BSL root is not readable: ${error.message}`);
  }

  if (!stats.isDirectory()) {
    throw new Error('The BSL root must be a directory.');
  }
  return canonicalPath;
}

function* scanBslFilesSteps(rootPath, options = {}) {
  yield;
  const canonicalRoot = options.validated ? rootPath : validateRoot(rootPath);
  const ignored = new Set([
    ...DEFAULT_IGNORED_DIRECTORIES,
    ...(options.ignoredDirectories || []),
  ].map(value => String(value).toLowerCase()));
  const diagnostics = [];
  const files = [];
  const relativePaths = new Map();
  const stack = [canonicalRoot];

  while (stack.length > 0) {
    const directory = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Directory could not be read: ${error.message}`, { cause: error });
    }

    yield;
    yield* sortSteps(entries, (left, right) => left.name.localeCompare(right.name, 'en'));
    for (let index = entries.length - 1; index >= 0; index--) {
      if (index % 128 === 0) yield;
      const entry = entries[index];
      const fullPath = path.join(directory, entry.name);

      // Directory symlinks and Windows junctions are intentionally not
      // followed. This keeps indexing inside the configured canonical root.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name.toLowerCase())) stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.bsl')) {
        files.push(fullPath);
        relativePaths.set(fullPath, path.relative(canonicalRoot, fullPath).replace(/\\/gu, '/'));
      }
    }
  }

  yield* sortSteps(files, (left, right) =>
    relativePaths.get(left).localeCompare(relativePaths.get(right), 'en'));
  return { rootPath: canonicalRoot, files, diagnostics };
}

function scanBslFiles(rootPath, options = {}) {
  return runSync(scanBslFilesSteps(rootPath, options));
}

function scanBslFilesAsync(rootPath, options = {}) {
  return runAsync(scanBslFilesSteps(rootPath, options), options);
}

function findBslFiles(rootPath, options) {
  return scanBslFiles(rootPath, options).files;
}

function createAccumulator(rootPath, diagnosticLimit) {
  return {
    rootPath,
    procedures: [],
    candidates: [],
    diagnostics: [],
    totalDiagnostics: 0,
    readErrors: 0,
    diagnosticLimit,
  };
}

function addDiagnostics(accumulator, diagnostics, file) {
  accumulator.totalDiagnostics += diagnostics.length;
  const remaining = Math.max(0, accumulator.diagnosticLimit - accumulator.diagnostics.length);
  for (const item of diagnostics.slice(0, remaining)) {
    accumulator.diagnostics.push({ ...item, file: item.file || file });
  }
}

function parseInto(accumulator, filePath) {
  const relativePath = path.relative(accumulator.rootPath, filePath).replace(/\\/gu, '/');
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`File could not be indexed: ${error.message}`, { cause: error });
  }
  const parsed = parseFile(content, relativePath);
  for (const procedure of parsed.procedures) accumulator.procedures.push(procedure);
  for (const candidate of parsed.calls) accumulator.candidates.push(candidate);
  addDiagnostics(accumulator, parsed.diagnostics || [], relativePath);
}

function* finishIndexSteps(accumulator, fileCount, calls) {
  yield;
  const resolution = { resolved: 0, ambiguous: 0, dynamic: 0 };
  for (let index = 0; index < calls.length; index++) {
    if (index % 512 === 0) yield;
    const edge = calls[index];
    if (Object.hasOwn(resolution, edge.resolution)) resolution[edge.resolution]++;
  }

  return {
    procedures: accumulator.procedures,
    calls,
    diagnostics: accumulator.diagnostics,
    stats: {
      files: fileCount,
      procedures: accumulator.procedures.length,
      calls: calls.length,
      candidates: accumulator.candidates.length,
      resolution,
      errors: accumulator.readErrors,
      diagnostics: accumulator.totalDiagnostics,
      diagnosticsTruncated: accumulator.totalDiagnostics > accumulator.diagnostics.length,
      indexedAt: new Date().toISOString(),
      rootPath: accumulator.rootPath,
    },
  };
}

function finishIndex(accumulator, fileCount) {
  const calls = resolveCalls(accumulator.procedures, accumulator.candidates);
  return runSync(finishIndexSteps(accumulator, fileCount, calls));
}

function* parseFilesSteps(accumulator, files) {
  yield;
  for (const filePath of files) {
    parseInto(accumulator, filePath);
    yield;
  }
}

function buildIndex(rootPath, options = {}) {
  const scan = scanBslFiles(rootPath, options);
  const accumulator = createAccumulator(
    scan.rootPath,
    options.diagnosticLimit ?? DEFAULT_DIAGNOSTIC_LIMIT
  );
  addDiagnostics(accumulator, scan.diagnostics, '.');
  for (const filePath of scan.files) parseInto(accumulator, filePath);
  return finishIndex(accumulator, scan.files.length);
}

async function buildIndexAsync(rootPath, options = {}) {
  const scan = await scanBslFilesAsync(rootPath, options);
  const accumulator = createAccumulator(
    scan.rootPath,
    options.diagnosticLimit ?? DEFAULT_DIAGNOSTIC_LIMIT
  );
  addDiagnostics(accumulator, scan.diagnostics, '.');
  // Check the time budget after every file, regardless of legacy yieldEvery.
  await runAsync(parseFilesSteps(accumulator, scan.files), options);
  const calls = await resolveCallsAsync(accumulator.procedures, accumulator.candidates, options);
  return runAsync(finishIndexSteps(accumulator, scan.files.length, calls), options);
}

module.exports = {
  DEFAULT_DIAGNOSTIC_LIMIT,
  DEFAULT_IGNORED_DIRECTORIES,
  buildIndex,
  buildIndexAsync,
  findBslFiles,
  scanBslFiles,
  scanBslFilesAsync,
  validateRoot,
};
