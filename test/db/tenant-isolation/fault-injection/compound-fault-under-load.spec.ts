import { readFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { join } from 'node:path';

import { ulid } from 'ulid';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { METRICS_ROUTE_PATH } from '@/common/observability/metrics/metrics';
import { SHEDDING_POLICY } from '@/modules/gateway/application/shedding/shedding-policy';
import { GRADIENT2_DEFAULT_CONFIG } from '@/modules/gateway/infrastructure/dispatch/gradient2-concurrency-limiter';

import {
  type GradingOrganization,
  type HttpAnswer,
  type TestWorker,
  WRITING_TASK1_PATH,
  deleteGradingOrganization,
  listen,
  seedGradingOrganization,
  sendRequest,
  startWorker,
} from '../../dispatch/app-worker';
import { createTestPool } from '../../shared/database';
import { createTenantIsolationRedis } from '../fixtures';

import type { TcpFaultProxy } from '../../../support/tcp-fault-proxy';
import { eventually, postgresThroughProxy, redisTarget } from './fault-targets';

// The compound case of #2019: the AI Service hangs and PostgreSQL is slow
// while one Organization sends far more gradings than its permits allow.
const LOAD = 120;
const MAX_CONCURRENT = 20;
const GRADING_TIMEOUT_MS = OPERATION_CATALOG['writing.task1.grade'].timeoutMs;
// Every caller hears back by the operation deadline plus time to unwind.
const ANSWER_BOUND_MS = GRADING_TIMEOUT_MS + 5_000;
// ponytail: provisional heap ceiling for this load; #398 owns capacity sizing
// and replaces it with a measured per-process budget.
const HEAP_GROWTH_BOUND_BYTES = 200 * 1024 * 1024;
// Saturating the AI origin raises shedding to level 2, which refuses every
// grading (best-effort). Once the slots free, each level comes down after
// `recoverAfterMs` below the recovery share, and a published level outlives
// that by up to 15 s in Redis (SHARED_LEVEL_TTL_SECONDS).
const RECOVERY_BOUND_MS = 2 * SHEDDING_POLICY.recoverAfterMs + 15_000 + 10_000;
const RECOVERY_REFUSALS = ['SERVICE_OVERLOADED', 'AI_SERVICE_UNAVAILABLE'];
const SLOW_POSTGRES_MS = 50;
const GRADE_RESPONSE = readFileSync(
  join(process.cwd(), 'test/fixtures/ai-writing/grade-task1.response.json'),
);

interface Answer {
  readonly status: number;
  readonly code: string | undefined;
  readonly retryable: boolean | undefined;
  readonly ms: number;
}

function parse(answer: HttpAnswer | undefined, ms: number): Answer {
  if (answer === undefined) {
    return { status: 0, code: 'connection_broken', retryable: undefined, ms };
  }
  if (answer.status < 400) {
    return { status: answer.status, code: undefined, retryable: undefined, ms };
  }
  const error = (
    JSON.parse(answer.body) as {
      error?: { code?: string; retryable?: boolean };
    }
  ).error;
  return {
    status: answer.status,
    code: error?.code,
    retryable: error?.retryable,
    ms,
  };
}

/** Sum of every sample of one metric in the worker's exposition. */
async function metricSum(worker: TestWorker, name: string): Promise<number> {
  const text = await (await fetch(`${worker.url}${METRICS_ROUTE_PATH}`)).text();
  return text
    .split('\n')
    .filter(
      (line) => line.startsWith(`${name} `) || line.startsWith(`${name}{`),
    )
    .reduce(
      (sum, line) => sum + Number(line.slice(line.lastIndexOf(' ') + 1)),
      0,
    );
}

describe('compound dependency fault under load in one app process', () => {
  const pool = createTestPool();
  const raw = createTenantIsolationRedis();
  let postgres: TcpFaultProxy;
  let provider: Server;
  let providerHangs = true;
  let providerInFlight = 0;
  let providerPeakInFlight = 0;
  let organization: GradingOrganization | undefined;
  let worker: TestWorker | undefined;

  beforeAll(async () => {
    const target = await postgresThroughProxy(SLOW_POSTGRES_MS);
    postgres = target.proxy;
    provider = createServer((request, response) => {
      providerInFlight += 1;
      providerPeakInFlight = Math.max(providerPeakInFlight, providerInFlight);
      response.on('close', () => {
        providerInFlight -= 1;
      });
      request.resume();
      request.once('end', () => {
        if (providerHangs) return;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(GRADE_RESPONSE);
      });
    });
    const redis = redisTarget();
    worker = await startWorker({
      downstreamUrl: await listen(provider),
      databaseUrl: target.url,
      redisUrl: `redis://${redis.host}:${redis.port}${redis.database}`,
    });
    organization = await seedGradingOrganization(pool, {
      label: 'compound_fault',
      maxConcurrent: MAX_CONCURRENT,
      monthlyQuota: 10_000,
      hardStop: false,
    });
  }, 150_000);

  afterAll(async () => {
    await worker?.stop();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await postgres.close();
    if (organization !== undefined) {
      await raw.del(`aihub:v1:inflight:${organization.organizationId}`);
      await deleteGradingOrganization(pool, organization.organizationId);
    }
    raw.disconnect();
    await pool.end();
  });

  async function grade(app: TestWorker, tenant: GradingOrganization) {
    const startedAt = performance.now();
    const answer = await sendRequest(app.url, {
      path: WRITING_TASK1_PATH,
      headers: {
        'x-api-key': tenant.apiKey.raw,
        'x-user-identity': await tenant.signAssertion(),
        'idempotency-key': `compound-${ulid()}`,
      },
      body: {
        question: 'Describe the chart.',
        chart_type: 'Bar Chart',
        essay: 'A clear essay about the chart.',
        image_url: 'https://example.com/chart.png',
      },
    });
    return parse(answer, performance.now() - startedAt);
  }

  it('answers every caller retryably inside the deadline with bounded queues and heap, and recovers without a restart', async () => {
    const app = worker as TestWorker;
    const tenant = organization as GradingOrganization;
    const pid = app.child.pid;
    const heapBefore = await metricSum(app, 'aihub_process_heap_used_bytes');

    providerHangs = true;
    await postgres.setMode('slow');
    let peakHeap = heapBefore;
    let peakDownstreamQueued = 0;
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        peakHeap = Math.max(
          peakHeap,
          await metricSum(app, 'aihub_process_heap_used_bytes'),
        );
        peakDownstreamQueued = Math.max(
          peakDownstreamQueued,
          await metricSum(app, 'aihub_downstream_pool_queued'),
        );
        // real-timer-ok: the fault-injection lane samples a real app process under load
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    })();
    const answers = await Promise.all(
      Array.from({ length: LOAD }, () => grade(app, tenant)),
    );
    sampling = false;
    await sampler;

    // Every caller gets an HTTP answer inside the deadline, and every refusal
    // tells it to retry: nothing waits in an unbounded queue.
    expect(answers.filter(({ status }) => status === 0)).toEqual([]);
    expect(Math.max(...answers.map(({ ms }) => ms))).toBeLessThan(
      ANSWER_BOUND_MS,
    );
    const failures = answers.filter(({ status }) => status >= 400);
    expect(failures).toHaveLength(LOAD);
    expect(failures.filter(({ retryable }) => retryable !== true)).toEqual([]);
    // The permits and the per-origin bulkhead cap what reaches the hung AI
    // Service, so its socket pool never queues.
    expect(providerPeakInFlight).toBeGreaterThan(0);
    expect(providerPeakInFlight).toBeLessThanOrEqual(
      Math.min(MAX_CONCURRENT, GRADIENT2_DEFAULT_CONFIG.maxLimit),
    );
    expect(peakDownstreamQueued).toBe(0);
    expect(peakHeap - heapBefore).toBeLessThan(HEAP_GROWTH_BOUND_BYTES);
    // No crash, OOM, or restart.
    expect(app.child.pid).toBe(pid);
    expect(app.child.exitCode).toBeNull();
    expect(app.child.signalCode).toBeNull();

    providerHangs = false;
    await postgres.setMode('normal');
    await eventually(
      async () => (await fetch(`${app.url}/ready`)).status === 200,
      10_000,
    );
    // A 504 caller's grading keeps running in the background up to the
    // idempotency hard deadline (twice the operation timeout, ADR-0098), so
    // its bulkhead slot frees one operation timeout after the answer.
    await eventually(
      async () => providerInFlight === 0,
      GRADING_TIMEOUT_MS + 10_000,
    );
    // Until shedding steps down and the breaker lets a probe through,
    // gradings are refused at once and retryably; then the same process
    // grades again.
    const refusedWhileRecovering: Answer[] = [];
    const recoveryStartedAt = performance.now();
    let recovered = await grade(app, tenant);
    while (
      recovered.status !== 200 &&
      performance.now() - recoveryStartedAt < RECOVERY_BOUND_MS
    ) {
      refusedWhileRecovering.push(recovered);
      // real-timer-ok: the fault-injection lane waits for shedding to step down
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      recovered = await grade(app, tenant);
    }
    // Status and code together, so a failure names the refusal it got.
    expect({ status: recovered.status, code: recovered.code }).toEqual({
      status: 200,
      code: undefined,
    });
    expect(
      refusedWhileRecovering.filter(
        ({ status, code, retryable }) =>
          status !== 503 ||
          !RECOVERY_REFUSALS.includes(code ?? '') ||
          retryable !== true,
      ),
    ).toEqual([]);
    expect(await raw.zcard(`aihub:v1:inflight:${tenant.organizationId}`)).toBe(
      0,
    );
    expect(app.child.pid).toBe(pid);
  }, 240_000);
});
