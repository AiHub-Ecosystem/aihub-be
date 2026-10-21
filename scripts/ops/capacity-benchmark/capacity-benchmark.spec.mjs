import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import test from 'node:test';

import {
  parseArgon2QueueMetrics,
  percentile,
  summarizeProbeSamples,
} from './argon2-contention-probe.mjs';
import { runProcess } from './capacity-benchmark-process.mjs';
import {
  appendStreamingMarkerChunk,
  authAndGradingWorkload,
  contentionJobsFitLoadWindow,
  hasCompleteLoadDelivery,
  hasMinimumRouteSamples,
  hasOneUserPerVu,
  highestPassingRate,
  jsonAfterPrefix,
  metricValue,
  minimumGradingHoldSeconds,
  overloadRate,
  parseDockerImageIdentity,
  parseDockerStats,
  summarizeRepetitions,
  taggedMetricValues,
  task1PayloadFromFixture,
} from './capacity-benchmark-utils.mjs';

await test('reads Argon2 queue counters from Prometheus exposition', () => {
  assert.deepEqual(
    parseArgon2QueueMetrics(
      '# HELP aihub_argon2_queue_waits_total queue waits\n' +
        'aihub_argon2_queue_waits_total 7\n' +
        'aihub_argon2_queue_refusals_total 2\n',
    ),
    { waits: 7, refusals: 2 },
  );
  assert.deepEqual(parseArgon2QueueMetrics(''), { waits: 0, refusals: 0 });
});

await test('reports nearest-rank p95 for in-process contention probes', () => {
  assert.equal(percentile([7, 1, 5, 3], 0.5), 3);
  assert.deepEqual(
    summarizeProbeSamples({
      dnsLookupMs: [1, 2, 3, 4],
      jwtVerifyMs: [5, 6, 7, 8],
      failures: 1,
      processRssPeakBytes: 4096,
    }),
    {
      dnsLookupSampleCount: 4,
      dnsLookupP95Ms: 4,
      jwtVerifySampleCount: 4,
      jwtVerifyP95Ms: 8,
      probeFailures: 1,
      processRssPeakBytes: 4096,
    },
  );
});

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

await test('requires enough completed route samples before a stage can pass', () => {
  const stage = {
    offeredRateRps: 32,
    holdDuration: '32s',
    completedRequests: 1024,
    droppedIterations: 0,
    routes: {
      writing_task1: { count: 1024, p99Ms: 900, errorCount: 0 },
    },
  };

  assert.equal(hasMinimumRouteSamples(stage, ['writing_task1'], 1000), true);
  assert.equal(
    hasMinimumRouteSamples(
      { ...stage, routes: { writing_task1: { count: 999 } } },
      ['writing_task1'],
      1000,
    ),
    false,
  );
  assert.equal(
    highestPassingRate([stage], ['writing_task1'], 60_000, 1000),
    32,
  );
  assert.equal(
    highestPassingRate(
      [
        {
          ...stage,
          routes: { writing_task1: { count: 999, p99Ms: 900, errorCount: 0 } },
        },
      ],
      ['writing_task1'],
      60_000,
      1000,
    ),
    0,
  );
});

await test('holds grading stages long enough to reach the route sample minimum', () => {
  assert.equal(minimumGradingHoldSeconds('writing_task1', 32, 1000, 15), 32);
  assert.equal(minimumGradingHoldSeconds('mixed_grading', 32, 1000, 15), 125);
  assert.equal(
    minimumGradingHoldSeconds('auth_and_grading', 32, 1000, 15),
    167,
  );
  assert.equal(minimumGradingHoldSeconds('login', 32, 1000, 15), 15);
});

await test('summarizes p99 spread and marks missing or under-sampled repetitions inconclusive', () => {
  const report = (repetition, p99Ms, status) => ({
    benchmark: {
      repetition,
      runtimeCommit: 'commit-a',
      runnerDescription: 'test runner',
      host: { logicalCpuCount: 4 },
      redis: { configuredRoundTripLatencyMs: 60 },
      downstreamStub: { latencyMs: 2000, errorRate: 0 },
      configuration: {
        stageRatesRps: [32, 64],
        minimumGradingSamples: 1000,
      },
    },
    runs: [
      {
        label: 'mixed_grading at 32 offered requests/s',
        workload: 'mixed_grading',
        offeredRateRps: 32,
        routes: {
          writing_task1: {
            count: status === 'sufficient' ? 1000 : 999,
            p50Ms: 10,
            p95Ms: 15,
            p99Ms,
          },
        },
        sampleAdequacy: {
          routes: { writing_task1: { status } },
        },
      },
    ],
  });
  const summary = summarizeRepetitions(
    [report(2, 20, 'sufficient'), report(1, 10, 'sufficient')],
    2,
  );

  assert.equal(summary.stages[0].routes.writing_task1.p99Ms.min, 10);
  assert.equal(summary.stages[0].routes.writing_task1.p99Ms.median, 15);
  assert.equal(summary.stages[0].routes.writing_task1.p99Ms.max, 20);
  assert.equal(summary.stages[0].verdict, 'sufficient');
  assert.equal(
    summarizeRepetitions(
      [report(1, 10, 'sufficient'), report(2, 20, 'inconclusive')],
      2,
    ).stages[0].verdict,
    'inconclusive',
  );
  assert.throws(() => summarizeRepetitions([report(1, 10, 'sufficient')], 2));
});

await test('places the controlled overload stage above the highest passing stage', () => {
  assert.equal(overloadRate([4, 8, 16, 32], 16), 32);
  assert.equal(overloadRate([4, 8, 16, 32], 32), 48);
  assert.equal(overloadRate([4, 8, 16, 32], 0), 48);
});

await test('keeps one credential for every possible k6 VU', () => {
  assert.equal(hasOneUserPerVu(513, 513), true);
  assert.equal(hasOneUserPerVu(513, 512), false);
  assert.equal(hasOneUserPerVu(0, 512), false);
});

await test('requires both scheduled jobs to finish within the active load window', () => {
  assert.equal(
    contentionJobsFitLoadWindow(
      [{ durationMs: 20_000 }, { durationMs: 27_000 }],
      27_000,
    ),
    true,
  );
  assert.equal(
    contentionJobsFitLoadWindow(
      [{ durationMs: 20_000 }, { durationMs: 27_001 }],
      27_000,
    ),
    false,
  );
});

await test('detects a load-start marker split across stdout chunks', () => {
  const marker = 'BENCHMARK_LOAD_STARTED';
  const first = appendStreamingMarkerChunk(
    '',
    'prefix BENCHMARK_LOAD_',
    marker,
  );
  const second = appendStreamingMarkerChunk(
    first.tail,
    'STARTED suffix',
    marker,
  );

  assert.equal(first.found, false);
  assert.equal(second.found, true);
});

await test('maps the Task 1 provider fixture to the public API request shape', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        '../../../test/fixtures/ai-writing/grade-task1.request.json',
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
  assert.deepEqual(
    parseDockerImageIdentity(
      'postgres:16-alpine',
      'sha256:abc ["postgres@sha256:def"]',
    ),
    {
      reference: 'postgres:16-alpine',
      imageId: 'sha256:abc',
      repositoryDigests: ['postgres@sha256:def'],
    },
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

await test('does not wait for detached descendants to close timed-out pipes', async (t) => {
  if (process.platform === 'win32')
    return t.skip('requires POSIX process groups');

  const startedAt = Date.now();
  await assert.rejects(
    runProcess(
      process.execPath,
      [
        '-e',
        "const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { detached: true, stdio: ['ignore', 1, 2] }).unref(); setInterval(() => {}, 1000);",
      ],
      { timeout: 50, killProcessGroup: true, killSignal: 'SIGKILL' },
    ),
    /timed out after 50ms/,
  );
  assert.ok(
    Date.now() - startedAt < 750,
    'timeout must not wait for inherited pipes',
  );
});
