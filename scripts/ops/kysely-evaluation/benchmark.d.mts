import type { CompiledQuery, Kysely, QueryResult } from 'kysely';
import type { PostgresDialectConfig } from 'kysely/dist/dialect/postgres/postgres-dialect-config.js';
import type { Pool, PoolConfig } from 'pg';

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

export interface DatabaseBenchmarkRow {
  organization_id: string;
  quota: number | null;
  billable_count: bigint;
}

export interface PgModule {
  Pool: new (config: PoolConfig) => Pool;
}

export interface PrismaAdapterModule {
  PrismaPg: new (pool: Pool) => object;
}

export interface PrismaClientModule {
  PrismaClient: new (options: {
    adapter: object;
  }) => {
    $queryRawUnsafe(
      sql: string,
      ...values: unknown[]
    ): Promise<readonly DatabaseBenchmarkRow[]>;
    $disconnect(): Promise<void>;
  };
}

export interface PostgresPoolModule {
  createPostgresPool: (name: string, config: PoolConfig) => Pool;
  postgresPoolOptions: (url: string, max: number) => PoolConfig;
}

export interface DatabaseQueryResult {
  rows: DatabaseBenchmarkRow[];
}
