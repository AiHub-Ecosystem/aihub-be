import { randomUUID } from 'node:crypto';

import { MeteringService } from '@/modules/metering/application/usage-recording/metering.service';
import {
  type RedisMeteringClient,
  createRedisMeteringClient,
} from '@/modules/metering/infrastructure/quota/redis-metering.client';
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

import type {
  FaultMode,
  TcpFaultProxy,
} from '../../../support/tcp-fault-proxy';
import {
  eventually,
  redisThroughProxy,
  redisUnavailableCount,
  resetAndSeedTenants,
  timed,
} from './fault-targets';

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
let meteringClient: RedisMeteringClient;
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
  const client = createRedisMeteringClient(target.url);
  if (client === undefined) throw new Error('Metering Redis client missing');
  meteringClient = client;
  counter = new RedisQuotaCounter(client, () => new Date(), NOOP_LOGGER);
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
      // While the fault holds, the counter missed this request (read on a
      // direct connection); it is never reset or read as zero usage.
      expect(await raw.get(quotaKey())).toBe('4');

      await proxy.setMode('normal');
      // A refused increment never reached Redis. A timed-out one is
      // ambiguous: its bytes were held, not dropped, so Redis may still run
      // it once the stall ends (#645 owns late-command behavior). A reply on
      // the same connection means anything sent before it has run.
      await eventually(
        async () => (await meteringClient.get(quotaKey())) !== null,
      );
      expect(mode === 'refuse' ? ['4'] : ['4', '5']).toContain(
        await raw.get(quotaKey()),
      );
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
