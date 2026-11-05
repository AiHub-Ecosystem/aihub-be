import type { CompiledQuery, Kysely, QueryResult } from 'kysely';
import type { PostgresDialectConfig } from 'kysely/dist/dialect/postgres/postgres-dialect-config.js';

export interface BenchmarkRow {
  organization_id: string;
  quota: number;
  billable_count: bigint;
}

export interface KyselyBenchmarkModule {
  compileKyselyQuotaReconciliation: (
    database: Kysely<never>,
    from: Date,
    to: Date,
  ) => CompiledQuery<BenchmarkRow>;
  createKyselyQuotaClient: (
    pool: PostgresDialectConfig['pool'],
  ) => Kysely<never>;
}

export interface PrismaBenchmarkModule {
  QUOTA_RECONCILIATION_SQL: string;
}

export interface StubPool {
  connect(): Promise<{
    getTransactionStatus(): string | null;
    query(): Promise<QueryResult<BenchmarkRow>>;
    release(): void;
  }>;
  query(
    text: string,
    values: readonly unknown[],
  ): Promise<QueryResult<BenchmarkRow>>;
  end(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}
