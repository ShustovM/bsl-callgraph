'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { moduleIdentityFromPath } = require('../src/module-identity');
const { parseFile } = require('../src/parser');
const { exploratoryEdges, resolveCalls, resolvedEdges } = require('../src/resolver');

function parse(source, file) {
  return parseFile(source, file);
}

function combine(...parsedModules) {
  return {
    procedures: parsedModules.flatMap(module => module.procedures),
    calls: parsedModules.flatMap(module => module.calls),
  };
}

function edgeByName(edges, name, receiver = undefined) {
  return edges.find(edge => edge.calleeName === name
    && (receiver === undefined || edge.receiver === receiver));
}

describe('canonical module identity', () => {
  test('normalizes separators while retaining object, module, form, and command identity', () => {
    const windows = moduleIdentityFromPath(
      String.raw`Documents\Order\Forms\Main Form\Ext\Form\Module.bsl`
    );
    const posix = moduleIdentityFromPath(
      'Documents/Order/Forms/Main Form/Ext/Form/Module.bsl'
    );
    const otherObject = moduleIdentityFromPath(
      'Catalogs/Product/Forms/Main Form/Ext/Form/Module.bsl'
    );
    const command = moduleIdentityFromPath(
      'Documents/Order/Commands/Post/Ext/CommandModule.bsl'
    );
    const objectModule = moduleIdentityFromPath('Documents/Order/Ext/ObjectModule.bsl');
    const managerModule = moduleIdentityFromPath('Documents/Order/Ext/ManagerModule.bsl');

    assert.equal(windows.id, posix.id);
    assert.equal(windows.displayName, 'Main Form');
    assert.equal(windows.objectKind, 'document');
    assert.equal(windows.moduleKind, 'form-module');
    assert.equal(windows.formName, 'Main Form');
    assert.notEqual(windows.id, otherObject.id);
    assert.equal(command.moduleKind, 'command-module');
    assert.equal(command.commandName, 'Post');
    assert.notEqual(objectModule.id, managerModule.id);
    assert.equal(objectModule.moduleKind, 'object-module');
    assert.equal(managerModule.moduleKind, 'manager-module');
  });

  test('keeps aliases separate from the canonical path-based key', () => {
    const identity = moduleIdentityFromPath('CommonModules/Readable Name/Ext/Module.bsl');

    assert.equal(identity.displayName, 'Readable Name');
    assert.deepEqual(identity.aliases, ['Readable Name']);
    assert.match(identity.id, /^module:commonmodules\/readable name\/ext\/module$/u);
  });
});

describe('second-pass edge resolver', () => {
  test('resolves local, recursive, known-module, and unique exported calls', () => {
    const caller = parse(`
Procedure Start() Export
    LocalHelper();
    Start();
    KnownModule.Remote();
    UniqueExport();
EndProcedure

Procedure LocalHelper()
EndProcedure
`, 'CommonModules/Caller/Ext/Module.bsl');
    const known = parse(`
Procedure Remote() Export
EndProcedure
`, 'CommonModules/KnownModule/Ext/Module.bsl');
    const unique = parse(`
Procedure UniqueExport() Export
EndProcedure
`, 'CommonModules/Unique/Ext/Module.bsl');

    const edges = resolveCalls(combine(caller, known, unique));
    const local = edgeByName(edges, 'LocalHelper');
    const recursive = edgeByName(edges, 'Start');
    const qualified = edgeByName(edges, 'Remote');
    const exported = edgeByName(edges, 'UniqueExport');

    assert.deepEqual(
      [local.reason, recursive.reason, qualified.reason, exported.reason],
      ['local-symbol', 'local-symbol', 'known-module', 'unique-exported-symbol']
    );
    assert.deepEqual(
      [local.confidence, qualified.confidence, exported.confidence],
      ['high', 'high', 'medium']
    );
    for (const edge of [local, recursive, qualified, exported]) {
      assert.equal(edge.resolution, 'resolved');
      assert.ok(edge.calleeId);
      assert.ok(edge.target?.file);
      assert.equal(edge.candidates.length, 1);
    }
  });

  test('keeps duplicate exports ambiguous and arbitrary receivers dynamic', () => {
    const caller = parse(`
Procedure Start() Export
    Shared();
    Query.SetParameter();
    Missing();
EndProcedure
`, 'CommonModules/Caller/Ext/Module.bsl');
    const first = parse(`
Procedure Shared() Export
EndProcedure
`, 'CommonModules/First/Ext/Module.bsl');
    const second = parse(`
Procedure Shared() Export
EndProcedure
`, 'CommonModules/Second/Ext/Module.bsl');

    const edges = resolveCalls(combine(caller, first, second));
    const ambiguous = edgeByName(edges, 'Shared');
    const receiver = edgeByName(edges, 'SetParameter', 'Query');
    const missing = edgeByName(edges, 'Missing');

    assert.equal(ambiguous.resolution, 'ambiguous');
    assert.equal(ambiguous.reason, 'multiple-exported-symbols');
    assert.equal(ambiguous.target, null);
    assert.equal(ambiguous.candidates.length, 2);
    assert.equal(receiver.resolution, 'dynamic');
    assert.equal(receiver.reason, 'unknown-receiver');
    assert.equal(receiver.calleeModule, null);
    assert.equal(missing.resolution, 'dynamic');
    assert.equal(missing.reason, 'unknown-unqualified-symbol');
  });

  test('does not use exported methods from forms as global common-module targets', () => {
    const caller = parse(`
Procedure Start() Export
    FormHandler();
EndProcedure
`, 'CommonModules/Caller/Ext/Module.bsl');
    const form = parse(`
Procedure FormHandler() Export
EndProcedure
`, 'Documents/Order/Forms/Main/Ext/Form/Module.bsl');

    const edge = edgeByName(resolveCalls(combine(caller, form)), 'FormHandler');
    assert.equal(edge.resolution, 'dynamic');
    assert.equal(edge.reason, 'unknown-unqualified-symbol');
  });

  test('keeps expression receivers dynamic without losing nested calls', () => {
    const caller = parse(`
Procedure Start()
    GetObject().Target();
    Items[GetIndex()].Target();
    Object.Library.Remote();
    GetObject().Library.Remote();
    (Library).Remote();
    Library.Remote();
EndProcedure

Function GetObject()
EndFunction

Function GetIndex()
EndFunction

Procedure Target()
EndProcedure
`, 'CommonModules/Caller/Ext/Module.bsl');
    const library = parse('Procedure Remote() Export\nEndProcedure',
      'CommonModules/Library/Ext/Module.bsl');

    const edges = resolveCalls(combine(caller, library));
    const expressionCalls = edges.filter(edge => edge.receiver === '<expression>');
    assert.equal(expressionCalls.length, 5);
    for (const edge of expressionCalls) {
      assert.equal(edge.resolution, 'dynamic');
      assert.equal(edge.reason, 'complex-receiver');
      assert.equal(edge.calleeId, null);
      assert.deepEqual(edge.candidates, []);
    }
    assert.equal(edges.filter(edge => edge.calleeName === 'GetObject').length, 2);
    assert.equal(edgeByName(edges, 'GetIndex').reason, 'local-symbol');
    assert.equal(edgeByName(edges, 'Remote', 'Library').reason, 'known-module');
    assert.deepEqual(resolvedEdges(edges).map(edge => edge.calleeName),
      ['GetObject', 'GetIndex', 'GetObject', 'Remote']);
  });

  test('does not resolve a qualified call to a non-exported module method', () => {
    const caller = parseFile([
      'Procedure Run() Export',
      '  Library.PrivateHelper();',
      'EndProcedure',
    ].join('\n'), 'CommonModules/Caller/Ext/Module.bsl');
    const library = parseFile([
      'Procedure PrivateHelper()',
      'EndProcedure',
    ].join('\n'), 'CommonModules/Library/Ext/Module.bsl');

    const [edge] = resolveCalls(
      [...caller.procedures, ...library.procedures],
      caller.calls
    );
    assert.equal(edge.resolution, 'dynamic');
    assert.equal(edge.reason, 'known-module-target-not-found');
  });

  test('reports duplicate display aliases as ambiguous and orders candidates canonically', () => {
    const caller = parse(`
Procedure Start() Export
    Main.Handle();
EndProcedure
`, 'CommonModules/Caller/Ext/Module.bsl');
    const documentForm = parse(`
Procedure Handle() Export
EndProcedure
`, 'Documents/Order/Forms/Main/Ext/Form/Module.bsl');
    const catalogForm = parse(`
Procedure Handle() Export
EndProcedure
`, 'Catalogs/Product/Forms/Main/Ext/Form/Module.bsl');

    const edge = edgeByName(
      resolveCalls(combine(caller, documentForm, catalogForm)),
      'Handle',
      'Main'
    );
    assert.equal(edge.resolution, 'ambiguous');
    assert.equal(edge.reason, 'ambiguous-module-alias');
    assert.deepEqual(edge.candidates, [...edge.candidates].sort());
    assert.equal(edge.candidateTargets.length, 2);
  });

  test('provides exact and explicit exploratory edge views', () => {
    const caller = parse(`
Procedure Start() Export
    Start();
    Unknown();
    Object.Method();
EndProcedure
`, 'CommonModules/Caller/Ext/Module.bsl');
    const edges = resolveCalls(combine(caller));

    assert.equal(resolvedEdges(edges).length, 1);
    assert.equal(exploratoryEdges(edges).length, 1);
    assert.equal(exploratoryEdges(edges, { includeDynamic: true }).length, 3);
  });

  test('produces deterministic edges independently of input file order', () => {
    const caller = parse(`
Procedure Start() Export
    Zed(); Alpha();
EndProcedure
`, 'CommonModules/Caller/Ext/Module.bsl');
    const alpha = parse('Procedure Alpha() Export\nEndProcedure', 'CommonModules/A/Ext/Module.bsl');
    const zed = parse('Procedure Zed() Export\nEndProcedure', 'CommonModules/Z/Ext/Module.bsl');

    const first = resolveCalls(combine(caller, alpha, zed));
    const second = resolveCalls(combine(zed, caller, alpha));
    assert.deepEqual(first, second);
  });
});

describe('lexer and parser diagnostics', () => {
  test('recognizes declarations only in declaration context and supports async methods', () => {
    const parsed = parse(`Procedure Configure() Export
    Settings.Procedure = "Handler";
EndProcedure

Async Function LoadAsync() Export
EndFunction

Асинх Процедура ЗагрузитьАсинх() Экспорт
КонецПроцедуры
`, 'CommonModules/Declarations/Ext/Module.bsl');

    assert.deepEqual(
      parsed.procedures.map(procedure => procedure.name),
      ['Configure', 'LoadAsync', 'ЗагрузитьАсинх']
    );
    assert.deepEqual(parsed.diagnostics, []);
  });

  test('retains call locations and reports malformed input without throwing', () => {
    const parsed = parse(`Procedure Broken() Export
    RealCall();
    Text = "not closed
`, 'CommonModules/Broken/Ext/Module.bsl');

    assert.equal(parsed.calls[0].callLine, 2);
    assert.equal(parsed.calls[0].callColumn, 5);
    assert.ok(parsed.diagnostics.some(item => item.code === 'unclosed-string'));
    assert.ok(parsed.diagnostics.some(item => item.code === 'unclosed-procedure'));
  });

  test('reports unclosed parentheses without discarding earlier symbols', () => {
    const parsed = parse(`Procedure Broken() Export
    RealCall(
EndProcedure
`, 'CommonModules/Broken/Ext/Module.bsl');

    assert.equal(parsed.procedures[0].name, 'Broken');
    assert.equal(parsed.calls[0].calleeName, 'RealCall');
    assert.ok(parsed.diagnostics.some(item => item.code === 'unclosed-parenthesis'));
  });
});
