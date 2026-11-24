import { randomUUID } from 'node:crypto';

import {
  QUERY_TIMEOUT_MARGIN_MS,
  REQUEST_POSTGRES_TIMEOUTS,
} from '@/common/postgres/postgres-pool';

import {
  METERING_WRITE_TIMEOUT_MS,
  MeteringService,
} from '@/modules/metering/application/usage-recording/metering.service';
import { PostgresUsageRepository } from '@/modules/metering/infrastructure/usage-recording/postgres-usage.repository';
import { PrometheusMeteringTelemetryAdapter } from '@/modules/metering/infrastructure/usage-recording/prometheus-metering-telemetry.adapter';
import {
  type PrismaClientHolder,
  createPrismaClient,
} from '@/modules/persistence/persistence.module';
import { PostgresSpeakingV2ResultOwnershipRepository } from '@/modules/speaking/infrastructure/postgres-speaking-v2-result-ownership.repository';

import { createTestPool } from '../../shared/database';
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
  metricValue,
  postgresThroughProxy,
  rejection,
  resetAndSeedTenants,
  timed,
} from './fault-targets';

// Two PostgreSQL writes that follow a successful grading, from the #2019
// matrix. The metering write is best-effort: the client keeps its result. The
// Speaking result-ownership write is durable: it fails the request closed.
const WRITE_SLACK_MS = 400;
// A hung write is given up by the client query timeout: statement_timeout
// plus its margin, 5 s.
const OWNERSHIP_BOUND_MS =
  REQUEST_POSTGRES_TIMEOUTS.statement_timeout + QUERY_TIMEOUT_MARGIN_MS + 1_000;
const NOOP_LOGGER = { writeFailed: () => undefined };

let pool: ReturnType<typeof createTestPool>;
let raw: ReturnType<typeof createTenantIsolationRedis>;
let proxy: TcpFaultProxy;
let holder: PrismaClientHolder;
let metering: MeteringService;
let fixture: TenantIsolationFixture;

async function writeFailures(): Promise<number> {
  return (
    (await metricValue('aihub_metering_write_failed_total', {
      reason: 'timeout',
    })) +
    (await metricValue('aihub_metering_write_failed_total', {
      reason: 'error',
    }))
  );
}

/** One successful grading, finalized as the route does. */
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
    modelCalled: true,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  });
  return requestId;
}

async function usageRows(requestId: string): Promise<number> {
  const { rowCount } = await pool.query(
    'SELECT 1 FROM usage_records WHERE request_id = $1',
    [requestId],
  );
  return rowCount ?? 0;
}

beforeAll(async () => {
  pool = createTestPool();
  raw = createTenantIsolationRedis();
  const target = await postgresThroughProxy();
  proxy = target.proxy;
  holder = createPrismaClient('integration-test', target.url);
  metering = new MeteringService(
    new PostgresUsageRepository(holder.prisma),
    NOOP_LOGGER,
    undefined,
    undefined,
    new PrometheusMeteringTelemetryAdapter(),
  );
});

beforeEach(async () => {
  fixture = await resetAndSeedTenants(pool, raw);
  // A connected pool, so the failure comes from the fault.
  await eventually(
    async () => (await usageRows(await finalizeSuccess())) === 1,
    10_000,
  );
});

afterEach(async () => {
  await proxy.setMode('normal');
});

afterAll(async () => {
  await holder.close();
  await proxy.close();
  await raw.quit();
  await pool.end();
});

describe('metering write after a successful grading while PostgreSQL fails', () => {
  it.each<FaultMode>(['refuse', 'hang'])(
    'keeps the successful result inside the write bound and counts the lost write when PostgreSQL is %s',
    async (mode) => {
      const before = await writeFailures();

      await proxy.setMode(mode);
      const call = await timed(finalizeSuccess);

      // finalize never throws, so the client's graded result stands.
      expect(call.result.status).toBe('fulfilled');
      expect(call.ms).toBeLessThan(METERING_WRITE_TIMEOUT_MS + WRITE_SLACK_MS);
      await eventually(async () => (await writeFailures()) === before + 1);
      const requestId =
        call.result.status === 'fulfilled' ? call.result.value : '';
      expect(await usageRows(requestId)).toBe(0);
    },
  );

  it('records usage again once PostgreSQL returns', async () => {
    await proxy.setMode('refuse');
    const lost = await finalizeSuccess();

    await proxy.setMode('normal');
    let recorded = '';
    await eventually(async () => {
      recorded = await finalizeSuccess();
      return (await usageRows(recorded)) === 1;
    }, 10_000);
    expect(await usageRows(recorded)).toBe(1);
    // Nothing replays the lost write.
    expect(await usageRows(lost)).toBe(0);
  });
});

describe('Speaking result-ownership write while PostgreSQL fails', () => {
  function owner() {
    return {
      organizationId: ORGANIZATION_A,
      environment: 'production',
      endUserId: `user_${randomUUID()}`,
    };
  }

  it.each<FaultMode>(['refuse', 'hang'])(
    'fails the write as a retryable 503 DATABASE_UNAVAILABLE and records nothing when PostgreSQL is %s',
    async (mode) => {
      const ownership = new PostgresSpeakingV2ResultOwnershipRepository(
        holder.prisma,
      );
      const caller = owner();

      await proxy.setMode(mode);
      const call = await timed(() =>
        ownership.record(caller, 'response', `resp_${randomUUID()}`),
      );

      // The Speaking routes and the job processor turn this into a closed
      // failure without finalizing metering (speaking-v2.controller.spec.ts,
      // process-speaking-grading-job.spec.ts).
      expect(rejection(call.result)).toMatchObject({
        code: 'DATABASE_UNAVAILABLE',
        httpStatus: 503,
        retryable: true,
      });
      expect(call.ms).toBeLessThan(OWNERSHIP_BOUND_MS);
      await proxy.setMode('normal');
      const { rowCount } = await pool.query(
        'SELECT 1 FROM speaking_v2_result_ownership WHERE end_user_id = $1',
        [caller.endUserId],
      );
      expect(rowCount).toBe(0);
    },
    30_000,
  );
});
