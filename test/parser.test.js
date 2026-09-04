'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');

const { buildIndex } = require('../src/indexer');
const { moduleNameFromPath, parseFile } = require('../src/parser');

const fixtureRoot = path.join(__dirname, 'fixtures');

function readFixture(...parts) {
  return fs.readFileSync(path.join(fixtureRoot, ...parts), 'utf8');
}

function callNames(parsed) {
  return parsed.calls.map(call => call.calleeName);
}

describe('parser baseline contract', () => {
  test('extracts a Unicode module display name from Windows and POSIX paths', () => {
    const windowsPath = String.raw`CommonModules\Тестовый Модуль\Ext\Module.bsl`;
    const posixPath = 'CommonModules/Тестовый Модуль/Ext/Module.bsl';

    assert.equal(moduleNameFromPath(windowsPath), 'Тестовый Модуль');
    assert.equal(moduleNameFromPath(posixPath), 'Тестовый Модуль');
  });

  test('parses the original synthetic module with assertions', () => {
    const relativePath = path.join(
      'CommonModules',
      'ТестовыйМодуль',
      'Ext',
      'Module.bsl'
    );
    const parsed = parseFile(
      readFixture('CommonModules', 'ТестовыйМодуль', 'Ext', 'Module.bsl'),
      relativePath
    );

    assert.equal(parsed.module, 'ТестовыйМодуль');
    assert.deepEqual(
      parsed.procedures.map(({ name, kind, isExport }) => ({ name, kind, isExport })),
      [
        { name: 'ПубличнаяПроцедура', kind: 'procedure', isExport: true },
        { name: 'ВычислитьЧтоТо', kind: 'function', isExport: true },
        { name: 'ВспомогательнаяПроцедура', kind: 'procedure', isExport: false },
        { name: 'ПомощникВычисления', kind: 'function', isExport: false },
      ]
    );
    assert.ok(callNames(parsed).includes('ВычислитьЧтоТо'));
    assert.ok(callNames(parsed).includes('ЭкспортныйМетод'));
  });

  test('ignores calls in comments and ordinary strings with escaped quotes', () => {
    const parsed = parseFile(
      readFixture('parser', 'CommonModules', 'Русский Синтаксис', 'Ext', 'Module.bsl'),
      path.join('CommonModules', 'Русский Синтаксис', 'Ext', 'Module.bsl')
    );

    assert.deepEqual(callNames(parsed), ['НастоящийВызов']);
  });
});

describe('parser hardening contract', () => {
  test('supports Russian and English declarations, including multiline exports', () => {
    const russian = parseFile(
      readFixture('parser', 'CommonModules', 'Русский Синтаксис', 'Ext', 'Module.bsl'),
      path.join('CommonModules', 'Русский Синтаксис', 'Ext', 'Module.bsl')
    );
    const english = parseFile(
      readFixture('parser', 'CommonModules', 'English Syntax', 'Ext', 'Module.bsl'),
      path.join('CommonModules', 'English Syntax', 'Ext', 'Module.bsl')
    );

    assert.deepEqual(
      russian.procedures.map(({ name, kind, isExport }) => ({ name, kind, isExport })),
      [
        { name: 'РусскаяПроцедура', kind: 'procedure', isExport: true },
        { name: 'МногострочнаяФункция', kind: 'function', isExport: true },
      ]
    );
    assert.deepEqual(
      english.procedures.map(({ name, kind, isExport }) => ({ name, kind, isExport })),
      [
        { name: 'EnglishProcedure', kind: 'procedure', isExport: true },
        { name: 'MultilineFunction', kind: 'function', isExport: true },
      ]
    );
  });

  test('does not create calls from multiline query text', () => {
    const parsed = parseFile(
      readFixture('parser', 'CommonModules', 'Запросы Юникод', 'Ext', 'Module.bsl'),
      path.join('CommonModules', 'Запросы Юникод', 'Ext', 'Module.bsl')
    );
    const names = callNames(parsed);

    assert.ok(names.includes('РеальныйПомощник'));
    assert.ok(!names.some(name => name.toLocaleLowerCase('ru') === 'естьnull'));
    assert.ok(!names.some(name => name.toLocaleLowerCase('ru') === 'значение'));
  });

  test('does not classify Запрос.УстановитьПараметр as a common-module call', () => {
    const parsed = parseFile(
      readFixture('parser', 'CommonModules', 'Запросы Юникод', 'Ext', 'Module.bsl'),
      path.join('CommonModules', 'Запросы Юникод', 'Ext', 'Module.bsl')
    );
    const candidate = parsed.calls.find(
      call => call.calleeName.toLocaleLowerCase('ru') === 'установитьпараметр'
    );

    // A lexer/parser may retain this as an unresolved receiver candidate for the
    // second-pass resolver, but it must not claim that "Запрос" is a module.
    assert.ok(candidate, 'the receiver call must remain available to the resolver');
    assert.notEqual(candidate.calleeModule?.toLocaleLowerCase('ru'), 'запрос');
    assert.equal(candidate.receiver?.toLocaleLowerCase('ru'), 'запрос');
  });

  test('indexes fixtures under Unicode paths without changing provenance', () => {
    const index = buildIndex(path.join(fixtureRoot, 'parser'));
    const queryProc = index.procedures.find(proc => proc.name === 'ВыполнитьЗапрос');

    assert.ok(queryProc, 'ВыполнитьЗапрос must be indexed');
    assert.equal(queryProc.module, 'Запросы Юникод');
    assert.match(queryProc.file.replaceAll('\\', '/'), /Запросы Юникод\/Ext\/Module\.bsl$/u);
  });
});
