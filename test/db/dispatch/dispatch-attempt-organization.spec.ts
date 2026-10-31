import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { PostgresDispatchAttemptRepository } from '@/modules/metering/infrastructure/postgres-dispatch-attempt.repository';
import { createPostgresMeteringClient } from '@/modules/metering/infrastructure/postgres-usage.repository';

import { createTestPool, testDatabaseUrl } from '../shared/database';

const ORGANIZATION_A = 'org_dispatch_a';
const ORGANIZATION_B = 'org_dispatch_b';

let pool: Pool;
let repository: PostgresDispatchAttemptRepository;

beforeAll(() => {
  pool = createTestPool();
  repository = new PostgresDispatchAttemptRepository(
    createPostgresMeteringClient(testDatabaseUrl()),
  );
});

afterAll(async () => {
  await repository.close();
  await pool.end();
});

describe('dispatch attempt identity against PostgreSQL', () => {
  it('stores Organization identity without an End-User field', async () => {
    const attemptIds: string[] = [];
    try {
      for (const organizationId of [ORGANIZATION_A, ORGANIZATION_B]) {
        attemptIds.push(
          await repository.beginAttempt({
            requestId: `req_dispatch_${ulid()}`,
            organizationId,
            operation: 'writing.task1.grade',
            operationTimeoutMs: 60_000,
          }),
        );
      }

      const { rows } = await pool.query<{
        attempt_id: string;
        stored: Record<string, unknown>;
      }>(
        `SELECT attempt_id, row_to_json(attempt) AS stored
         FROM dispatch_attempts AS attempt
         WHERE attempt_id = ANY($1::uuid[])
         ORDER BY organization_id`,
        [attemptIds],
      );

      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.stored.organization_id)).toEqual([
        ORGANIZATION_A,
        ORGANIZATION_B,
      ]);
      for (const row of rows) {
        expect(row.stored).not.toHaveProperty('actor_id');
        expect(row.stored).not.toHaveProperty('end_user_id');
      }
    } finally {
      if (attemptIds.length > 0) {
        await pool.query(
          'DELETE FROM dispatch_attempts WHERE attempt_id = ANY($1::uuid[])',
          [attemptIds],
        );
      }
    }
  });
});
