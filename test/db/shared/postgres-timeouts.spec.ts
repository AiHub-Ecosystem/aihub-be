import type { PoolClient } from 'pg';
import { ulid } from 'ulid';

import { postgresTimeoutKind } from '@/common/postgres/postgres-timeout-error';
import { createPrismaClient } from '@/modules/persistence/infrastructure/prisma-client';
import { CONTROL_PLANE_TRANSACTION_OPTIONS } from '@/modules/persistence/public/prisma-transaction-options';
import { createTestPool, testDatabaseUrl, waitForBlockedBy } from './database';

async function waitForPoolCounts(
  pool: { readonly totalCount: number; readonly idleCount: number },
  total: number,
  idle: number,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pool.totalCount === total && pool.idleCount === idle) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Prisma pool did not return to its expected counts');
}

describe('PostgreSQL request timeouts', () => {
  it('cancels a held-row lock in a control-plane transaction and returns its connection', async () => {
    const observer = createTestPool();
    const holder = createPrismaClient('control-plane', testDatabaseUrl());
    const organizationId = `org_${ulid()}`;
    let blocker: PoolClient | undefined;

    try {
      await observer.query(
        `INSERT INTO organizations
           (id, name, entitlements, rate_limit_rpm, max_concurrent,
            monthly_request_quota, hard_stop_on_quota)
         VALUES ($1, 'Lock timeout fixture', ARRAY['writing'], 60, 5, 100, true)`,
        [organizationId],
      );
      await holder.prisma.$queryRaw`SELECT 1`;
      const prismaPool = holder.pool;
      const expectedTotal = prismaPool.totalCount;
      expect(expectedTotal).toBeGreaterThan(0);
      expect(prismaPool.idleCount).toBe(expectedTotal);

      blocker = await observer.connect();
      await blocker.query('BEGIN');
      const pidResult = await blocker.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      );
      const blockerPid = pidResult.rows[0]?.pid;
      await blocker.query(
        'SELECT id FROM organizations WHERE id = $1 FOR UPDATE',
        [organizationId],
      );

      const startedAt = Date.now();
      const transaction = holder.prisma
        .$transaction(
          (tx) =>
            tx.organization.update({
              where: { id: organizationId },
              data: { name: 'Blocked update' },
            }),
          CONTROL_PLANE_TRANSACTION_OPTIONS,
        )
        .then(
          (value) => ({ kind: 'resolved' as const, value }),
          (error: unknown) => ({ kind: 'rejected' as const, error }),
        );

      await waitForBlockedBy(observer, blockerPid, 3_000);
      const outcome = await transaction;
      const elapsedMs = Date.now() - startedAt;

      expect(outcome.kind).toBe('rejected');
      if (outcome.kind !== 'rejected') {
        throw new Error('row-locked transaction unexpectedly succeeded');
      }
      expect(postgresTimeoutKind(outcome.error)).toBe('lock_timeout');
      expect(elapsedMs).toBeLessThan(3_500);

      await waitForPoolCounts(prismaPool, expectedTotal, expectedTotal);
      expect(prismaPool.totalCount).toBe(expectedTotal);
      expect(prismaPool.idleCount).toBe(expectedTotal);
    } finally {
      if (blocker !== undefined) {
        await blocker.query('ROLLBACK').catch(() => undefined);
        blocker.release();
      }
      await observer
        .query('DELETE FROM organizations WHERE id = $1', [organizationId])
        .catch(() => undefined);
      await holder.close();
      await observer.end();
    }
  });
});
