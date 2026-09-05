'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const packageMetadata = require('../package.json');
const { IndexManager } = require('./index-manager');
const { MAX_PAGE_SIZE } = require('./store');

const SERVER_NAME = 'bsl-callgraph';
const MODES = ['exact', 'exploratory'];
const MAX_OUTPUT_CANDIDATES = 50;

const indexSchema = z.object({
  state: z.enum(['idle', 'building', 'ready', 'failed']),
  generation: z.number().int().nonnegative(),
  hasUsableIndex: z.boolean(),
  indexedAt: z.string().nullable(),
});

const outputSchema = {
  status: z.string(),
  index: indexSchema,
  data: z.record(z.any()),
};

const paginationSchema = {
  limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional()
    .describe(`Maximum results to return (default 50, maximum ${MAX_PAGE_SIZE})`),
  cursor: z.string().optional().describe('Opaque cursor returned by the preceding page'),
};

const modeSchema = z.enum(MODES).optional()
  .describe('exact (default) includes resolved edges only; exploratory also includes ambiguous and dynamic candidates');

function publicIndexSnapshot(manager) {
  const snapshot = manager.snapshot();
  return {
    state: snapshot.state,
    generation: snapshot.generation,
    hasUsableIndex: snapshot.hasUsableIndex,
    indexedAt: snapshot.indexedAt,
  };
}

function makeResult(manager, status, data, text, options = {}) {
  const structuredContent = {
    status,
    index: publicIndexSnapshot(manager),
    data,
  };
  return {
    content: [{ type: 'text', text }],
    structuredContent,
    ...(options.isError ? { isError: true } : {}),
  };
}

function notReadyResult(manager) {
  const snapshot = manager.snapshot();
  const message = snapshot.state === 'failed'
    ? `Index is unavailable because the last build failed: ${snapshot.lastError || 'unknown error'}`
    : 'Index is being built. Retry after the server reports state "ready".';
  return makeResult(manager, snapshot.state, { message }, message, { isError: true });
}

function withStore(manager, callback) {
  if (!manager.store) return notReadyResult(manager);
  try {
    return callback(manager.store);
  } catch (error) {
    return makeResult(
      manager,
      'error',
      { message: error.message },
      `Request failed: ${error.message}`,
      { isError: true }
    );
  }
}

function modeOptions(mode) {
  return mode === 'exploratory'
    ? { includeAmbiguous: true, includeDynamic: true }
    : { includeAmbiguous: false, includeDynamic: false };
}

function procedureView(procedure) {
  return {
    id: procedure.id,
    name: procedure.name,
    kind: procedure.kind,
    isExport: Boolean(procedure.isExport),
    moduleId: procedure.moduleId,
    module: procedure.moduleDisplayName || procedure.module,
    moduleKind: procedure.moduleKind || null,
    objectKind: procedure.objectKind || null,
    file: procedure.file,
    line: procedure.line,
    column: procedure.column || 1,
  };
}

function edgeView(edge) {
  const rawCandidates = edge.candidateTargets?.length
    ? edge.candidateTargets
    : edge.candidates?.length
      ? edge.candidates
      : edge.target
        ? [edge.target]
        : [];
  const candidates = rawCandidates
    .slice(0, MAX_OUTPUT_CANDIDATES)
    .map(candidate => typeof candidate === 'string' ? { id: candidate } : candidate);
  return {
    id: edge.id,
    resolution: edge.resolution,
    reason: edge.resolutionReason || edge.reason || null,
    confidence: edge.confidence || null,
    caller: {
      id: edge.callerId || null,
      name: edge.callerName,
      moduleId: edge.callerModuleId || null,
      module: edge.callerModuleDisplayName || edge.callerModule || null,
    },
    target: edge.target || (edge.calleeId ? {
      id: edge.calleeId,
      name: edge.calleeName,
      moduleId: edge.calleeModuleId,
      module: edge.calleeModule,
      file: edge.calleeFile || null,
      line: edge.calleeLine || null,
    } : null),
    candidate: {
      name: edge.calleeName,
      receiver: edge.receiver || null,
    },
    candidates,
    candidateCount: rawCandidates.length,
    candidatesTruncated: rawCandidates.length > candidates.length,
    provenance: {
      file: edge.file || edge.callerFile || null,
      line: edge.callLine || 1,
      column: edge.callColumn || 1,
    },
  };
}

function pageData(page, mapper) {
  return {
    items: page.items.map(mapper),
    nextCursor: page.nextCursor,
    total: page.total,
  };
}

function symbolText(items) {
  if (items.length === 0) return 'No matching symbols found.';
  return items.map(item => [
    `${item.kind.toUpperCase()} ${item.module}.${item.name}${item.isExport ? ' [Export]' : ''}`,
    `  ${item.file}:${item.line}`,
    `  moduleId: ${item.moduleId}`,
  ].join('\n')).join('\n\n');
}

function edgeText(items) {
  if (items.length === 0) return 'No matching dependencies found.';
  return items.map(item => {
    const target = item.target
      ? `${item.target.module || item.target.moduleId}.${item.target.name}`
      : `${item.candidate.receiver ? `${item.candidate.receiver}.` : ''}${item.candidate.name}`;
    return `${item.caller.module || item.caller.moduleId}.${item.caller.name} -> ${target}`
      + ` [${item.resolution}, ${item.confidence || 'unknown'}]`
      + ` at ${item.provenance.file}:${item.provenance.line}`;
  }).join('\n');
}

function registerTools(server, manager) {
  server.registerTool('find_symbol', {
    description: 'Find BSL procedure/function definitions by exact name.',
    inputSchema: {
      name: z.string().min(1).describe('Procedure or function name (case-insensitive)'),
      module: z.string().optional().describe('Display alias or canonical module ID'),
      ...paginationSchema,
    },
    outputSchema,
  }, async ({ name, module, limit = 50, cursor }) => withStore(manager, store => {
    const page = store.findSymbol(name, module, { limit, cursor });
    const data = pageData(page, procedureView);
    return makeResult(manager, 'ok', data, symbolText(data.items));
  }));

  server.registerTool('search_symbols', {
    description: 'Search BSL procedures/functions by a case-insensitive name substring.',
    inputSchema: {
      query: z.string().min(1).describe('Name substring'),
      module: z.string().optional().describe('Display alias or canonical module ID'),
      ...paginationSchema,
    },
    outputSchema,
  }, async ({ query, module, limit = 50, cursor }) => withStore(manager, store => {
    const page = store.searchSymbols(query, module, { limit, cursor });
    const data = pageData(page, procedureView);
    return makeResult(manager, 'ok', data, symbolText(data.items));
  }));

  server.registerTool('get_callers', {
    description: 'Find direct callers. Exact mode excludes ambiguous and dynamic candidates.',
    inputSchema: {
      name: z.string().min(1),
      module: z.string().optional(),
      mode: modeSchema,
      ...paginationSchema,
    },
    outputSchema,
  }, async ({ name, module, mode = 'exact', limit = 50, cursor }) => withStore(manager, store => {
    const page = store.getCallers(name, module, { ...modeOptions(mode), limit, cursor });
    const data = { mode, ...pageData(page, edgeView) };
    return makeResult(manager, 'ok', data, edgeText(data.items));
  }));

  server.registerTool('get_callees', {
    description: 'Find direct dependencies. Exploratory mode includes ambiguous and dynamic candidates.',
    inputSchema: {
      name: z.string().min(1),
      module: z.string().optional(),
      mode: modeSchema,
      ...paginationSchema,
    },
    outputSchema,
  }, async ({ name, module, mode = 'exact', limit = 50, cursor }) => withStore(manager, store => {
    const page = store.getCallees(name, module, { ...modeOptions(mode), limit, cursor });
    const data = { mode, ...pageData(page, edgeView) };
    return makeResult(manager, 'ok', data, edgeText(data.items));
  }));

  server.registerTool('get_impact', {
    description: 'Find the bounded reverse transitive closure of a BSL symbol.',
    inputSchema: {
      name: z.string().min(1),
      module: z.string().optional(),
      depth: z.number().int().min(1).max(10).optional(),
      mode: modeSchema,
      ...paginationSchema,
    },
    outputSchema,
  }, async ({ name, module, depth = 5, mode = 'exact', limit = 50, cursor }) => withStore(manager, store => {
    const page = store.getImpact(name, module, depth, { ...modeOptions(mode), limit, cursor });
    const data = { mode, depth, ...pageData(page, edgeView) };
    return makeResult(manager, 'ok', data, edgeText(data.items));
  }));

  server.registerTool('reindex', {
    description: 'Rebuild the configured root and await atomic publication of the new generation.',
    inputSchema: {},
    outputSchema,
  }, async () => {
    try {
      const snapshot = await manager.reindex();
      const stats = snapshot.stats || {};
      const data = {
        generation: snapshot.generation,
        indexedAt: snapshot.indexedAt,
        files: stats.files || 0,
        procedures: stats.procedures || 0,
        calls: stats.calls || 0,
      };
      return makeResult(
        manager,
        'ok',
        data,
        `Indexed generation ${data.generation}: ${data.files} files, ${data.procedures} symbols, ${data.calls} call candidates.`
      );
    } catch (error) {
      const message = manager.lastError || 'Index rebuild failed.';
      return makeResult(
        manager,
        'failed',
        { message, retainedLastGoodIndex: manager.hasUsableIndex },
        `Reindex failed; last good index retained: ${message}`,
        { isError: true }
      );
    }
  });

  server.registerTool('stats', {
    description: 'Show public index state and counts. The configured absolute root is not returned.',
    inputSchema: {},
    outputSchema,
  }, async () => {
    const snapshot = manager.snapshot();
    const stats = snapshot.stats || {};
    const data = {
      files: stats.files || 0,
      procedures: stats.procedures || 0,
      calls: stats.calls || 0,
      resolution: stats.resolution || { resolved: 0, ambiguous: 0, dynamic: 0 },
      errors: stats.errors || 0,
      diagnostics: stats.diagnostics || 0,
      diagnosticsTruncated: Boolean(stats.diagnosticsTruncated),
      lastError: snapshot.lastError,
    };
    const text = [
      `State: ${snapshot.state}`,
      `Generation: ${snapshot.generation}`,
      `Files: ${data.files}`,
      `Procedures/Functions: ${data.procedures}`,
      `Call candidates: ${data.calls}`,
      `Resolved/Ambiguous/Dynamic: ${data.resolution.resolved}/${data.resolution.ambiguous}/${data.resolution.dynamic}`,
    ].join('\n');
    return makeResult(manager, 'ok', data, text);
  });

  server.registerTool('server_info', {
    description: 'Describe server version, capabilities, limits, and privacy behavior.',
    inputSchema: {},
    outputSchema,
  }, async () => makeResult(manager, 'ok', {
    name: SERVER_NAME,
    version: packageMetadata.version,
    capabilities: {
      modes: MODES,
      pagination: ['find_symbol', 'search_symbols', 'get_callers', 'get_callees', 'get_impact'],
      maxPageSize: MAX_PAGE_SIZE,
      maxImpactDepth: 10,
      reindex: 'awaited-atomic-generation',
      configuredRootMutableByTools: false,
      followsDirectoryLinks: false,
      structuredContent: true,
    },
  }, `${SERVER_NAME} ${packageMetadata.version}; exact graph by default; max page size ${MAX_PAGE_SIZE}.`));
}

function createMcpServer(manager) {
  const server = new McpServer({ name: SERVER_NAME, version: packageMetadata.version });
  registerTools(server, manager);
  return server;
}

async function main(args = process.argv.slice(2), options = {}) {
  const rootPath = args[0];
  const commandName = options.commandName || 'node src/mcp-server.js';
  if (!rootPath || args.length > 1) {
    throw new Error(`Usage: ${commandName} <path-to-bsl-root>`);
  }

  const logger = options.logger || (message => process.stderr.write(`${message}\n`));
  const manager = options.manager || new IndexManager(rootPath);
  const server = options.server || createMcpServer(manager);
  const transport = options.transport || new StdioServerTransport();

  await server.connect(transport);
  logger(`[${SERVER_NAME}] MCP server ready; index build starting.`);
  manager.start().then(snapshot => {
    const stats = snapshot.stats;
    logger(`[${SERVER_NAME}] Generation ${snapshot.generation} ready: ${stats.files} files, ${stats.procedures} symbols, ${stats.calls} calls.`);
  }).catch(() => {
    logger(`[${SERVER_NAME}] Initial index failed: ${manager.lastError}`);
  });

  return { manager, server, transport };
}

function reportFatal(error) {
  process.stderr.write(`[${SERVER_NAME}] Fatal: ${error.message}\n`);
  process.exitCode = 1;
}

if (require.main === module) {
  main().catch(reportFatal);
}

module.exports = {
  MAX_OUTPUT_CANDIDATES,
  SERVER_NAME,
  createMcpServer,
  edgeView,
  main,
  procedureView,
  publicIndexSnapshot,
  registerTools,
  reportFatal,
};
