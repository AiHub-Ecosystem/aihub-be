import { createPostgresPool } from '@/common/postgres/postgres-pool';
import type { CompiledQuery } from 'kysely';
import type { Pool } from 'pg';
import {
  compileKyselyQuotaReconciliation,
  createKyselyQuotaClient,
} from './kysely-quota-reconciliation';
import { QUOTA_RECONCILIATION_SQL } from './postgres-quota-reconciliation.repository';

describe('Kysely quota reconciliation spike', () => {
  it('compiles the same tables, filters, and bound dates as the Prisma raw SQL', () => {
    const database = createKyselyQuotaClient({} as Pool);
    const from = new Date('2026-09-01T00:00:00.000Z');
    const to = new Date('2026-10-01T00:00:00.000Z');
    const compiled: CompiledQuery<unknown> = compileKyselyQuotaReconciliation(
      database,
      from,
      to,
    );
    const sql = compiled.sql;

    expect(compiled.parameters).toEqual([from, to]);
    for (const fragment of [
      '"organizations" as "o"',
      '"usage_records" as "u"',
      '"u"."organization_id" = "o"."id"',
      '"u"."created_at" >= $1',
      '"u"."created_at" < $2',
      '"o"."monthly_request_quota" is not null',
      '"u"."outcome" = \'success\'',
      '"u"."billable_requests" = 1',
      '"o"."id"',
      '"o"."monthly_request_quota"',
    ]) {
      expect(sql).toContain(fragment);
    }
    expect(QUOTA_RECONCILIATION_SQL).toContain('FROM organizations AS o');
    expect(QUOTA_RECONCILIATION_SQL).toContain('LEFT JOIN usage_records AS u');
  });

  it('executes the compiled query through createPostgresPool', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [],
      command: 'SELECT',
      rowCount: 0,
    });
    const release = jest.fn();
    const pool = createPostgresPool('integration-test', { max: 1 });
    jest.spyOn(pool, 'connect').mockResolvedValue({
      query,
      release,
      getTransactionStatus: () => 'I',
    } as never);
    const database = createKyselyQuotaClient(pool);

    try {
      const result = await database.executeQuery(
        compileKyselyQuotaReconciliation(
          database,
          new Date('2026-09-01T00:00:00.000Z'),
          new Date('2026-10-01T00:00:00.000Z'),
        ),
      );
      expect(result.rows).toEqual([]);
      expect(query).toHaveBeenCalledWith(expect.any(String), [
        new Date('2026-09-01T00:00:00.000Z'),
        new Date('2026-10-01T00:00:00.000Z'),
      ]);
    } finally {
      await database.destroy();
      jest.restoreAllMocks();
    }
  });
});
