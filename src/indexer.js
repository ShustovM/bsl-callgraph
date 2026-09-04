'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseFile } = require('./parser');
const { resolveCalls } = require('./resolver');

const DEFAULT_IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
]);
const DEFAULT_DIAGNOSTIC_LIMIT = 100;

function diagnostic(code, message, extra = {}) {
  return { code, severity: 'warning', message, ...extra };
}

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

function scanBslFiles(rootPath, options = {}) {
  const canonicalRoot = options.validated ? rootPath : validateRoot(rootPath);
  const ignored = new Set([
    ...DEFAULT_IGNORED_DIRECTORIES,
    ...(options.ignoredDirectories || []),
  ].map(value => String(value).toLowerCase()));
  const diagnostics = [];
  const files = [];
  const stack = [canonicalRoot];

  while (stack.length > 0) {
    const directory = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      diagnostics.push(diagnostic(
        'unreadable-directory',
        `Directory could not be read: ${error.message}`,
        { file: path.relative(canonicalRoot, directory).replace(/\\/gu, '/') || '.' }
      ));
      continue;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (let index = entries.length - 1; index >= 0; index--) {
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
      }
    }
  }

  files.sort((left, right) => {
    const leftRelative = path.relative(canonicalRoot, left).replace(/\\/gu, '/');
    const rightRelative = path.relative(canonicalRoot, right).replace(/\\/gu, '/');
    return leftRelative.localeCompare(rightRelative, 'en');
  });
  return { rootPath: canonicalRoot, files, diagnostics };
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
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = parseFile(content, relativePath);
    accumulator.procedures.push(...parsed.procedures);
    accumulator.candidates.push(...parsed.calls);
    addDiagnostics(accumulator, parsed.diagnostics || [], relativePath);
  } catch (error) {
    accumulator.readErrors++;
    addDiagnostics(accumulator, [diagnostic(
      'unreadable-file',
      `File could not be indexed: ${error.message}`,
      { file: relativePath }
    )], relativePath);
  }
}

function finishIndex(accumulator, fileCount) {
  const calls = resolveCalls(accumulator.procedures, accumulator.candidates);
  const resolution = { resolved: 0, ambiguous: 0, dynamic: 0 };
  for (const edge of calls) {
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
  const scan = scanBslFiles(rootPath, options);
  const accumulator = createAccumulator(
    scan.rootPath,
    options.diagnosticLimit ?? DEFAULT_DIAGNOSTIC_LIMIT
  );
  addDiagnostics(accumulator, scan.diagnostics, '.');
  const yieldEvery = options.yieldEvery ?? 200;

  for (let index = 0; index < scan.files.length; index++) {
    parseInto(accumulator, scan.files[index]);
    if (yieldEvery > 0 && index % yieldEvery === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  return finishIndex(accumulator, scan.files.length);
}

module.exports = {
  DEFAULT_DIAGNOSTIC_LIMIT,
  DEFAULT_IGNORED_DIRECTORIES,
  buildIndex,
  buildIndexAsync,
  findBslFiles,
  scanBslFiles,
  validateRoot,
};
