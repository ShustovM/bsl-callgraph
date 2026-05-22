'use strict';

const fs = require('fs');
const path = require('path');
const { parseFile } = require('./parser');

// Recursively find all .bsl files under rootPath
function findBslFiles(rootPath) {
  const results = [];
  const stack = [rootPath];

  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.bsl')) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

// Build full index from a root directory (synchronous)
function buildIndex(rootPath) {
  const bslFiles = findBslFiles(rootPath);
  const allProcedures = [];
  const allCalls = [];
  let errorCount = 0;

  for (const filePath of bslFiles) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const relativePath = path.relative(rootPath, filePath);
      const result = parseFile(content, relativePath);
      allProcedures.push(...result.procedures);
      allCalls.push(...result.calls);
    } catch {
      errorCount++;
    }
  }

  return {
    procedures: allProcedures,
    calls: allCalls,
    stats: {
      files: bslFiles.length,
      procedures: allProcedures.length,
      calls: allCalls.length,
      errors: errorCount,
      indexedAt: new Date().toISOString(),
      rootPath,
    },
  };
}

// Async version — yields the event loop every 200 files so the MCP transport
// can process incoming messages (initialize, tool calls) during indexing.
async function buildIndexAsync(rootPath) {
  const bslFiles = findBslFiles(rootPath);
  const allProcedures = [];
  const allCalls = [];
  let errorCount = 0;

  for (let i = 0; i < bslFiles.length; i++) {
    try {
      const content = fs.readFileSync(bslFiles[i], 'utf-8');
      const relativePath = path.relative(rootPath, bslFiles[i]);
      const result = parseFile(content, relativePath);
      allProcedures.push(...result.procedures);
      allCalls.push(...result.calls);
    } catch {
      errorCount++;
    }
    if (i % 200 === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  return {
    procedures: allProcedures,
    calls: allCalls,
    stats: {
      files: bslFiles.length,
      procedures: allProcedures.length,
      calls: allCalls.length,
      errors: errorCount,
      indexedAt: new Date().toISOString(),
      rootPath,
    },
  };
}

module.exports = { buildIndex, buildIndexAsync, findBslFiles };
