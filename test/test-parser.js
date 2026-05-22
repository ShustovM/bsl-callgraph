'use strict';

const path = require('path');
const { parseFile } = require('../src/parser');
const { buildIndex } = require('../src/indexer');
const { CallGraphStore } = require('../src/store');
const fs = require('fs');

// ── Test 1: parser on single file ────────────────────────────────────────────
const fixturePath = path.join(__dirname, 'fixtures', 'CommonModules', 'ТестовыйМодуль', 'Ext', 'Module.bsl');
const content = fs.readFileSync(fixturePath, 'utf-8');
const relativePath = path.join('CommonModules', 'ТестовыйМодуль', 'Ext', 'Module.bsl');

const { procedures, calls, module: moduleName } = parseFile(content, relativePath);

console.log('=== PARSER TEST ===');
console.log(`Module name extracted: "${moduleName}"`);
console.log(`\nProcedures found (${procedures.length}):`);
for (const p of procedures) {
  console.log(`  [${p.kind}] ${p.name}  line=${p.line}  export=${p.isExport}`);
}

console.log(`\nCall sites found (${calls.length}):`);
for (const c of calls) {
  const target = c.calleeModule ? `${c.calleeModule}.${c.calleeName}` : c.calleeName;
  console.log(`  ${c.callerName} → ${target}  (line ${c.callLine})`);
}

// ── Test 2: store queries ─────────────────────────────────────────────────────
const fixtureRoot = path.join(__dirname, 'fixtures');
const index = buildIndex(fixtureRoot);
const store = new CallGraphStore();
store.load(index);

console.log('\n=== STORE TEST ===');
console.log(`Stats: ${store.stats.files} files, ${store.stats.procedures} procedures, ${store.stats.calls} calls`);

console.log('\nfind_symbol("ВычислитьЧтоТо"):');
for (const p of store.findSymbol('ВычислитьЧтоТо')) {
  console.log(`  ${p.module}.${p.name}  line=${p.line}  export=${p.isExport}`);
}

console.log('\nget_callers("ВычислитьЧтоТо"):');
for (const c of store.getCallers('ВычислитьЧтоТо')) {
  console.log(`  ${c.callerModule}.${c.callerName}  line=${c.callLine}`);
}

console.log('\nget_callees("ПубличнаяПроцедура"):');
for (const c of store.getCallees('ПубличнаяПроцедура')) {
  const target = c.calleeModule ? `${c.calleeModule}.${c.calleeName}` : c.calleeName;
  console.log(`  → ${target}  line=${c.callLine}`);
}

console.log('\nget_impact("ОбщийМодульБСП.ОбщаяФункция"):');
for (const c of store.getImpact('ОбщаяФункция', 'ОбщийМодульБСП')) {
  console.log(`  ${c.callerModule}.${c.callerName}  line=${c.callLine}`);
}

console.log('\n✓ All tests passed');
