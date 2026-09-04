'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');

const { IndexManager } = require('../src/index-manager');
const { buildIndex, scanBslFiles, validateRoot } = require('../src/indexer');

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
});

describe('IndexManager', () => {
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
