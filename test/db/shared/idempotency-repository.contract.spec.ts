import type { Pool } from 'pg';

import { PostgresIdempotencyRepository } from '@/modules/idempotency/infrastructure/postgres-idempotency.repository';
import { idempotencyRepositoryContract } from '@/modules/idempotency/testing/idempotency.contract';
import { prismaFromQueryFake } from '@/modules/persistence/testing/query-fake-client';

import { createTestPool } from './database';

let pool: Pool;

function client() {
  const query = async (text: string, values: readonly unknown[]) => {
    const result = await pool.query<Record<string, unknown>>(text, [...values]);
    return result.rows;
  };
  // Organization-scoped keys run in the Organization seam's transaction (#785).
  return prismaFromQueryFake({
    query,
    transaction: (callback) => callback({ query }),
  });
}

beforeAll(async () => {
  pool = createTestPool();
});

afterAll(async () => {
  await pool.end();
});

idempotencyRepositoryContract(
  () => new PostgresIdempotencyRepository(client()),
  async () => {
    await pool.query('DELETE FROM idempotency_records');
  },
);
