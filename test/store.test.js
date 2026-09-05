'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { CallGraphStore } = require('../src/store');

function procedure(moduleId, module, name, file, line = 1) {
  return {
    id: `${moduleId}:${name.toLocaleLowerCase('ru')}`,
    moduleId,
    module,
    moduleDisplayName: module,
    name,
    kind: 'procedure',
    isExport: true,
    file,
    line,
  };
}

function call({
  caller,
  callee,
  line = 1,
  resolution = 'resolved',
  candidates,
}) {
  return {
    id: `${caller.id}->${callee?.id || 'unresolved'}:${line}:${resolution}`,
    callerId: caller.id,
    callerName: caller.name,
    callerModuleId: caller.moduleId,
    callerModule: caller.module,
    calleeId: callee?.id || null,
    calleeName: callee?.name || 'Обработать',
    calleeModuleId: callee?.moduleId || null,
    calleeModule: callee?.module || 'ОбщаяФорма',
    callLine: line,
    resolution,
    candidates: candidates || (callee ? [callee.id] : []),
  };
}

function loadStore(procedures, calls = []) {
  const store = new CallGraphStore();
  store.load({
    procedures,
    calls,
    stats: {
      files: new Set(procedures.map(proc => proc.file)).size,
      procedures: procedures.length,
      calls: calls.length,
      errors: 0,
    },
  });
  return store;
}

function pageItems(page) {
  if (Array.isArray(page)) return page;
  return page.items || page.results;
}

function nextCursor(page) {
  return page.nextCursor;
}

function collectAllPages(fetchPage, limit) {
  const pages = [];
  const items = [];
  const seenCursors = new Set();
  let cursor;

  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = fetchPage(cursor);
    const currentItems = pageItems(page);
    assert.ok(Array.isArray(currentItems), 'a page must expose an items array');
    assert.ok(currentItems.length <= limit, 'a page must not exceed its requested limit');
    pages.push(currentItems);
    items.push(...currentItems);

    const followingCursor = nextCursor(page);
    if (followingCursor == null) return { items, pages };

    assert.ok(!seenCursors.has(followingCursor), 'pagination cursor must advance');
    seenCursors.add(followingCursor);
    cursor = followingCursor;
  }

  assert.fail('pagination did not terminate within 100 pages');
}

function paginationFixture() {
  const target = procedure('common/target', 'Target', 'Target', 'CommonModules/Target/Ext/Module.bsl');
  const callers = ['E', 'D', 'C', 'B', 'A'].map(letter =>
    procedure(`callers/${letter.toLowerCase()}`, `Caller${letter}`, `Caller${letter}`, `Callers/${letter}/Ext/Module.bsl`)
  );
  const callerEdges = callers.map((callerProc, index) =>
    call({ caller: callerProc, callee: target, line: index + 1 })
  );
  const root = procedure('common/root', 'Root', 'Root', 'CommonModules/Root/Ext/Module.bsl');
  const callees = ['E', 'D', 'C', 'B', 'A'].map(letter =>
    procedure(`callees/${letter.toLowerCase()}`, `Callee${letter}`, `Callee${letter}`, `Callees/${letter}/Ext/Module.bsl`)
  );
  const calleeEdges = callees.map((calleeProc, index) =>
    call({ caller: root, callee: calleeProc, line: index + 20 })
  );

  return {
    store: loadStore(
      [target, ...callers, root, ...callees],
      [...callerEdges, ...calleeEdges]
    ),
    expectedCallerIds: callers.slice().reverse().map(proc => proc.id),
    expectedCalleeIds: callees.slice().reverse().map(proc => proc.id),
  };
}

function assertCompleteStablePagination(readPages, idField, expectedIds) {
  const firstRead = readPages();
  assert.deepEqual(firstRead.pages.map(page => page.length), [2, 2, 1]);
  assert.deepEqual(firstRead.items.map(item => item[idField]), expectedIds);
  assert.equal(new Set(firstRead.items.map(item => item.id)).size, expectedIds.length);

  const secondRead = readPages();
  assert.deepEqual(
    secondRead.items.map(item => item.id),
    firstRead.items.map(item => item.id),
    'repeating the same traversal must preserve order'
  );
}

describe('store baseline contract', () => {
  test('supports case-insensitive symbol lookup and module filtering', () => {
    const first = procedure('common/a', 'МодульА', 'Выполнить', 'CommonModules/A/Ext/Module.bsl');
    const second = procedure('common/b', 'МодульБ', 'Выполнить', 'CommonModules/B/Ext/Module.bsl');
    const store = loadStore([first, second]);

    assert.deepEqual(pageItems(store.findSymbol('выполнить')), [first, second]);
    assert.deepEqual(pageItems(store.findSymbol('ВЫПОЛНИТЬ', 'модульб')), [second]);
  });

  test('deduplicates identical call sites but retains distinct source lines', () => {
    const root = procedure('common/root', 'Root', 'Root', 'CommonModules/Root/Ext/Module.bsl');
    const target = procedure('common/target', 'Target', 'Target', 'CommonModules/Target/Ext/Module.bsl');
    const first = call({ caller: root, callee: target, line: 10 });
    const duplicate = { ...first };
    const anotherLine = call({ caller: root, callee: target, line: 11 });
    const store = loadStore([root, target], [first, duplicate, anotherLine]);

    assert.deepEqual(pageItems(store.getCallees('Root', 'Root')), [first, anotherLine]);
    assert.deepEqual(pageItems(store.getCallers('Target', 'Target')), [first, anotherLine]);
  });
});

describe('store hardening contract', () => {
  test('paginates a high-fan-in graph without exceeding the argument stack', () => {
    const caller = procedure('common/a', 'A', 'A', 'CommonModules/A/Ext/Module.bsl');
    const target = procedure('common/b', 'B', 'B', 'CommonModules/B/Ext/Module.bsl');
    const edges = Array.from({ length: 130000 }, (_, line) =>
      call({ caller, callee: target, line: line + 1 })
    );
    const store = loadStore([caller, target], edges);
    const page = store.getCallers('B', undefined, { limit: 1 });
    assert.equal(page.items.length, 1);
    assert.equal(page.total, edges.length);
    assert.ok(page.nextCursor);
    assert.equal(store.getImpact('B', undefined, 1, { limit: 1 }).items.length, 1);
  });

  test('keeps form, object, and manager modules with duplicate display names distinct', () => {
    const formModule = {
      ...procedure(
        'documents/order/forms/duplicate/form-module',
        'Дубликат',
        'Обработать',
        'Documents/Order/Forms/Дубликат/Ext/Form/Module.bsl'
      ),
      moduleKind: 'form',
    };
    const objectModule = {
      ...procedure(
        'documents/duplicate/object-module',
        'Дубликат',
        'Обработать',
        'Documents/Дубликат/Ext/ObjectModule.bsl'
      ),
      moduleKind: 'object',
    };
    const managerModule = {
      ...procedure(
        'catalogs/duplicate/manager-module',
        'Дубликат',
        'Обработать',
        'Catalogs/Дубликат/Ext/ManagerModule.bsl'
      ),
      moduleKind: 'manager',
    };
    const caller = procedure(
      'common/caller',
      'Вызывающий',
      'Запустить',
      'CommonModules/Caller/Ext/Module.bsl'
    );
    const calls = [managerModule, formModule, objectModule].map((callee, index) =>
      call({ caller, callee, line: index + 10 })
    );
    const store = loadStore([managerModule, caller, formModule, objectModule], calls);
    const expectedIds = [managerModule.id, formModule.id, objectModule.id].sort();

    assert.equal(store.procedures.size, 4);
    assert.deepEqual(
      pageItems(store.findSymbol('Обработать', 'Дубликат')).map(proc => proc.id).sort(),
      expectedIds
    );
    assert.deepEqual(
      pageItems(store.searchSymbols('Обработать', 'Дубликат')).map(proc => proc.id).sort(),
      expectedIds
    );
    assert.deepEqual(
      pageItems(store.getCallees('Запустить', 'Вызывающий')).map(edge => edge.calleeId).sort(),
      expectedIds
    );
    assert.deepEqual(
      pageItems(store.getCallers('Обработать')).map(edge => edge.calleeId).sort(),
      expectedIds
    );
  });

  test('excludes ambiguous edges from exact queries and exposes them explicitly', () => {
    const ambiguousCaller = procedure(
      'common/ambiguous-caller',
      'НеоднозначныйВызывающий',
      'Запустить',
      'CommonModules/AmbiguousCaller/Ext/Module.bsl'
    );
    const resolvedCaller = procedure(
      'common/resolved-caller',
      'ТочныйВызывающий',
      'Запустить',
      'CommonModules/ResolvedCaller/Ext/Module.bsl'
    );
    const first = procedure(
      'forms/first',
      'ОбщаяФорма',
      'Обработать',
      'CommonForms/First/Ext/Form/Module.bsl'
    );
    const second = procedure(
      'forms/second',
      'ОбщаяФорма',
      'Обработать',
      'CommonForms/Second/Ext/Form/Module.bsl'
    );
    const ambiguous = call({
      caller: ambiguousCaller,
      callee: null,
      line: 7,
      resolution: 'ambiguous',
      candidates: [first.id, second.id],
    });
    const resolved = call({ caller: resolvedCaller, callee: first, line: 4 });
    const store = loadStore(
      [ambiguousCaller, resolvedCaller, first, second],
      [ambiguous, resolved]
    );

    assert.deepEqual(
      {
        exactCallees: pageItems(store.getCallees('Запустить', 'НеоднозначныйВызывающий')),
        exactCallers: pageItems(store.getCallers('Обработать', 'ОбщаяФорма')),
        exactImpact: pageItems(store.getImpact('Обработать', 'ОбщаяФорма', 5)),
        exploratoryCallees: pageItems(
          store.getCallees('Запустить', 'НеоднозначныйВызывающий', {
            includeAmbiguous: true,
          })
        ),
      },
      {
        exactCallees: [],
        exactCallers: [resolved],
        exactImpact: [resolved],
        exploratoryCallees: [ambiguous],
      }
    );
  });

  test('keeps dynamic receiver calls out of the exact graph', () => {
    const caller = procedure(
      'common/query-runner',
      'Запросы',
      'ВыполнитьЗапрос',
      'CommonModules/Queries/Ext/Module.bsl'
    );
    const dynamic = {
      ...call({ caller, callee: null, line: 9, resolution: 'dynamic' }),
      calleeName: 'УстановитьПараметр',
      calleeModule: null,
      receiver: 'Запрос',
    };
    const helper = procedure(
      'common/query-helper',
      'ПомощникЗапросов',
      'УстановитьПараметр',
      'CommonModules/QueryHelper/Ext/Module.bsl'
    );
    const resolvedCaller = procedure(
      'common/resolved-query-caller',
      'ТочныйВызывающий',
      'Запустить',
      'CommonModules/ResolvedQueryCaller/Ext/Module.bsl'
    );
    const resolved = call({ caller: resolvedCaller, callee: helper, line: 3 });
    const store = loadStore([caller, helper, resolvedCaller], [dynamic, resolved]);

    assert.deepEqual(
      {
        exactCallees: pageItems(store.getCallees('ВыполнитьЗапрос', 'Запросы')),
        exactCallers: pageItems(store.getCallers('УстановитьПараметр')),
        exactImpact: pageItems(store.getImpact('УстановитьПараметр', undefined, 5)),
        exploratoryCallees: pageItems(
          store.getCallees('ВыполнитьЗапрос', 'Запросы', { includeDynamic: true })
        ),
      },
      {
        exactCallees: [],
        exactCallers: [resolved],
        exactImpact: [resolved],
        exploratoryCallees: [dynamic],
      }
    );
  });

  test('terminates on cycles, excludes the root, and respects impact depth', () => {
    const a = procedure('common/a', 'A', 'A', 'CommonModules/A/Ext/Module.bsl');
    const b = procedure('common/b', 'B', 'B', 'CommonModules/B/Ext/Module.bsl');
    const c = procedure('common/c', 'C', 'C', 'CommonModules/C/Ext/Module.bsl');
    const calls = [
      call({ caller: a, callee: b, line: 1 }),
      call({ caller: b, callee: c, line: 2 }),
      call({ caller: c, callee: a, line: 3 }),
    ];
    const store = loadStore([a, b, c], calls);

    assert.deepEqual(
      pageItems(store.getImpact('A', 'A', 1)).map(edge => edge.callerName),
      ['C']
    );
    assert.deepEqual(
      pageItems(store.getImpact('A', 'A', 2)).map(edge => edge.callerName),
      ['C', 'B']
    );
    assert.deepEqual(
      pageItems(store.getImpact('A', 'A', 10)).map(edge => edge.callerName),
      ['C', 'B']
    );
  });

  test('returns symbols and edges in deterministic canonical order', () => {
    const z = procedure('common/z', 'Z', 'Handler', 'CommonModules/Z/Ext/Module.bsl', 20);
    const a2 = procedure('common/a', 'A', 'Handler', 'CommonModules/A/Ext/Module.bsl', 10);
    const a1 = procedure('common/a-helper', 'AHelper', 'Handler', 'CommonModules/A/Ext/Helper.bsl', 5);
    const caller = procedure('common/caller', 'Caller', 'CallAll', 'CommonModules/Caller/Ext/Module.bsl');
    const store = loadStore(
      [z, a2, a1, caller],
      [
        call({ caller, callee: z, line: 30 }),
        call({ caller, callee: a2, line: 20 }),
        call({ caller, callee: a1, line: 10 }),
      ]
    );

    assert.deepEqual(
      pageItems(store.findSymbol('Handler')).map(proc => proc.moduleId),
      ['common/a', 'common/a-helper', 'common/z']
    );
    assert.deepEqual(
      pageItems(store.getCallees('CallAll', 'Caller')).map(edge => edge.calleeModuleId),
      ['common/a', 'common/a-helper', 'common/z']
    );
  });

  test('applies limits and opaque cursors without duplicates across pages', () => {
    const symbols = ['E', 'D', 'C', 'B', 'A'].map(letter =>
      procedure(
        `common/${letter.toLowerCase()}`,
        letter,
        `PageHandler${letter}`,
        `CommonModules/${letter}/Ext/Module.bsl`
      )
    );
    const store = loadStore(symbols);

    const first = store.searchSymbols('PageHandler', undefined, { limit: 2 });
    assert.equal(pageItems(first).length, 2);
    assert.ok(nextCursor(first), 'a truncated page must return nextCursor');

    const second = store.searchSymbols('PageHandler', undefined, {
      limit: 2,
      cursor: nextCursor(first),
    });
    assert.equal(pageItems(second).length, 2);
    assert.ok(nextCursor(second), 'the second truncated page must return nextCursor');

    const third = store.searchSymbols('PageHandler', undefined, {
      limit: 2,
      cursor: nextCursor(second),
    });
    assert.equal(pageItems(third).length, 1);
    assert.equal(nextCursor(third), null);

    const allIds = [...pageItems(first), ...pageItems(second), ...pageItems(third)]
      .map(proc => proc.id);
    assert.deepEqual(allIds, symbols.slice().reverse().map(proc => proc.id));
    assert.equal(new Set(allIds).size, 5);
  });

  test('paginates callers completely without duplicates and in stable order', () => {
    const { store, expectedCallerIds } = paginationFixture();
    const limit = 2;
    const readCallers = () => collectAllPages(
      cursor => store.getCallers('Target', 'Target', { limit, cursor }),
      limit
    );

    assertCompleteStablePagination(readCallers, 'callerId', expectedCallerIds);
  });

  test('paginates callees completely without duplicates and in stable order', () => {
    const { store, expectedCalleeIds } = paginationFixture();
    const limit = 2;
    const readCallees = () => collectAllPages(
      cursor => store.getCallees('Root', 'Root', { limit, cursor }),
      limit
    );

    assertCompleteStablePagination(readCallees, 'calleeId', expectedCalleeIds);
  });

  test('paginates impact completely without duplicates and in stable order', () => {
    const { store, expectedCallerIds } = paginationFixture();
    const limit = 2;
    const readImpact = () => collectAllPages(
      cursor => store.getImpact('Target', 'Target', 5, { limit, cursor }),
      limit
    );

    assertCompleteStablePagination(readImpact, 'callerId', expectedCallerIds);
  });
});
