import assert from 'node:assert/strict';
import test from 'node:test';

import { percentile, summarizeLatency } from './summary';

void test('percentile uses nearest-rank without mutating the sample order', () => {
  const samples = [9, 1, 4, 2, 7];

  assert.equal(percentile(samples, 0.5), 4);
  assert.equal(percentile(samples, 0.95), 9);
  assert.deepEqual(samples, [9, 1, 4, 2, 7]);
});

void test('empty samples produce null percentiles', () => {
  assert.equal(percentile([], 0.99), null);
  assert.deepEqual(summarizeLatency([]), {
    sampleCount: 0,
    p50Ms: null,
    p95Ms: null,
    p99Ms: null,
  });
});

void test('percentile rejects fractions outside its documented range', () => {
  assert.throws(() => percentile([1], -0.1), RangeError);
  assert.throws(() => percentile([1], 1.1), RangeError);
});
