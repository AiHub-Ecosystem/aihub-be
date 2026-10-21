import { randomUUID } from 'node:crypto';

import type Redis from 'ioredis';

import { admitMonthlyQuota } from '@/modules/gateway/application/quota-admission';
import {
  LEASE_REMOVAL_RETRY_MS,
  RedisConcurrencyLimiter,
} from '@/modules/gateway/infrastructure/redis-concurrency-limiter';
import {
  type RedisGatewayClient,
  createRedisGatewayClient,
} from '@/modules/gateway/infrastructure/redis-gateway.client';
import { RedisGradedAdmission } from '@/modules/gateway/infrastructure/redis-graded-admission';
import { RedisQuotaCounter } from '@/modules/gateway/infrastructure/redis-quota-counter';
import { RedisQuotaSeeder } from '@/modules/gateway/infrastructure/redis-quota-seed';
import { RedisRateLimiter } from '@/modules/gateway/infrastructure/redis-rate-limiter';

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
  retryAfterMs: 1_000,
};

let proxy: TcpFaultProxy;
let client: RedisGatewayClient;
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

beforeAll(async () => {
  const target = await redisThroughProxy();
  proxy = target.proxy;
  const proxied = createRedisGatewayClient(target.url);
  if (proxied === undefined) throw new Error('Gateway Redis client missing');
  client = proxied;
  raw = createTenantIsolationRedis();
});

afterEach(async () => {
  await proxy.setMode('normal');
  await redisAnswers(client);
});

afterAll(async () => {
  await client.quit().catch(() => undefined);
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
      ).resolves.toEqual({ stage: 'admitted' });
    });

    it.each(['production', 'sandbox'] as const)(
      'refuses a %s concurrency permit without admitting locally and leaks no lease',
      async (environment) => {
        const limiter = new RedisConcurrencyLimiter(client, NOOP_LOGGER);
        const organization = organizationId();
        await redisAnswers(client);
        const before = await redisUnavailableCount('concurrency');

        await proxy.setMode(mode);
        const outage = await timed(() =>
          limiter.acquire(concurrencyRequest(organization, environment)),
        );

        expect(rejection(outage.result)).toMatchObject(REDIS_UNAVAILABLE);
        expect(outage.ms).toBeLessThan(FAIL_FAST_BOUND_MS);
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

        const recovered = await limiter.acquire(
          concurrencyRequest(organization, environment),
        );
        expect(recovered.allowed).toBe(true);
        if (recovered.allowed) await recovered.lease.release();
        expect(await inflight(raw, organization)).toBe(0);
        expect(await sandboxInflight(raw)).toBe(0);
      },
    );

    it('keeps the non-graded rate limit at a process-local ceiling', async () => {
      const limiter = new RedisRateLimiter(
        '',
        client,
        () => Date.now(),
        NOOP_LOGGER,
      );
      const keyId = `ak_${randomUUID()}`;
      await redisAnswers(client);
      const before = await redisUnavailableCount('rate_limit');

      await proxy.setMode(mode);
      const decisions = [];
      for (let index = 0; index < 3; index += 1) {
        const call = await timed(() => limiter.consume({ keyId, limit: 2 }));
        expect(call.ms).toBeLessThan(FAIL_FAST_BOUND_MS);
        if (call.result.status !== 'fulfilled') throw call.result.reason;
        decisions.push(call.result.value.allowed);
      }

      expect(decisions).toEqual([true, true, false]);
      expect(await redisUnavailableCount('rate_limit')).toBeGreaterThan(before);
    });

    it('admits an unverified quota, or refuses a hard-stop quota, when the counter cannot be read', async () => {
      const counter = new RedisQuotaCounter(
        client,
        () => new Date(),
        NOOP_LOGGER,
      );
      await redisAnswers(client);
      const before = await redisUnavailableCount('quota');

      await proxy.setMode(mode);
      const open = await timed(() =>
        admitMonthlyQuota(
          counter,
          {
            organizationId: organizationId(),
            quota: 10,
            hardStopOnQuota: false,
          },
          () => new Date(),
        ),
      );
      const hardStop = await timed(() =>
        admitMonthlyQuota(
          counter,
          {
            organizationId: organizationId(),
            quota: 10,
            hardStopOnQuota: true,
          },
          () => new Date(),
        ),
      );

      expect(open.result).toEqual({ status: 'fulfilled', value: 'unverified' });
      // Not a quota refusal with next month's hint (#373).
      expect(rejection(hardStop.result)).toMatchObject(REDIS_UNAVAILABLE);
      expect(Math.max(open.ms, hardStop.ms)).toBeLessThan(FAIL_FAST_BOUND_MS);
      expect(await redisUnavailableCount('quota')).toBeGreaterThan(before);
    });
  },
);

// Only a refused connection loses the release: a slow or held ZREM still
// reaches Redis once the link recovers, so it would pass without the fix.
it('frees a permit whose release was lost to a refused connection once Redis returns', async () => {
  const limiter = new RedisConcurrencyLimiter(client, NOOP_LOGGER);
  const organization = organizationId();
  await redisAnswers(client);
  const decision = await limiter.acquire(concurrencyRequest(organization));
  if (!decision.allowed) throw new Error('lease was not granted');
  expect(await inflight(raw, organization)).toBe(1);

  await proxy.setMode('refuse');
  const release = await timed(() => decision.lease.release());

  expect(rejection(release.result)).toMatchObject(REDIS_UNAVAILABLE);
  expect(release.ms).toBeLessThan(FAIL_FAST_BOUND_MS);
  expect(await inflight(raw, organization)).toBe(1);

  await proxy.setMode('normal');
  await redisAnswers(client);
  await eventually(
    async () => (await inflight(raw, organization)) === 0,
    LEASE_REMOVAL_RETRY_MS * 3,
  );
});
