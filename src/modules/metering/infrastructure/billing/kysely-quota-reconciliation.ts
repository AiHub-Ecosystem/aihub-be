import type { DB } from '@kysely-types/types';
import { type CompiledQuery, Kysely, PostgresDialect, sql } from 'kysely';
import type { Pool } from 'pg';

export interface KyselyQuotaReconciliationRow {
  readonly organization_id: string;
  readonly quota: number | null;
  readonly billable_count: unknown;
}

/**
 * #1018 spike: the quota reconciliation aggregate, expressed through Kysely
 * against types generated from prisma/schema.prisma. Production still uses the
 * Prisma raw-SQL repository; this query exists to compare the two paths.
 */
export function compileKyselyQuotaReconciliation(
  database: Kysely<DB>,
  from: Date,
  to: Date,
): CompiledQuery<KyselyQuotaReconciliationRow> {
  return database
    .selectFrom('organizations as o')
    .leftJoin('usage_records as u', (join) =>
      join
        .onRef('u.organization_id', '=', 'o.id')
        .on('u.created_at', '>=', from)
        .on('u.created_at', '<', to),
    )
    .select([
      'o.id as organization_id',
      'o.monthly_request_quota as quota',
      sql<bigint>`COUNT(*) FILTER (
        WHERE ${sql.ref('u.outcome')} = 'success'
          AND ${sql.ref('u.billable_requests')} = 1
      )::bigint`.as('billable_count'),
    ])
    .where('o.monthly_request_quota', 'is not', null)
    .groupBy(['o.id', 'o.monthly_request_quota'])
    .orderBy('o.id')
    .$castTo<KyselyQuotaReconciliationRow>()
    .compile();
}

export function createKyselyQuotaClient(pool: Pool): Kysely<DB> {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}
