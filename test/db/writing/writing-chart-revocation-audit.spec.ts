import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { runUsagePruneCommand } from '@/cli/usage-prune';
import type { UsageRetentionPort } from '@/modules/metering/application/usage-retention';
import { createFixturePrismaClient } from '@/modules/persistence/infrastructure/prisma-client';
import { calculateWritingChartRevocationAuditCutoff } from '@/modules/writing/application/writing-chart-revocation-audit-retention';
import { PostgresWritingChartRevocationAuditRepository } from '@/modules/writing/infrastructure/postgres-writing-chart-revocation-audit.repository';
import {
  createSandboxTestPool,
  createTestPool,
  sandboxTestDatabaseUrl,
  testDatabaseUrl,
} from '../shared/database';

const ACTIVE_AT = new Date('2026-10-01T00:00:00.000Z');

const emptyUsageRepository: UsageRetentionPort = {
  pruneBatch: async () => ({ deleted: 0 }),
  pruneDispatchAttempts: async () => 0,
};

let productionPool: Pool;
let sandboxPool: Pool;

beforeAll(() => {
  productionPool = createTestPool();
  sandboxPool = createSandboxTestPool();
});

afterAll(async () => {
  await productionPool.end();
  await sandboxPool.end();
});

async function insertOperator(pool: Pool, id: string): Promise<string> {
  const username = `op${id.slice(-10)}`;
  await pool.query(
    `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
     VALUES ($1, $2, 'active', $3, $3)`,
    [id, username, ACTIVE_AT],
  );
  return username;
}

function createRepository(databaseUrl: string) {
  const client = createFixturePrismaClient(databaseUrl);
  let closed = false;
  return Object.assign(
    new PostgresWritingChartRevocationAuditRepository(client),
    {
      close: async () => {
        if (!closed) {
          closed = true;
          await client.close();
        }
      },
    },
  );
}

describe('Writing chart revocation audit in the managed usage:prune job', () => {
  it('keeps Production and Sandbox audit rows isolated, immutable, and only prunes rows older than 24 months', async () => {
    const now = new Date();
    const cutoff = calculateWritingChartRevocationAuditCutoff(now);
    const operatorId = `usr_${ulid()}`;
    const oldAssetId = `chart_${ulid()}`;
    const boundaryAssetId = `chart_${ulid()}`;
    const recentAssetId = `chart_${ulid()}`;
    const operatorUsername = await insertOperator(productionPool, operatorId);
    await insertOperator(sandboxPool, operatorId);

    const production = createRepository(testDatabaseUrl());
    const sandbox = createRepository(sandboxTestDatabaseUrl());
    try {
      const actorId =
        await production.findActiveOperatorAccount(operatorUsername);
      expect(actorId).toBe(operatorId);

      for (const repository of [production, sandbox]) {
        for (const scenario of [
          {
            assetId: oldAssetId,
            occurredAt: new Date(cutoff.getTime() - 1_000),
            originOutcome: 'deleted' as const,
            edgeOutcome: 'not_serving' as const,
            edgeStatus: 404,
          },
          {
            assetId: boundaryAssetId,
            occurredAt: cutoff,
            originOutcome: 'already_absent' as const,
            edgeOutcome: 'not_serving' as const,
            edgeStatus: 404,
          },
          {
            assetId: recentAssetId,
            occurredAt: new Date(cutoff.getTime() + 1_000),
            originOutcome: 'deleted' as const,
            edgeOutcome: 'serving' as const,
            edgeStatus: 200,
          },
        ]) {
          const base = {
            assetId: scenario.assetId,
            actorUserAccountId: operatorId,
          };
          await repository.append({
            ...base,
            occurredAt: scenario.occurredAt,
            phase: 'requested',
            originOutcome: null,
            edgeOutcome: null,
            edgeStatus: null,
          });
          await repository.append({
            ...base,
            occurredAt: scenario.occurredAt,
            phase: 'completed',
            originOutcome: scenario.originOutcome,
            edgeOutcome: scenario.edgeOutcome,
            edgeStatus: scenario.edgeStatus,
          });
        }
      }

      const recentPhases = await productionPool.query<{ phase: string }>(
        `SELECT phase FROM writing_chart_revocation_audits
         WHERE asset_id = $1 ORDER BY phase`,
        [recentAssetId],
      );
      expect(recentPhases.rows.map(({ phase }) => phase)).toEqual([
        'completed',
        'requested',
      ]);

      const recentId = await productionPool.query<{ id: string }>(
        `SELECT id FROM writing_chart_revocation_audits
         WHERE asset_id = $1 AND phase = 'completed'`,
        [recentAssetId],
      );
      await expect(
        productionPool.query(
          `UPDATE writing_chart_revocation_audits
           SET edge_outcome = 'not_serving' WHERE id = $1`,
          [recentId.rows[0]?.id],
        ),
      ).rejects.toThrow('append-only');
      await expect(
        productionPool.query(
          'DELETE FROM writing_chart_revocation_audits WHERE id = $1',
          [recentId.rows[0]?.id],
        ),
      ).rejects.toThrow('retention period');

      await runUsagePruneCommand({
        databaseUrl: testDatabaseUrl(),
        repository: emptyUsageRepository,
        writingChartAuditRepository: production,
        now,
      });

      await expect(
        productionPool.query(
          'SELECT id FROM writing_chart_revocation_audits WHERE asset_id = $1',
          [oldAssetId],
        ),
      ).resolves.toMatchObject({ rowCount: 0 });
      await expect(
        productionPool.query(
          'SELECT id FROM writing_chart_revocation_audits WHERE asset_id = ANY($1::text[]) ORDER BY asset_id',
          [[boundaryAssetId, recentAssetId]],
        ),
      ).resolves.toMatchObject({ rowCount: 4 });
      await expect(
        sandboxPool.query(
          'SELECT id FROM writing_chart_revocation_audits WHERE asset_id = $1',
          [oldAssetId],
        ),
      ).resolves.toMatchObject({ rowCount: 2 });

      await runUsagePruneCommand({
        databaseUrl: sandboxTestDatabaseUrl(),
        repository: emptyUsageRepository,
        writingChartAuditRepository: sandbox,
        now,
      });
      await expect(
        sandboxPool.query(
          'SELECT id FROM writing_chart_revocation_audits WHERE asset_id = $1',
          [oldAssetId],
        ),
      ).resolves.toMatchObject({ rowCount: 0 });
    } finally {
      await production.close();
      await sandbox.close();
    }
  });
});
