'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { describe, test } = require('node:test');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { createMcpServer } = require('../src/mcp-server');
const { IndexManager } = require('../src/index-manager');

const repositoryRoot = path.join(__dirname, '..');
const fixtureRoot = path.join(__dirname, 'fixtures');

async function connectStdio(t) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repositoryRoot, 'bin', 'bsl-callgraph.js'), fixtureRoot],
    cwd: repositoryRoot,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'bsl-callgraph-tests', version: '1.0.0' }, {
    capabilities: {},
  });
  await client.connect(transport);
  t.after(async () => client.close());
  return client;
}

async function call(client, name, args = {}) {
  return client.callTool({ name, arguments: args });
}

describe('MCP stdio integration', () => {
  test('initializes, publishes schemas, and serves every tool with structured content', async t => {
    const client = await connectStdio(t);
    const listing = await client.listTools();
    const tools = new Map(listing.tools.map(tool => [tool.name, tool]));
    assert.deepEqual([...tools.keys()].sort(), [
      'find_symbol',
      'get_callees',
      'get_callers',
      'get_impact',
      'reindex',
      'search_symbols',
      'server_info',
      'stats',
    ]);

    for (const name of tools.keys()) {
      assert.equal(tools.get(name).inputSchema.type, 'object');
      assert.equal(tools.get(name).outputSchema.type, 'object');
    }
    for (const name of ['search_symbols', 'get_callers', 'get_callees', 'get_impact']) {
      assert.ok(tools.get(name).inputSchema.properties.limit);
      assert.ok(tools.get(name).inputSchema.properties.cursor);
    }
    for (const name of ['get_callers', 'get_callees', 'get_impact']) {
      assert.deepEqual(tools.get(name).inputSchema.properties.mode.enum, ['exact', 'exploratory']);
    }
    assert.ok(!JSON.stringify(listing.tools).includes('rootPath'));

    const reindexed = await call(client, 'reindex');
    assert.equal(reindexed.isError, undefined);
    assert.equal(reindexed.structuredContent.status, 'ok');
    assert.ok(reindexed.structuredContent.data.generation >= 1);

    const invocations = [
      ['server_info'],
      ['stats'],
      ['find_symbol', { name: 'ВычислитьЧтоТо', module: 'ТестовыйМодуль' }],
      ['search_symbols', { query: 'Вычислить', limit: 1 }],
      ['get_callers', { name: 'ВычислитьЧтоТо', module: 'ТестовыйМодуль' }],
      ['get_callees', { name: 'ПубличнаяПроцедура', module: 'ТестовыйМодуль' }],
      ['get_impact', { name: 'ВычислитьЧтоТо', module: 'ТестовыйМодуль', depth: 2 }],
    ];
    for (const [name, args] of invocations) {
      const result = await call(client, name, args);
      assert.equal(result.isError, undefined, `${name} returned an error`);
      assert.ok(result.content.some(item => item.type === 'text'));
      assert.equal(typeof result.structuredContent.status, 'string');
      assert.equal(typeof result.structuredContent.index.generation, 'number');
    }

    const exact = await call(client, 'get_callees', {
      name: 'ПубличнаяПроцедура',
      module: 'ТестовыйМодуль',
      mode: 'exact',
    });
    const exploratory = await call(client, 'get_callees', {
      name: 'ПубличнаяПроцедура',
      module: 'ТестовыйМодуль',
      mode: 'exploratory',
    });
    assert.ok(exact.structuredContent.data.items.every(edge => edge.resolution === 'resolved'));
    assert.ok(exploratory.structuredContent.data.items.length > exact.structuredContent.data.items.length);

    const stats = await call(client, 'stats');
    assert.ok(!JSON.stringify(stats).includes(path.resolve(fixtureRoot)));
    assert.equal(stats.structuredContent.index.state, 'ready');

    const invalidCursor = await call(client, 'search_symbols', {
      query: 'a',
      cursor: 'not-a-valid-cursor',
    });
    assert.equal(invalidCursor.isError, true);
    assert.match(invalidCursor.content[0].text, /cursor/iu);
  });

  test('returns validation errors for invalid tool input', async t => {
    const client = await connectStdio(t);
    const result = await call(client, 'get_impact', { name: 'Anything', depth: 1000 });
    assert.equal(result.isError, true);
  });
});

describe('MCP readiness', () => {
  test('responds during initial indexing without exposing a partial store', async t => {
    let releaseBuild;
    const manager = new IndexManager('synthetic', {
      skipValidation: true,
      buildIndex: async () => new Promise(resolve => { releaseBuild = resolve; }),
    });
    const server = createMcpServer(manager);
    const client = new Client({ name: 'readiness-test', version: '1.0.0' }, {
      capabilities: {},
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    t.after(async () => {
      await client.close();
      await server.close();
    });

    const build = manager.start();
    const result = await call(client, 'search_symbols', { query: 'Run' });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, 'building');
    assert.equal(result.structuredContent.index.hasUsableIndex, false);

    releaseBuild({
      procedures: [],
      calls: [],
      diagnostics: [],
      stats: {
        files: 0,
        procedures: 0,
        calls: 0,
        errors: 0,
        indexedAt: new Date().toISOString(),
      },
    });
    await build;
  });

  test('redacts rebuild failures and keeps the preceding generation queryable', async t => {
    const privateRoot = String.raw`C:\Private\Customer\Export`;
    let attempts = 0;
    const procedure = {
      id: 'module:commonmodules/example/ext/module::run',
      moduleId: 'module:commonmodules/example/ext/module',
      module: 'Example',
      moduleDisplayName: 'Example',
      name: 'Run',
      kind: 'procedure',
      isExport: true,
      file: 'CommonModules/Example/Ext/Module.bsl',
      line: 1,
    };
    const manager = new IndexManager(privateRoot, {
      skipValidation: true,
      buildIndex: async () => {
        attempts++;
        if (attempts > 1) throw new Error(`Cannot read ${privateRoot}`);
        return {
          procedures: [procedure],
          calls: [],
          diagnostics: [],
          stats: {
            files: 1,
            procedures: 1,
            calls: 0,
            errors: 0,
            indexedAt: new Date().toISOString(),
          },
        };
      },
    });
    await manager.start();

    const server = createMcpServer(manager);
    const client = new Client({ name: 'failure-test', version: '1.0.0' }, {
      capabilities: {},
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    t.after(async () => {
      await client.close();
      await server.close();
    });

    const failed = await call(client, 'reindex');
    assert.equal(failed.isError, true);
    assert.equal(failed.structuredContent.data.retainedLastGoodIndex, true);
    assert.ok(!JSON.stringify(failed).includes(privateRoot));
    assert.match(failed.content[0].text, /<configured-root>/u);

    const query = await call(client, 'find_symbol', { name: 'Run' });
    assert.equal(query.isError, undefined);
    assert.equal(query.structuredContent.data.items.length, 1);
    assert.equal(query.structuredContent.index.state, 'failed');
  });
});
