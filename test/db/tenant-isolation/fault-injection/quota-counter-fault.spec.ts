import { randomUUID } from 'node:crypto';

import { MeteringService } from '@/modules/metering/application/usage-recording/metering.service';
import { createRedisMeteringClient } from '@/modules/metering/infrastructure/quota/redis-metering.client';
import { RedisQuotaCounter } from '@/modules/metering/infrastructure/quota/redis-quota-counter';
import { PostgresUsageRepository } from '@/modules/metering/infrastructure/usage-recording/postgres-usage.repository';
import {
  quotaKeyForMonth,
  quotaPeriod,
} from '@/modules/metering/public/quota-counter';
import {
  type PrismaClientHolder,
  createPrismaClient,
} from '@/modules/persistence/persistence.module';

import { createTestPool, testDatabaseUrl } from '../../shared/database';
import {
  ORGANIZATION_A,
  type TenantIsolationFixture,
  createTenantIsolationRedis,
} from '../fixtures';

import {
  eventually,
  redisThroughProxy,
  redisUnavailableCount,
  resetAndSeedTenants,
  timed,
} from './fault-targets';
import type { FaultMode, TcpFaultProxy } from './tcp-fault-proxy';

// The post-result quota increment row of the #2019 matrix: the client keeps
// its result, the durable usage record lands, and the record says the quota
// counter missed it.
// The metering Redis client's command timeout is 500 ms.
const INCREMENT_BOUND_MS = 1_500;
const NOOP_LOGGER = { warn: () => undefined, log: () => undefined };

let pool: ReturnType<typeof createTestPool>;
let raw: ReturnType<typeof createTenantIsolationRedis>;
let holder: PrismaClientHolder;
let proxy: TcpFaultProxy;
let counter: RedisQuotaCounter;
let metering: MeteringService;
let fixture: TenantIsolationFixture;

function quotaKey(): string {
  return quotaKeyForMonth(ORGANIZATION_A, quotaPeriod(new Date()).key);
}

/** One successful, quota-tracked grading, finalized as the route does. */
async function finalizeSuccess(): Promise<string> {
  const requestId = `req_${randomUUID()}`;
  await metering.finalize({
    requestId,
    organizationId: ORGANIZATION_A,
    apiKeyId: fixture.organizationA.apiKey.id,
    operation: 'writing.task2.grade',
    environment: 'production',
    outcome: 'success',
    httpStatus: 200,
    totalMs: 5,
    quotaTracked: true,
    modelCalled: true,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  });
  return requestId;
}

/**
 * The status the usage record landed with. finalize stops waiting on the
 * insert after METERING_WRITE_TIMEOUT_MS (100 ms) while the insert still
 * lands, so this waits for the row.
 */
async function meteringStatus(requestId: string): Promise<string> {
  let status: string | undefined;
  await eventually(async () => {
    const { rows } = await pool.query<{ metering_status: string }>(
      'SELECT metering_status FROM usage_records WHERE request_id = $1',
      [requestId],
    );
    status = rows[0]?.metering_status;
    return status !== undefined;
  }, 10_000);
  return status ?? '';
}

beforeAll(async () => {
  pool = createTestPool();
  raw = createTenantIsolationRedis();
  holder = createPrismaClient('integration-test', testDatabaseUrl());
  const target = await redisThroughProxy();
  proxy = target.proxy;
  counter = new RedisQuotaCounter(
    createRedisMeteringClient(target.url),
    () => new Date(),
    NOOP_LOGGER,
  );
  metering = new MeteringService(
    new PostgresUsageRepository(holder.prisma),
    undefined,
    counter,
  );
});

beforeEach(async () => {
  fixture = await resetAndSeedTenants(pool, raw);
  await raw.set(quotaKey(), '3');
});

afterEach(async () => {
  await proxy.setMode('normal');
});

afterAll(async () => {
  await counter.onModuleDestroy();
  await proxy.close();
  await holder.close();
  await raw.quit();
  await pool.end();
});

describe('post-result quota increment while Redis is down', () => {
  it.each<FaultMode>(['refuse', 'hang'])(
    'keeps the result and its usage record, marks it quota_unverified, and counts the seam when Redis is %s',
    async (mode) => {
      // A connected client, so the failure comes from the fault.
      await eventually(
        async () =>
          (await meteringStatus(await finalizeSuccess())) === 'complete',
      );
      expect(await raw.get(quotaKey())).toBe('4');
      const before = await redisUnavailableCount('quota');

      await proxy.setMode(mode);
      const call = await timed(finalizeSuccess);

      // finalize never throws, so the client's graded result stands.
      expect(call.result.status).toBe('fulfilled');
      expect(call.ms).toBeLessThan(INCREMENT_BOUND_MS);
      const requestId =
        call.result.status === 'fulfilled' ? call.result.value : '';
      expect(await meteringStatus(requestId)).toBe('quota_unverified');
      expect(await redisUnavailableCount('quota')).toBeGreaterThan(before);
      // The counter missed this request; it is never read as zero usage.
      await proxy.setMode('normal');
      expect(await raw.get(quotaKey())).toBe('4');
    },
  );

  it('counts again once Redis returns', async () => {
    await proxy.setMode('refuse');
    expect(await meteringStatus(await finalizeSuccess())).toBe(
      'quota_unverified',
    );

    await proxy.setMode('normal');
    await eventually(
      async () =>
        (await meteringStatus(await finalizeSuccess())) === 'complete',
    );
    expect(Number(await raw.get(quotaKey()))).toBeGreaterThan(3);
  });
});
