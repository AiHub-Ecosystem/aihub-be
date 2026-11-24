import { randomUUID } from 'node:crypto';

import type Redis from 'ioredis';

import type { OperationId } from '@/catalog/operation-id';
import type { RequestContext } from '@/common/request-context/request-context';
import type {
  DispatchResult,
  OperationDispatcherPort,
  RequestFor,
  ResponseFor,
} from '@/modules/gateway/application/dispatch/operation-dispatcher.port';
import { GradedPipelineEngine } from '@/modules/gateway/application/graded-request/graded-pipeline-engine';
import { type GradedPipelineContext } from '@/modules/gateway/application/graded-request/graded-pipeline.port';
import { GradingOrchestrator } from '@/modules/gateway/application/graded-request/grading-orchestrator';
import { rateLimitWindow } from '@/modules/gateway/application/rate-limit-window';
import {
  LEASE_REMOVAL_RETRY_MS,
  RedisConcurrencyLimiter,
} from '@/modules/gateway/infrastructure/redis-concurrency-limiter';
import {
  type RedisGatewayClient,
  createRedisGatewayClient,
} from '@/modules/gateway/infrastructure/redis-gateway.client';
import { RedisGradedAdmission } from '@/modules/gateway/infrastructure/redis-graded-admission';
import {
  RedisRateLimiter,
  rateLimitKey,
} from '@/modules/gateway/infrastructure/redis-rate-limiter';
import type {
  IdempotencyExecution,
  IdempotencyExecutionInput,
  IdempotencyServicePort,
  IdempotencyWork,
} from '@/modules/idempotency/application/idempotency-service.port';
import { createRedisMeteringClient } from '@/modules/metering/infrastructure/quota/redis-metering.client';
import { RedisQuotaCounter } from '@/modules/metering/infrastructure/quota/redis-quota-counter';
import { RedisQuotaSeeder } from '@/modules/metering/infrastructure/quota/redis-quota-seed';
import { quotaKeyForMonth } from '@/modules/metering/public/quota-counter';

import { createTenantIsolationRedis } from '../fixtures';

import {
  eventually,
  inflight,
  redisAnswers,
  redisThroughProxy,
  redisUnavailableCount,
  rejection,
  sandboxInflight,
  timed,
} from './fault-targets';
import type { FaultMode, TcpFaultProxy } from './tcp-fault-proxy';

// The gateway client's commandTimeout is 200 ms; a refusal must not wait out
// a reconnect or a stalled reply much longer than that.
const FAIL_FAST_BOUND_MS = 1_000;

const NOOP_LOGGER = { warn: () => undefined, log: () => undefined };

const REDIS_UNAVAILABLE = {
  code: 'REDIS_UNAVAILABLE',
  httpStatus: 503,
  retryable: true,
  // The hint is spread over [1 s, 2 s) (#1352).
  retryAfterMs: expect.closeTo(1_499.5, -3) as unknown,
};

let proxy: TcpFaultProxy;
let client: RedisGatewayClient;
let meteringClient: ReturnType<typeof createRedisMeteringClient>;
let raw: Redis;

function organizationId(): string {
  return `org_redis_fault_${randomUUID().replaceAll('-', '')}`;
}

function gradedRequest(organization: string) {
  return {
    apiKeyId: `ak_${organization}`,
    rateLimitRpm: 600,
    organizationId: organization,
    requestId: `req_${randomUUID()}`,
    operation: 'writing.task2.grade' as const,
    monthlyRequestQuota: 1_000,
    hardStopOnQuota: false,
  };
}

function concurrencyRequest(
  organization: string,
  environment: 'production' | 'sandbox' = 'production',
) {
  return {
    organizationId: organization,
    maxConcurrent: 2,
    requestId: `req_${randomUUID()}`,
    environment,
  };
}

async function runOrganizationGradedRequest(
  organization: string,
  environment: 'production' | 'sandbox',
  limiter: RedisConcurrencyLimiter,
): Promise<boolean> {
  const operation = 'writing.task1.grade' as const;
  const requestId = `req_${randomUUID()}`;
  const signal = new AbortController().signal;
  const dispatchReached = new Error('dispatch reached');
  let admitted = false;
  const context: GradedPipelineContext<typeof operation> = {
    requestId,
    receivedAt: new Date(),
    signal,
    dispose: () => undefined,
    operation,
    authenticated: {
      organizationId: organization,
      apiKeyId: `ak_${organization}`,
      environment,
      scopes: ['writing.grade'],
      rateLimitRpm: 600,
      maxConcurrent: 2,
      monthlyRequestQuota: 1_000,
      hardStopOnQuota: false,
      allowedEnvironments: ['production', 'sandbox'],
    },
    identity: {
      userId: 'user_acme',
      organizationId: organization,
      scopes: [],
      mode: 'declared_id',
    },
    idempotencyKey: `key-${randomUUID()}`,
    metering: {
      evidence: {
        operation,
        organizationId: organization,
        apiKeyId: `ak_${organization}`,
        environment,
        settled: false,
      },
      setDimensions: () => undefined,
      addEvidence: () => undefined,
      markCompletionStarted: () => undefined,
      markCompletionSettled: () => undefined,
    },
    markAdmission: () => {
      admitted = true;
    },
    prepareInput: async () => ({
      input: {
        question: 'Describe the chart.',
        chart_type: 'Line Graph',
        essay: 'A clear response.',
        image_url: 'https://example.com/chart.png',
      },
    }),
  };
  const dispatcher: OperationDispatcherPort = {
    async dispatch<O extends OperationId>(
      _operation: O,
      _input: RequestFor<O>,
      _context: RequestContext,
    ): Promise<DispatchResult<ResponseFor<O>>> {
      throw dispatchReached;
    },
  };
  const idempotency: IdempotencyServicePort = {
    async execute<T>(
      input: IdempotencyExecutionInput,
      work: IdempotencyWork<T>,
    ): Promise<IdempotencyExecution<T>> {
      return { result: await work(input), replay: false };
    },
  };
  const engine = new GradedPipelineEngine(
    new GradingOrchestrator(dispatcher, idempotency),
    { finalize: async () => undefined },
    new RedisGradedAdmission(
      client,
      () => Date.now(),
      Math.random,
      NOOP_LOGGER,
      new RedisQuotaSeeder(client, { billableCount: async () => 0 }),
    ),
    limiter,
    idempotency,
    { count: async () => 0 },
  );

  try {
    await engine.execute(context);
  } catch (error) {
    if (error === dispatchReached) return admitted;
    throw error;
  }
  return false;
}

beforeAll(async () => {
  const target = await redisThroughProxy();
  proxy = target.proxy;
  const proxied = createRedisGatewayClient(target.url);
  if (proxied === undefined) throw new Error('Gateway Redis client missing');
  client = proxied;
  meteringClient = createRedisMeteringClient(target.url);
  raw = createTenantIsolationRedis();
});

afterEach(async () => {
  await proxy.setMode('normal');
  await redisAnswers(client);
});

afterAll(async () => {
  await client.quit().catch(() => undefined);
  await meteringClient?.quit().catch(() => undefined);
  await raw.quit();
  await proxy.close();
});

describe.each<FaultMode>(['refuse', 'hang', 'slow'])(
  'gateway Redis seams while Redis is %s',
  (mode) => {
    it('refuses graded admission with a retryable 503 inside the bound, then admits again', async () => {
      const admission = new RedisGradedAdmission(
        client,
        () => Date.now(),
        Math.random,
        NOOP_LOGGER,
        new RedisQuotaSeeder(client, { billableCount: async () => 0 }),
      );
      const organization = organizationId();
      await redisAnswers(client);
      const before = await redisUnavailableCount('graded_admission');

      await proxy.setMode(mode);
      const outage = await timed(() =>
        admission.consume(gradedRequest(organization)),
      );

      expect(rejection(outage.result)).toMatchObject(REDIS_UNAVAILABLE);
      expect(outage.ms).toBeLessThan(FAIL_FAST_BOUND_MS);
      expect(await redisUnavailableCount('graded_admission')).toBeGreaterThan(
        before,
      );

      await proxy.setMode('normal');
      await redisAnswers(client);
      await expect(
        admission.consume(gradedRequest(organization)),
      ).resolves.toMatchObject({ stage: 'admitted' });
    });

    it.each(['production', 'sandbox'] as const)(
      'admits a %s Organization request after concurrent outage attempts leave no leases',
      async (environment) => {
        const limiter = new RedisConcurrencyLimiter(client, NOOP_LOGGER);
        const organization = organizationId();
        await redisAnswers(client);
        const before = await redisUnavailableCount('concurrency');

        await proxy.setMode(mode);
        const outages = await Promise.all(
          Array.from({ length: 3 }, () =>
            timed(() =>
              limiter.acquire(concurrencyRequest(organization, environment)),
            ),
          ),
        );

        for (const outage of outages) {
          expect(rejection(outage.result)).toMatchObject(REDIS_UNAVAILABLE);
          expect(outage.ms).toBeLessThan(FAIL_FAST_BOUND_MS);
        }
        expect(await redisUnavailableCount('concurrency')).toBeGreaterThan(
          before,
        );

        // A slow or held acquire reaches Redis after the timeout and adds the
        // lease; only the limiter's background removal takes it out again.
        await proxy.setMode('normal');
        await redisAnswers(client);
        await eventually(
          async () =>
            (await inflight(raw, organization)) === 0 &&
            (environment !== 'sandbox' || (await sandboxInflight(raw)) === 0),
          LEASE_REMOVAL_RETRY_MS * 3,
        );

        await expect(
          runOrganizationGradedRequest(organization, environment, limiter),
        ).resolves.toBe(true);
        expect(await inflight(raw, organization)).toBe(0);
        expect(await sandboxInflight(raw)).toBe(0);
      },
    );

    it('fails closed for non-graded rate limits, then admits after recovery', async () => {
      const now = 61_234;
      const limiter = new RedisRateLimiter('', client, () => now, NOOP_LOGGER);
      const keyId = `ak_${randomUUID()}`;
      await redisAnswers(client);
      const before = await redisUnavailableCount('rate_limit');

      await proxy.setMode(mode);
      const outage = await timed(() => limiter.consume({ keyId, limit: 2 }));

      expect(rejection(outage.result)).toMatchObject(REDIS_UNAVAILABLE);
      expect(outage.ms).toBeLessThan(FAIL_FAST_BOUND_MS);
      expect(await redisUnavailableCount('rate_limit')).toBeGreaterThan(before);

      await proxy.setMode('normal');
      await redisAnswers(client);
      await expect(limiter.consume({ keyId, limit: 2 })).resolves.toMatchObject(
        {
          allowed: true,
        },
      );
    });
  },
);

// Only a refused connection loses the release: a slow or held ZREM still
// reaches Redis once the link recovers, so it would pass without the fix.
it('frees a permit after Redis returns beyond the bounded retry attempts', async () => {
  const limiter = new RedisConcurrencyLimiter(client, NOOP_LOGGER);
  const organization = organizationId();
  await redisAnswers(client);
  const decision = await limiter.acquire({
    ...concurrencyRequest(organization),
    maxConcurrent: 1,
  });
  if (!decision.allowed) throw new Error('lease was not granted');
  expect(await inflight(raw, organization)).toBe(1);
  const failuresBefore = await redisUnavailableCount('concurrency');

  await proxy.setMode('refuse');
  const release = await timed(() => decision.lease.release());

  expect(rejection(release.result)).toMatchObject(REDIS_UNAVAILABLE);
  expect(release.ms).toBeLessThan(FAIL_FAST_BOUND_MS);
  expect(await inflight(raw, organization)).toBe(1);

  // One initial release failure plus six failed retries proves that cleanup
  // continues past the previous five-attempt limit.
  await eventually(
    async () =>
      (await redisUnavailableCount('concurrency')) > failuresBefore + 6,
    LEASE_REMOVAL_RETRY_MS * 12,
  );

  await proxy.setMode('normal');
  await redisAnswers(client);
  await eventually(
    async () => (await inflight(raw, organization)) === 0,
    LEASE_REMOVAL_RETRY_MS * 3,
  );

  const recovered = await limiter.acquire({
    ...concurrencyRequest(organization),
    maxConcurrent: 1,
  });
  expect(recovered.allowed).toBe(true);
  if (recovered.allowed) await recovered.lease.release();
  expect(await inflight(raw, organization)).toBe(0);
}, 20_000);

it('does not replay a rate-limit mutation when reconnect follows a lost reply', async () => {
  const now = 61_234;
  const keyId = `ak_${randomUUID()}`;
  const key = rateLimitKey(keyId, rateLimitWindow(keyId, now).index);
  const limiter = new RedisRateLimiter('', client, () => now, NOOP_LOGGER);
  await raw.del(key);

  await proxy.setMode('slow');
  const pending = timed(() => limiter.consume({ keyId, limit: 1 }));
  await eventually(async () => (await raw.get(key)) === '1');
  await proxy.setMode('refuse');

  const result = await pending;
  expect(rejection(result.result)).toMatchObject(REDIS_UNAVAILABLE);

  await proxy.setMode('normal');
  await eventually(async () => (await client.get(key)) === '1');

  expect(await raw.get(key)).toBe('1');
  await expect(limiter.consume({ keyId, limit: 1 })).resolves.toMatchObject({
    allowed: false,
  });
}, 10_000);

it('does not replay a quota increment when reconnect follows a lost reply', async () => {
  const redis = meteringClient;
  if (redis === undefined) throw new Error('Metering Redis missing');
  const organization = organizationId();
  const now = new Date();
  const key = quotaKeyForMonth(organization, now.toISOString().slice(0, 7));
  const counter = new RedisQuotaCounter(redis);
  await raw.set(key, '0');

  await proxy.setMode('slow');
  const pending = timed(() =>
    counter.increment({ organizationId: organization, occurredAt: now }),
  );
  await eventually(async () => (await raw.get(key)) === '1');
  await proxy.setMode('refuse');

  const result = await pending;
  expect(result.result.status).toBe('rejected');

  await proxy.setMode('normal');
  await eventually(async () => (await redis.get(key)) === '1');

  expect(await raw.get(key)).toBe('1');
}, 10_000);
