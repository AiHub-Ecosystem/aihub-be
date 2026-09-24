import type { Pool } from 'pg';

import { createPostgresIdempotencyClient } from '../../../src/modules/idempotency/infrastructure/postgres-idempotency.client';
import { PostgresIdempotencyRepository } from '../../../src/modules/idempotency/infrastructure/postgres-idempotency.repository';
import { generateApiKey } from '../../../src/modules/identity/domain/api-key';
import { createPostgresMeteringClient } from '../../../src/modules/metering/infrastructure/postgres-usage.repository';
import { PostgresUsageRepository } from '../../../src/modules/metering/infrastructure/postgres-usage.repository';

import { createTestPool, testDatabaseUrl } from '../database';

import {
  ORGANIZATION_A,
  ORGANIZATION_B,
  SHARED_IDEMPOTENCY_KEY,
  SHARED_OPERATION,
  TEST_NOW,
  type TenantIsolationFixture,
  type TenantIsolationRedisClients,
  createTenantIdentity,
  createTenantIsolationRedisClients,
  resetTenantIsolation,
  seedTenantIsolation,
} from './fixtures';

const FINGERPRINT = 'a'.repeat(64);
const A_RESPONSE = { marker: 'tenant-a-response' };
const B_RESPONSE = { marker: 'tenant-b-response' };

let pool: Pool;
let redisClients: TenantIsolationRedisClients;
let fixture: TenantIsolationFixture;
let idempotency: PostgresIdempotencyRepository;
let usage: PostgresUsageRepository;

function idempotencyInput(organizationId: string, requestId: string) {
  return {
    organizationId,
    operation: SHARED_OPERATION,
    actorScope: fixture.actorId,
    idempotencyKey: SHARED_IDEMPOTENCY_KEY,
    fingerprintHex: FINGERPRINT,
    requestId,
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
  };
}

async function usageRecord(
  organizationId: string,
  requestId: string,
  apiKeyId: string,
  totalTokens: number,
) {
  await usage.insert({
    requestId,
    organizationId,
    apiKeyId,
    actorId: fixture.actorId,
    service: 'writing',
    operation: 'writing.task1.grade',
    environment: 'production',
    outcome: 'success',
    httpStatus: 200,
    billableRequests: 1,
    usage: {
      inputTokens: totalTokens - 1,
      outputTokens: 1,
      totalTokens,
    },
    meteringStatus: 'not_applicable',
    totalMs: 1,
  });
  await pool.query(
    'UPDATE usage_records SET created_at = $2 WHERE request_id = $1',
    [requestId, TEST_NOW],
  );
}

beforeAll(async () => {
  pool = createTestPool();
  redisClients = createTenantIsolationRedisClients();
  idempotency = new PostgresIdempotencyRepository(
    createPostgresIdempotencyClient(testDatabaseUrl()),
  );
  usage = new PostgresUsageRepository(
    createPostgresMeteringClient(testDatabaseUrl()),
  );
});

beforeEach(async () => {
  await resetTenantIsolation(pool, redisClients.raw);
  const identityA = await createTenantIdentity(
    'https://tenant-a.example.test',
    'tenant-a-key',
  );
  const identityB = await createTenantIdentity(
    'https://tenant-b.example.test',
    'tenant-b-key',
  );
  fixture = await seedTenantIsolation(
    pool,
    identityA,
    identityB,
    generateApiKey(TEST_NOW),
    generateApiKey(TEST_NOW),
  );
});

afterAll(async () => {
  await idempotency?.onModuleDestroy();
  await usage?.close();
  await pool?.end();
  await redisClients?.raw.quit();
});

describe('tenant isolation for durable records', () => {
  it('does not replay a foreign Organization response for the same idempotency key', async () => {
    const b = idempotencyInput(ORGANIZATION_B, 'req_tenant_b');
    await expect(idempotency.reserve(b)).resolves.toEqual({
      kind: 'claimed',
      requestId: 'req_tenant_b',
    });
    await idempotency.complete({
      ...b,
      responseStatus: 201,
      responseBody: B_RESPONSE,
    });

    const a = idempotencyInput(ORGANIZATION_A, 'req_tenant_a');
    await expect(idempotency.reserve(a)).resolves.toEqual({
      kind: 'claimed',
      requestId: 'req_tenant_a',
    });
    await idempotency.complete({
      ...a,
      responseStatus: 200,
      responseBody: A_RESPONSE,
    });

    const replay = await idempotency.reserve(
      idempotencyInput(ORGANIZATION_A, 'req_tenant_a_replay'),
    );
    expect(replay).toEqual({
      kind: 'replay',
      responseStatus: 200,
      responseBody: A_RESPONSE,
    });
    expect(JSON.stringify(replay)).not.toContain(B_RESPONSE.marker);
  });

  it('keeps usage aggregates and billable evidence inside the requested Organization', async () => {
    await usageRecord(
      ORGANIZATION_A,
      'req_usage_a',
      fixture.organizationA.apiKey.id,
      11,
    );
    await usageRecord(
      ORGANIZATION_B,
      'req_usage_b',
      fixture.organizationB.apiKey.id,
      22,
    );

    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date('2027-01-01T00:00:00.000Z');
    await expect(
      usage.aggregate({ organizationId: ORGANIZATION_A, from, to }),
    ).resolves.toEqual({
      billableRequestCount: 1,
      billableTokenCount: 11,
      missingUsageCount: 0,
    });
    await expect(
      usage.aggregate({ organizationId: ORGANIZATION_B, from, to }),
    ).resolves.toEqual({
      billableRequestCount: 1,
      billableTokenCount: 22,
      missingUsageCount: 0,
    });
    const foreignUsage = await pool.query<{ request_id: string }>(
      `SELECT request_id
       FROM usage_records
       WHERE organization_id = $1 AND request_id = $2`,
      [ORGANIZATION_A, 'req_usage_b'],
    );
    expect(foreignUsage.rows).toEqual([]);
  });
});
