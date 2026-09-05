'use strict';

const { performance } = require('node:perf_hooks');
const { setImmediate: yieldToEventLoop } = require('node:timers/promises');

function runSync(iterator) {
  let step;
  do { step = iterator.next(); } while (!step.done);
  return step.value;
}

async function runAsync(iterator, { budgetMs = 10 } = {}) {
  await yieldToEventLoop();
  let deadline = performance.now() + budgetMs;
  while (true) {
    const step = iterator.next();
    if (step.done) return step.value;
    if (performance.now() >= deadline) {
      await yieldToEventLoop();
      deadline = performance.now() + budgetMs;
    }
  }
}

// Stable in-place sorting with small native-sort runs and cooperative merges.
// A synchronous caller can drain the same steps without scheduling overhead.
function* sortSteps(values, compare) {
  const batchSize = 512;
  for (let start = 0; start < values.length; start += batchSize) {
    const run = values.slice(start, start + batchSize).sort(compare);
    for (let index = 0; index < run.length; index++) values[start + index] = run[index];
    yield;
  }
  let buffer;
  for (let width = batchSize; width < values.length; width *= 2) {
    for (let start = 0; start + width < values.length; start += width * 2) {
      const middle = start + width;
      const end = Math.min(start + width * 2, values.length);
      if (compare(values[middle - 1], values[middle]) <= 0) {
        yield;
        continue;
      }
      buffer ||= new Array(values.length);
      let left = start;
      let right = middle;
      for (let index = start; index < end; index++) {
        buffer[index] = right >= end
          || (left < middle && compare(values[left], values[right]) <= 0)
          ? values[left++] : values[right++];
        if ((index - start + 1) % batchSize === 0) yield;
      }
      for (let index = start; index < end; index++) {
        values[index] = buffer[index];
        if ((index - start + 1) % batchSize === 0) yield;
      }
      yield;
    }
  }
  return values;
}

module.exports = { runAsync, runSync, sortSteps };
