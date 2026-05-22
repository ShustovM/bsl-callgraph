'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { buildIndexAsync } = require('./indexer');
const { CallGraphStore } = require('./store');

const rootPath = process.argv[2];
if (!rootPath) {
  process.stderr.write('Usage: node src/mcp-server.js <path-to-bsl-root>\n');
  process.exit(1);
}

const store = new CallGraphStore();
let indexing = false;

async function doIndex() {
  if (indexing) return;
  indexing = true;
  process.stderr.write(`[bsl-callgraph] Indexing ${rootPath}...\n`);
  try {
    const result = await buildIndexAsync(rootPath);
    store.load(result);
    const s = store.stats;
    process.stderr.write(
      `[bsl-callgraph] Done: ${s.files} files, ${s.procedures} procedures, ${s.calls} calls\n`
    );
  } catch (err) {
    process.stderr.write(`[bsl-callgraph] Index error: ${err.message}\n`);
  } finally {
    indexing = false;
  }
}

const server = new McpServer({
  name: 'bsl-callgraph',
  version: '1.0.0',
});

function notReadyMsg() {
  return indexing
    ? { content: [{ type: 'text', text: 'Index is being built, please wait a moment and retry.' }] }
    : null;
}

// ── find_symbol ──────────────────────────────────────────────────────────────
server.tool(
  'find_symbol',
  'Find BSL procedure/function definition by name. Returns file, line, module, kind (procedure/function), and whether it is exported.',
  {
    name: z.string().describe('Procedure or function name (case-insensitive)'),
    module: z.string().optional().describe('Module name to narrow search (optional)'),
  },
  async ({ name, module }) => {
    const busy = notReadyMsg(); if (busy) return busy;
    const results = store.findSymbol(name, module);
    if (results.length === 0) {
      return { content: [{ type: 'text', text: `Symbol "${name}" not found.` }] };
    }
    const text = results
      .map(p =>
        `${p.kind.toUpperCase()} ${p.module}.${p.name}` +
        (p.isExport ? ' [Экспорт]' : '') +
        `\n  File: ${p.file}:${p.line}`
      )
      .join('\n\n');
    return { content: [{ type: 'text', text }] };
  }
);

// ── get_callers ──────────────────────────────────────────────────────────────
server.tool(
  'get_callers',
  'Find all procedures/functions that call the given BSL symbol. Useful for impact analysis.',
  {
    name: z.string().describe('Procedure or function name being called'),
    module: z.string().optional().describe('Module that owns the symbol (optional, helps disambiguate)'),
  },
  async ({ name, module }) => {
    const busy = notReadyMsg(); if (busy) return busy;
    const callers = store.getCallers(name, module);
    if (callers.length === 0) {
      return { content: [{ type: 'text', text: `No callers found for "${name}".` }] };
    }
    // Deduplicate by caller procedure
    const byProc = new Map();
    for (const c of callers) {
      const key = `${c.callerModule}.${c.callerName}`;
      if (!byProc.has(key)) byProc.set(key, { ...c, lines: [] });
      byProc.get(key).lines.push(c.callLine);
    }
    const text = [...byProc.values()]
      .map(c => `${c.callerModule}.${c.callerName}  (line ${c.lines.join(', ')})`)
      .join('\n');
    return { content: [{ type: 'text', text: `Callers of "${name}":\n${text}` }] };
  }
);

// ── get_callees ──────────────────────────────────────────────────────────────
server.tool(
  'get_callees',
  'Find all procedures/functions called by the given BSL symbol. Shows what a procedure depends on.',
  {
    name: z.string().describe('Procedure or function name'),
    module: z.string().optional().describe('Module that owns the symbol (optional)'),
  },
  async ({ name, module }) => {
    const busy = notReadyMsg(); if (busy) return busy;
    const callees = store.getCallees(name, module);
    if (callees.length === 0) {
      return { content: [{ type: 'text', text: `No callees found for "${name}".` }] };
    }
    // Deduplicate by callee
    const byCallee = new Map();
    for (const c of callees) {
      const key = `${c.calleeModule || ''}.${c.calleeName}`;
      if (!byCallee.has(key)) byCallee.set(key, { ...c, lines: [] });
      byCallee.get(key).lines.push(c.callLine);
    }
    const text = [...byCallee.values()]
      .map(c => {
        const target = c.calleeModule ? `${c.calleeModule}.${c.calleeName}` : c.calleeName;
        return `${target}  (line ${c.lines.join(', ')})`;
      })
      .join('\n');
    return { content: [{ type: 'text', text: `"${name}" calls:\n${text}` }] };
  }
);

// ── get_impact ───────────────────────────────────────────────────────────────
server.tool(
  'get_impact',
  'Find all procedures that transitively call the given symbol — the full impact radius of a change.',
  {
    name: z.string().describe('Procedure or function name'),
    module: z.string().optional().describe('Module that owns the symbol (optional)'),
    depth: z.number().int().min(1).max(10).optional().describe('Max recursion depth (default 5)'),
  },
  async ({ name, module, depth = 5 }) => {
    const busy = notReadyMsg(); if (busy) return busy;
    const impacted = store.getImpact(name, module, depth);
    if (impacted.length === 0) {
      return { content: [{ type: 'text', text: `No callers found for "${name}" (depth=${depth}).` }] };
    }
    // Deduplicate procedures
    const seen = new Set();
    const lines = [];
    for (const c of impacted) {
      const key = `${c.callerModule}.${c.callerName}`;
      if (!seen.has(key)) {
        seen.add(key);
        lines.push(key);
      }
    }
    return {
      content: [{
        type: 'text',
        text: `Impact radius for "${name}" (depth=${depth}, ${lines.length} callers):\n${lines.join('\n')}`,
      }],
    };
  }
);

// ── reindex ──────────────────────────────────────────────────────────────────
server.tool(
  'reindex',
  'Re-scan and re-index all BSL files from the configured root directory. Call this after code changes.',
  {},
  async () => {
    doIndex();
    const s = store.stats;
    return {
      content: [{
        type: 'text',
        text: `Re-indexed ${s.files} files: ${s.procedures} procedures, ${s.calls} calls. Done at ${s.indexedAt}`,
      }],
    };
  }
);

// ── stats ────────────────────────────────────────────────────────────────────
server.tool(
  'stats',
  'Show indexing statistics: number of files, procedures, and calls in the current index.',
  {},
  async () => {
    if (!store.stats) {
      return { content: [{ type: 'text', text: 'Index not loaded yet.' }] };
    }
    const s = store.stats;
    return {
      content: [{
        type: 'text',
        text: [
          `Root: ${s.rootPath}`,
          `Files: ${s.files}`,
          `Procedures/Functions: ${s.procedures}`,
          `Call sites: ${s.calls}`,
          `Indexed at: ${s.indexedAt}`,
          s.errors ? `Parse errors: ${s.errors}` : '',
        ].filter(Boolean).join('\n'),
      }],
    };
  }
);

// Start server
async function main() {
  doIndex();  // fire-and-forget: yields event loop every 200 files, MCP stays responsive
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[bsl-callgraph] MCP server ready\n');
}

main().catch(err => {
  process.stderr.write(`[bsl-callgraph] Fatal: ${err.message}\n`);
  process.exit(1);
});
