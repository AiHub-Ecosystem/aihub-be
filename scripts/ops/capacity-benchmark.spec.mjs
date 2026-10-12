import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  authAndGradingWorkload,
  hasCompleteLoadDelivery,
  highestPassingRate,
  jsonAfterPrefix,
  metricValue,
  overloadRate,
  parseDockerStats,
  taggedMetricValues,
  task1PayloadFromFixture,
} from './capacity-benchmark-utils.mjs';

await test('chooses the highest offered rate meeting the deadline without errors', () => {
  const runs = [
    {
      offeredRateRps: 8,
      holdDuration: '10s',
      completedRequests: 80,
      droppedIterations: 0,
      routes: { writing_task1: { count: 80, p99Ms: 900, errorCount: 0 } },
    },
    {
      offeredRateRps: 16,
      holdDuration: '10s',
      completedRequests: 160,
      droppedIterations: 0,
      routes: { writing_task1: { count: 160, p99Ms: 60_000, errorCount: 0 } },
    },
    {
      offeredRateRps: 32,
      holdDuration: '10s',
      completedRequests: 320,
      droppedIterations: 0,
      routes: { writing_task1: { count: 320, p99Ms: 1200, errorCount: 1 } },
    },
    {
      offeredRateRps: 24,
      holdDuration: '10s',
      completedRequests: 239,
      droppedIterations: 0,
      routes: { writing_task1: { count: 239, p99Ms: 900, errorCount: 0 } },
    },
    {
      offeredRateRps: 40,
      holdDuration: '10s',
      completedRequests: 400,
      droppedIterations: 1,
      routes: { writing_task1: { count: 400, p99Ms: 900, errorCount: 0 } },
    },
  ];

  assert.equal(highestPassingRate(runs, ['writing_task1'], 60_000), 40);
  assert.equal(
    highestPassingRate(runs.slice(1, 4), ['writing_task1'], 59_000),
    0,
  );
  assert.equal(hasCompleteLoadDelivery(runs[0]), true);
  assert.equal(hasCompleteLoadDelivery(runs[3]), false);
  assert.equal(hasCompleteLoadDelivery(runs[4]), true);
  assert.equal(
    hasCompleteLoadDelivery({ ...runs[0], holdDuration: '10 seconds' }),
    false,
  );
});

await test('places the controlled overload stage above the highest passing stage', () => {
  assert.equal(overloadRate([4, 8, 16, 32], 16), 32);
  assert.equal(overloadRate([4, 8, 16, 32], 32), 48);
  assert.equal(overloadRate([4, 8, 16, 32], 0), 48);
});

await test('maps the Task 1 provider fixture to the public API request shape', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        '../../test/fixtures/ai-writing/grade-task1.request.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );

  assert.deepEqual(task1PayloadFromFixture(fixture), {
    question: fixture.question,
    chart_type: fixture.topic,
    essay: fixture.essay,
    image_url: fixture.url,
  });
});

await test('interleaves auth and grading routes across four-request blocks', () => {
  const authRoutes = new Set(['login', 'refresh', 'web_session_exchange']);
  const counts = authAndGradingWorkload.reduce(
    (result, route) => ({ ...result, [route]: (result[route] ?? 0) + 1 }),
    {},
  );

  assert.deepEqual(counts, {
    writing_task1: 3,
    writing_task2: 3,
    speaking_multipart: 3,
    login: 2,
    speaking_json: 3,
    refresh: 1,
    web_session_exchange: 1,
  });
  for (let index = 0; index < authAndGradingWorkload.length; index += 4) {
    assert.equal(
      authAndGradingWorkload
        .slice(index, index + 4)
        .filter((route) => authRoutes.has(route)).length,
      1,
    );
  }
});

await test('reads tagged k6 metrics and Docker resource samples', () => {
  const metrics = {
    resident: { values: { min: 10, max: 42 } },
    'pool_waiting{pool:auth}': { values: { max: 2 } },
    'pool_waiting{pool:runtime}': { values: { max: 1 } },
  };

  assert.equal(metricValue(metrics, 'resident'), 42);
  assert.equal(
    metricValue(
      { route_count: { values: { count: 13 } } },
      'route_count',
      'count',
    ),
    13,
  );
  assert.deepEqual(taggedMetricValues(metrics, 'pool_waiting'), [
    { labels: { pool: 'auth' }, values: { max: 2 } },
    { labels: { pool: 'runtime' }, values: { max: 1 } },
  ]);
  assert.deepEqual(
    parseDockerStats('{"CPUPerc":"150.25%","MemUsage":"384MiB / 768MiB"}'),
    { cpuPercent: 150.25, memoryBytes: 402653184 },
  );
});

await test('reads JSON from plain output and escaped k6 console logs', () => {
  const output = [
    'BENCHMARK_SUMMARY_JSON {"state":{"duration":3}}',
    'time="2026-10-12T00:00:00Z" level=info msg="BENCHMARK_STUB_STATS {\\"requests\\":{},\\"errors\\":{}}" source=console',
  ].join('\n');

  assert.deepEqual(jsonAfterPrefix(output, 'BENCHMARK_SUMMARY_JSON '), {
    state: { duration: 3 },
  });
  assert.deepEqual(jsonAfterPrefix(output, 'BENCHMARK_STUB_STATS '), {
    requests: {},
    errors: {},
  });
});
