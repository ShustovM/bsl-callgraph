'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');

const { IndexManager } = require('../src/index-manager');
const { buildIndex, scanBslFiles, scanBslFilesAsync, validateRoot } = require('../src/indexer');
const { CallGraphStore } = require('../src/store');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bsl-callgraph-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function indexResult(name = 'Run') {
  const procedure = {
    id: `module:commonmodules/example/ext/module::${name.toLowerCase()}`,
    moduleId: 'module:commonmodules/example/ext/module',
    module: 'Example',
    moduleDisplayName: 'Example',
    name,
    kind: 'procedure',
    isExport: true,
    file: 'CommonModules/Example/Ext/Module.bsl',
    line: 1,
  };
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
}

describe('indexer', () => {
  test('validates roots and resolves candidates after scanning every file', t => {
    const root = temporaryDirectory(t);
    const firstDirectory = path.join(root, 'CommonModules', 'First', 'Ext');
    const secondDirectory = path.join(root, 'CommonModules', 'Second', 'Ext');
    fs.mkdirSync(firstDirectory, { recursive: true });
    fs.mkdirSync(secondDirectory, { recursive: true });
    fs.writeFileSync(path.join(firstDirectory, 'Module.bsl'), [
      'Procedure Run() Export',
      '  Helper();',
      '  QueryText = "SELECT',
      '  | Value(Enumeration.State.EmptyRef) AS State";',
      '  Query.SetParameter("x", 1);',
      'EndProcedure',
    ].join('\n'));
    fs.writeFileSync(path.join(secondDirectory, 'Module.bsl'), [
      'Procedure Helper() Export',
      'EndProcedure',
    ].join('\n'));

    const result = buildIndex(root);

    assert.equal(result.stats.files, 2);
    assert.equal(result.stats.procedures, 2);
    assert.equal(result.stats.resolution.resolved, 1);
    assert.equal(result.stats.resolution.dynamic, 1);
    assert.equal(result.calls.find(edge => edge.calleeName === 'Helper').resolution, 'resolved');
    assert.equal(result.calls.find(edge => edge.calleeName === 'SetParameter').resolution, 'dynamic');
    assert.ok(!result.calls.some(edge => edge.calleeName === 'Value'));
  });

  test('rejects missing and non-directory roots', t => {
    const root = temporaryDirectory(t);
    const file = path.join(root, 'file.bsl');
    fs.writeFileSync(file, '');

    assert.throws(() => validateRoot(path.join(root, 'missing')), /not readable/iu);
    assert.throws(() => validateRoot(file), /must be a directory/iu);
  });

  test('does not follow directory symlinks or scan ignored directories', t => {
    const root = temporaryDirectory(t);
    const outside = temporaryDirectory(t);
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'ignored.bsl'), 'Procedure Ignored()\nEndProcedure');
    fs.writeFileSync(path.join(outside, 'outside.bsl'), 'Procedure Outside()\nEndProcedure');
    fs.writeFileSync(path.join(root, 'inside.bsl'), 'Procedure Inside()\nEndProcedure');

    try {
      fs.symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
        t.diagnostic(`symlink assertion skipped: ${error.code}`);
      } else {
        throw error;
      }
    }

    const relative = scanBslFiles(root).files.map(file => path.relative(root, file).replace(/\\/gu, '/'));
    assert.deepEqual(relative, ['inside.bsl']);
  });

  test('async scanning yields between real directory reads and preserves canonical order', async t => {
    const root = temporaryDirectory(t);
    const directoryCount = 9;
    for (let index = directoryCount - 2; index >= 0; index--) {
      const directory = path.join(root, `Module${index}`);
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, 'Module.bsl'), 'Procedure Run()\nEndProcedure');
    }
    const expected = scanBslFiles(root);
    let reads = 0;
    const realReadDirectory = fs.readdirSync;
    t.mock.method(fs, 'readdirSync', function (...args) {
      reads++;
      return realReadDirectory.apply(this, args);
    });
    let intermediateTicks = 0;
    let heartbeat;
    const tick = () => {
      if (reads > 0 && reads < directoryCount) intermediateTicks++;
      heartbeat = setImmediate(tick);
    };
    heartbeat = setImmediate(tick);
    try {
      const actual = await scanBslFilesAsync(root, { budgetMs: 0 });
      assert.deepEqual(actual, expected);
      assert.equal(reads, directoryCount);
      assert.ok(intermediateTicks > 0, 'the event loop must run during scanning, not only before it');
    } finally {
      clearImmediate(heartbeat);
    }
  });

  test('async store loading yields during population and matches synchronous graph results', async () => {
    const procedures = Array.from({ length: 1100 }, (_, index) => ({
      ...indexResult(`Run${index}`).procedures[0],
      line: index + 1,
    })).reverse();
    const calls = procedures.map((procedure, index) => ({
      id: `edge:${index}`,
      callerId: procedure.id,
      calleeId: procedure.id,
      callerName: procedure.name,
      calleeName: procedure.name,
      callLine: index + 2,
      resolution: 'resolved',
    }));
    const input = { procedures, calls };
    const expected = new CallGraphStore();
    expected.load(input);
    const actual = new CallGraphStore();
    let intermediateTicks = 0;
    let heartbeat;
    const tick = () => {
      if (actual.procedures.size > 0 && actual.calls.length < calls.length) intermediateTicks++;
      heartbeat = setImmediate(tick);
    };
    heartbeat = setImmediate(tick);
    try {
      await actual.loadAsync(input, { budgetMs: 0 });
      assert.ok(intermediateTicks > 0, 'the event loop must run while the store is populated');
      assert.deepEqual([...actual.procedures.keys()], [...expected.procedures.keys()]);
      assert.deepEqual(actual.calls, expected.calls);
      assert.deepEqual(actual.getCallers('Run500'), expected.getCallers('Run500'));
    } finally {
      clearImmediate(heartbeat);
    }
  });
});

describe('IndexManager', () => {
  test('awaits async store loading before publication and retains the store on load failure', async () => {
    let releaseLoad;
    let attempts = 0;
    const manager = new IndexManager('synthetic', {
      skipValidation: true,
      buildIndex: () => indexResult(),
      storeFactory: () => ({
        loadAsync: async function (result) {
          if (++attempts > 1) throw new Error('store load failed');
          await new Promise(resolve => { releaseLoad = resolve; });
          this.stats = result.stats;
        },
      }),
    });
    const initial = manager.start();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager.store, null);
    assert.equal(manager.state, 'building');
    assert.equal(manager.generation, 0);
    releaseLoad();
    await initial;
    const original = manager.store;
    await assert.rejects(manager.reindex(), /store load failed/u);
    assert.strictEqual(manager.store, original);
    assert.equal(manager.state, 'failed');
    assert.equal(manager.generation, 1);
  });

  test('rejects partial generations on file or directory read failures and recovers', async t => {
    const root = temporaryDirectory(t);
    const source = path.join(root, 'module.bsl');
    fs.writeFileSync(source, 'Procedure Original() Export\nEndProcedure');
    const manager = new IndexManager(root);
    await manager.start();
    const original = manager.store;

    for (const method of ['readFileSync', 'readdirSync']) {
      const real = fs[method];
      const expectedPath = method === 'readFileSync' ? source : root;
      const mock = t.mock.method(fs, method, function (file, ...args) {
        if (String(file) === expectedPath) {
          const error = new Error(`EACCES: permission denied, '${expectedPath}'`);
          error.code = 'EACCES';
          throw error;
        }
        return real.call(this, file, ...args);
      });
      try {
        await assert.rejects(manager.reindex(), /EACCES/u);
        assert.strictEqual(manager.store, original);
        assert.equal(manager.state, 'failed');
        assert.equal(manager.generation, 1);
        assert.equal(manager.store.findSymbol('Original').length, 1);
        assert.ok(!manager.lastError.includes(root));
      } finally {
        mock.mock.restore();
      }
    }
    await manager.reindex();
    assert.equal(manager.state, 'ready');
    assert.equal(manager.generation, 2);
  });

  test('can retry after a synchronously throwing build adapter', async () => {
    let attempts = 0;
    const manager = new IndexManager('synthetic', {
      skipValidation: true,
      buildIndex: () => {
        if (++attempts === 1) throw new Error('first attempt failed');
        return indexResult();
      },
    });
    await assert.rejects(manager.start(), /first attempt/u);
    await manager.reindex();
    assert.equal(attempts, 2);
    assert.equal(manager.generation, 1);
    assert.equal(manager.state, 'ready');
  });

  test('publishes complete generations atomically and retains the last good index', async () => {
    let releaseBuild;
    let calls = 0;
    const manager = new IndexManager('synthetic', {
      skipValidation: true,
      buildIndex: async () => {
        calls++;
        if (calls === 1) {
          await new Promise(resolve => { releaseBuild = resolve; });
          return indexResult('First');
        }
        throw new Error('synthetic rebuild failure');
      },
    });

    const initial = manager.start();
    assert.equal(manager.state, 'building');
    assert.equal(manager.store, null);
    releaseBuild();
    const first = await initial;
    assert.equal(first.generation, 1);
    assert.equal(manager.store.findSymbol('First').length, 1);

    await assert.rejects(manager.reindex(), /synthetic rebuild failure/iu);
    assert.equal(manager.state, 'failed');
    assert.equal(manager.generation, 1);
    assert.equal(manager.store.findSymbol('First').length, 1);
    assert.equal(manager.lastError, '<configured-root> rebuild failure');
  });

  test('joins concurrent reindex requests and keeps the root immutable', async () => {
    let releaseBuild;
    let buildCount = 0;
    const manager = new IndexManager('fixed-root', {
      skipValidation: true,
      buildIndex: async () => {
        buildCount++;
        await new Promise(resolve => { releaseBuild = resolve; });
        return indexResult();
      },
    });

    const first = manager.reindex();
    const second = manager.reindex();
    assert.strictEqual(first, second);
    assert.equal(buildCount, 1);
    assert.throws(() => { manager.rootPath = 'changed'; }, TypeError);
    releaseBuild();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.generation, 1);
    assert.equal(secondResult.generation, 1);
  });
});
