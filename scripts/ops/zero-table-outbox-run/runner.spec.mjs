import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSafeDatabaseUrl,
  parseOptions,
  shouldContinueConsuming,
  summarize,
} from './runner-utils.mjs';

void test('defaults to 1,000 events per second with a bounded pool', () => {
  assert.deepEqual(parseOptions([]), {
    events: 10_000,
    rate: 1_000,
    concurrency: 32,
  });
});

void test('rejects malformed and non-positive options', () => {
  assert.throws(() => parseOptions(['--rate', '0']), /positive integer/);
  assert.throws(() => parseOptions(['--unknown', '1']), /Unknown option/);
});

void test('stopping the consumer does not wait for the expected event count', () => {
  assert.equal(shouldContinueConsuming(false, 0, 1), true);
  assert.equal(shouldContinueConsuming(false, 1, 1), false);
  assert.equal(shouldContinueConsuming(true, 0, 1), false);
});

void test('only accepts localhost aihub_outbox_eval URLs', () => {
  assert.doesNotThrow(() =>
    assertSafeDatabaseUrl('postgres://localhost/aihub_outbox_eval'),
  );
  assert.throws(
    () => assertSafeDatabaseUrl('postgres://example.com/aihub_outbox_eval'),
    /restricted to localhost/,
  );
  assert.throws(
    () => assertSafeDatabaseUrl('postgres://localhost/production'),
    /restricted to localhost/,
  );
  assert.throws(
    () => assertSafeDatabaseUrl('http://localhost/aihub_outbox_eval'),
    /restricted to localhost/,
  );
});

void test('latency summary uses nearest-rank percentiles', () => {
  assert.deepEqual(summarize([7, 1, 5, 3]), {
    count: 4,
    p50: 3,
    p95: 7,
    p99: 7,
  });
  assert.deepEqual(summarize([]), {
    count: 0,
    p50: null,
    p95: null,
    p99: null,
  });
});
