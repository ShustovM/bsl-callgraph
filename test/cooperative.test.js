'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { runAsync, runSync, sortSteps } = require('../src/cooperative');

test('cooperative sorting is stable across merges and matches native sorting', async () => {
  const values = Array.from({ length: 3001 }, (_, index) => ({
    key: (index * 37) % 101,
    originalIndex: index,
  }));
  const compare = (left, right) => left.key - right.key;
  const expected = [...values].sort(compare);
  const sync = [...values];
  assert.strictEqual(runSync(sortSteps(sync, compare)), sync);
  assert.deepEqual(sync, expected);
  const asyncValues = [...values];
  assert.strictEqual(await runAsync(sortSteps(asyncValues, compare)), asyncValues);
  assert.deepEqual(asyncValues, expected);
});
