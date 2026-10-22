import { randomUUID } from 'node:crypto';

import type { CallHandler } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { from, lastValueFrom } from 'rxjs';

import {
  QUERY_TIMEOUT_MARGIN_MS,
  REQUEST_POSTGRES_TIMEOUTS,
} from '@/common/postgres/postgres-pool';
import { RedisConcurrencyLimiter } from '@/modules/gateway/infrastructure/redis-concurrency-limiter';
import {
  type RedisGatewayClient,
  createRedisGatewayClient,
} from '@/modules/gateway/infrastructure/redis-gateway.client';
import { ConcurrencyPermitInterceptor } from '@/modules/gateway/presentation/concurrency-permit.interceptor';
import { PostgresUsageRepository } from '@/modules/metering/infrastructure/postgres-usage.repository';
import {
  type PrismaClientHolder,
  createPrismaClient,
} from '@/modules/persistence/persistence.module';

import { createTestPool } from '../../shared/database';
import {
  ORGANIZATION_A,
  type TenantIsolationFixture,
  createTenantIsolationRedis,
} from '../fixtures';

import {
  inflight,
  postgresThroughProxy,
  redisAnswers,
  redisTarget,
  resetAndSeedTenants,
  timed,
} from './fault-targets';
import type { TcpFaultProxy } from './tcp-fault-proxy';

// Scenario 4 of #328 (2026-10-09): Postgres slows down while gradings hold
// their Organization permits. The usage write is awaited on the response
// path and the permit is released only after it, so slow writes must stretch
// each hold without exhausting the permits of requests that would be served.
const MAX_CONCURRENT = 4;
const SLOW_MS = 150;
const STALLED_BOUND_MS =
  REQUEST_POSTGRES_TIMEOUTS.statement_timeout + QUERY_TIMEOUT_MARGIN_MS + 1_500;
const NOOP_LOGGER = { warn: () => undefined, log: () => undefined };

let pool: ReturnType<typeof createTestPool>;
let raw: ReturnType<typeof createTenantIsolationRedis>;
let gatewayRedis: RedisGatewayClient;
let interceptor: ConcurrencyPermitInterceptor;
let proxy: TcpFaultProxy;
let holder: PrismaClientHolder;
let usage: PostgresUsageRepository;
let fixture: TenantIsolationFixture;

/** A graded request whose response waits for its usage write, under a permit. */
function gradedWithUsage(organizationId: string): Promise<unknown> {
  const requestId = `req_${randomUUID()}`;
  const request = {
    id: requestId,
    aihubAuth: {
      organizationId,
      apiKeyId: fixture.organizationA.apiKey.id,
      environment: 'production',
      maxConcurrent: MAX_CONCURRENT,
    },
  };
  const next: CallHandler = {
    handle: () =>
      from(
        usage.insert({
          requestId,
          organizationId,
          apiKeyId: fixture.organizationA.apiKey.id,
          service: 'writing',
          operation: 'writing.task2.grade',
          environment: 'production',
          outcome: 'success',
          httpStatus: 200,
          billableRequests: 1,
          meteringStatus: 'complete',
          totalMs: 1,
          billingBasis: 'response',
        }),
      ),
  };
  return interceptor
    .intercept(new ExecutionContextHost([request]), next)
    .then((observable) => lastValueFrom(observable));
}

/** Clients that each keep one request in flight, so at most MAX_CONCURRENT. */
async function steadyClients(rounds: number) {
  const outcomes: { readonly code: string; readonly ms: number }[] = [];
  await Promise.all(
    Array.from({ length: MAX_CONCURRENT }, async () => {
      for (let round = 0; round < rounds; round += 1) {
        const call = await timed(() => gradedWithUsage(ORGANIZATION_A));
        outcomes.push({
          code:
            call.result.status === 'fulfilled'
              ? 'OK'
              : String((call.result.reason as { code?: unknown }).code),
          ms: call.ms,
        });
      }
    }),
  );
  return outcomes;
}

beforeAll(async () => {
  pool = createTestPool();
  raw = createTenantIsolationRedis();
  const target = redisTarget();
  const client = createRedisGatewayClient(
    `redis://${target.host}:${target.port}${target.database}`,
  );
  if (client === undefined) throw new Error('Gateway Redis client missing');
  gatewayRedis = client;
  await redisAnswers(client);
  interceptor = new ConcurrencyPermitInterceptor(
    new RedisConcurrencyLimiter(gatewayRedis, NOOP_LOGGER),
  );
});

beforeEach(async () => {
  fixture = await resetAndSeedTenants(pool, raw);
  const slow = await postgresThroughProxy(SLOW_MS);
  proxy = slow.proxy;
  holder = createPrismaClient('integration-test', slow.url);
  usage = new PostgresUsageRepository(holder.prisma);
  // Open one pooled connection per client before the link slows, as a
  // running service would have.
  await steadyClients(1);
});

afterEach(async () => {
  await proxy.setMode('normal');
  await holder.close();
  await proxy.close();
});

afterAll(async () => {
  await gatewayRedis.quit();
  await raw.quit();
  await pool.end();
});

describe('Postgres slow while gradings hold permits', () => {
  it('stretches each hold by the slow usage write without refusing requests that fit the permits', async () => {
    await proxy.setMode('slow');
    const outcomes = await steadyClients(3);

    expect(new Set(outcomes.map(({ code }) => code))).toEqual(new Set(['OK']));
    // Each answer waited for its usage write over the slow link, and no more
    // than the client-side query bound.
    expect(Math.min(...outcomes.map(({ ms }) => ms))).toBeGreaterThanOrEqual(
      SLOW_MS,
    );
    expect(Math.max(...outcomes.map(({ ms }) => ms))).toBeLessThan(
      STALLED_BOUND_MS,
    );
    expect(await inflight(raw, ORGANIZATION_A)).toBe(0);
  }, 60_000);

  it('releases every permit when the usage write gives up on a stalled Postgres', async () => {
    await proxy.setMode('hang');
    const stalled = await steadyClients(1);

    expect(new Set(stalled.map(({ code }) => code)).has('OK')).toBe(false);
    expect(Math.max(...stalled.map(({ ms }) => ms))).toBeLessThan(
      STALLED_BOUND_MS,
    );
    expect(await inflight(raw, ORGANIZATION_A)).toBe(0);

    // The permits are free again, so requests that fit them are served.
    await proxy.setMode('normal');
    const recovered = await steadyClients(1);
    expect(new Set(recovered.map(({ code }) => code))).toEqual(new Set(['OK']));
  }, 60_000);
});
