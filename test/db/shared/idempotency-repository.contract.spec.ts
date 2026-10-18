import type { Pool } from 'pg';

import { PostgresIdempotencyRepository } from '@/modules/idempotency/infrastructure/postgres-idempotency.repository';
import { idempotencyRepositoryContract } from '@/modules/idempotency/testing/idempotency.contract';
import { prismaFromQueryFake } from '@/modules/persistence/testing/query-fake-client';

import { createTestPool } from './database';

let pool: Pool;

function client() {
  return prismaFromQueryFake({
    async query(text, values) {
      const result = await pool.query<Record<string, unknown>>(text, [
        ...values,
      ]);
      return result.rows;
    },
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
